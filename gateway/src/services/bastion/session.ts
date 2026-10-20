import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Client } from 'ssh2';
import type { WebSocket } from 'ws';
import { config } from '../../config/env.js';
import { query } from '../db.js';
import { normalizeClientIp } from '../../utils/client-ip.js';
import { verifyAndConsumeTicket } from './tickets.js';
import {
  activeSessions, type ActiveSession, GATEWAY_INSTANCE_ID,
  MAX_GLOBAL_SESSIONS, MAX_SESSIONS_PER_NODE, MAX_SESSIONS_PER_USER,
} from './registry.js';

export function clampPtyDimensions(rawRows: any, rawCols: any): { rows: number; cols: number } {
  const parsedRows = Math.floor(Number(rawRows)) || 24;
  const parsedCols = Math.floor(Number(rawCols)) || 80;

  const rows = Math.min(200, Math.max(10, parsedRows));
  const cols = Math.min(500, Math.max(20, parsedCols));

  return { rows, cols };
}

export async function attachBastionSession(
  socket: WebSocket,
  nodeIdentifier: string,
  initialTicket: string,
  clientIp?: string,
): Promise<void> {
  const auditClientIp = normalizeClientIp(clientIp);
  const sessionId = crypto.randomUUID();
  let sessionState: 'INIT' | 'PROBING' | 'CONNECTING' | 'READY' | 'CLOSING' | 'CLOSED' = 'INIT';
  let isCancelled = false;
  let isInputPaused = false;

  let probeSocket: net.Socket | null = null;
  let sshClient: Client | null = null;
  let sshStream: any = null;

  const inputQueue: Buffer[] = [];
  let totalBufferedInputBytes = 0;
  const MAX_TOTAL_BUFFERED_INPUT = 65536; // Trần cứng 64KB cho toàn bộ hàng đợi đệm
  let inputPauseTimer: NodeJS.Timeout | null = null;

  // START may still be pending when a disconnect requires END.
  let currentUserId = '';
  let isAuditStarting = false;
  let isAuditStarted = false;
  let pendingEndAuditAfterStart = false;
  let closeReasonForEndAudit = 'Session Closed';

  const runCleanup = (closeCode = 1000, reason = 'Session Closed', userMsg?: string) => {
    if (sessionState === 'CLOSED') return;
    sessionState = 'CLOSED';
    isCancelled = true;

    if (inputPauseTimer) {
      clearTimeout(inputPauseTimer);
      inputPauseTimer = null;
    }
    inputQueue.length = 0;
    totalBufferedInputBytes = 0;

    const existingSession = activeSessions.get(sessionId);
    activeSessions.delete(sessionId);

    if (existingSession?.hardExpiryTimer) {
      clearTimeout(existingSession.hardExpiryTimer);
      existingSession.hardExpiryTimer = null;
    }

    if (existingSession?.outputDrainInterval) {
      clearInterval(existingSession.outputDrainInterval);
      existingSession.outputDrainInterval = null;
    }

    // Retain the handles so forced teardown still works after the local fields are cleared.
    const probeToClean = probeSocket;
    const streamToClean = sshStream;
    const clientToClean = sshClient;
    const wsToClean = socket;

    if (probeSocket) {
      try { probeSocket.destroy(); } catch {}
      probeSocket = null;
    }

    if (sshStream) {
      try {
        if (typeof sshStream.destroy === 'function') sshStream.destroy();
        else if (typeof sshStream.end === 'function') sshStream.end();
      } catch {}
      sshStream = null;
    }

    if (sshClient) {
      try { sshClient.end(); } catch {}
      sshClient = null;
    }

    // Force lingering resources closed after the existing three-second grace period.
    const forcedTimer = setTimeout(() => {
      try { if (probeToClean && typeof (probeToClean as any).destroy === 'function') (probeToClean as any).destroy(); } catch {}
      try { if (streamToClean && typeof (streamToClean as any).destroy === 'function') (streamToClean as any).destroy(); } catch {}
      try { if (clientToClean && typeof (clientToClean as any).destroy === 'function') (clientToClean as any).destroy(); } catch {}
      try {
        if (wsToClean && wsToClean.readyState !== 3 /* CLOSED */) {
          if (typeof (wsToClean as any).terminate === 'function') (wsToClean as any).terminate();
          else if (typeof (wsToClean as any).close === 'function') (wsToClean as any).close(1011, 'Forced Timeout');
        }
      } catch {}
    }, 3000);
    forcedTimer.unref();

    // Mark the lease closed so reconciliation does not mistake teardown for an orphan.
    query(
      `UPDATE bastion_session_leases
       SET status = 'CLOSED', closed_at = (NOW() AT TIME ZONE 'UTC'), close_reason = $2
       WHERE session_id = $1::uuid AND status = 'ACTIVE';`,
      [sessionId, reason || 'Normal Closure']
    ).catch((leaseCloseErr) => {
      console.warn('⚠️ [BASTION LEASE CLOSE ERROR]:', leaseCloseErr.message);
    });

    // A completed START requires exactly one END, even if the socket has already closed.
    const auditUserId = existingSession?.userId || currentUserId;
    if (isAuditStarted || existingSession?.isAuditStarted) {
      isAuditStarted = false;
      if (existingSession) existingSession.isAuditStarted = false;
      query(
        `INSERT INTO audit_logs (user_id, action, target, details, ip_address)
         VALUES ($1, 'BASTION_SESSION_END', 'bastion', $2, $3::inet);`,
        [auditUserId, JSON.stringify({ session_id: sessionId, node_id: nodeIdentifier, reason }), auditClientIp]
      ).catch((err) => {
        console.warn('⚠️ [BASTION AUDIT END ERROR] Lỗi ghi audit log khi kết thúc phiên:', err.message);
      });
    } else if (isAuditStarting) {
      // Defer END until the pending START commits.
      pendingEndAuditAfterStart = true;
      closeReasonForEndAudit = reason;
    }

    if (socket.readyState === 1 || socket.readyState === 0) {
      if (userMsg && socket.readyState === 1) {
        try { socket.send(JSON.stringify({ type: 'ERROR', message: userMsg })); } catch {}
      }
      try {
        // Chuẩn hóa closeCode: Nếu là 1006 (RFC 6455 cấm) chuyển thành 1011
        const safeCloseCode = closeCode === 1006 ? 1011 : closeCode;
        socket.close(safeCloseCode, reason);
      } catch {}
    }
  };

  // Register disconnect handlers before any await or resource acquisition.
  socket.on('close', () => {
    runCleanup(1000, 'Client Closed');
  });

  socket.on('error', (err) => {
    console.warn(`⚠️ [BASTION WS ERROR ${sessionId}]:`, err.message);
    runCleanup(1011, 'Socket Error');
  });

  // Reserve quota synchronously before the first database await.
  if (activeSessions.size >= MAX_GLOBAL_SESSIONS) {
    runCleanup(4429, 'Session Quota Exceeded', 'Hệ thống đã đạt giới hạn số phiên kết nối đồng thời');
    return;
  }

  const authResult = verifyAndConsumeTicket(initialTicket, nodeIdentifier);
  if (!authResult.valid || !authResult.ticketData) {
    runCleanup(4401, 'Unauthorized Ticket', 'Mã vé truy cập Web SSH không hợp lệ hoặc đã hết hạn');
    return;
  }

  const { userId, sessionVersion, authExpiresAt } = authResult.ticketData;
  currentUserId = userId;

  const userOpenSessions = Array.from(activeSessions.values()).filter(s => s.userId === userId).length;
  if (userOpenSessions >= MAX_SESSIONS_PER_USER) {
    runCleanup(4429, 'User Quota Exceeded', 'Tài khoản đã mở quá số phiên SSH cho phép (tối đa 5 phiên)');
    return;
  }

  const timeUntilJwtExpires = Math.max(0, authExpiresAt - Date.now());
  const hardExpiryTimer = setTimeout(() => {
    console.warn(`⏰ [BASTION JWT EXPIRED] Phiên ${sessionId} đã đạt giới hạn thời gian sống của JWT (${authExpiresAt})`);
    runCleanup(4401, 'Token Expired', 'Mã xác thực JWT đã hết hạn');
  }, timeUntilJwtExpires);
  hardExpiryTimer.unref();

  // Pending authentication must already count toward the shared quotas.
  const sessionRecord: ActiveSession = {
    sessionId,
    userId,
    sessionVersion,
    nodeId: nodeIdentifier,
    nodeName: nodeIdentifier,
    state: 'INIT',
    socket,
    sshClient: null,
    sshStream: null,
    createdAt: Date.now(),
    authExpiresAt,
    lastLeaseRenewNs: process.hrtime.bigint(), // Monotonic clock
    lastActivityTime: Date.now(),
    isAuditStarted: false,
    hardExpiryTimer,
    outputDrainInterval: null,
    cleanupFn: runCleanup,
  };
  activeSessions.set(sessionId, sessionRecord);

  let dbUser: any;
  try {
    const userRes = await query(
      'SELECT id, username, role, is_active, session_version FROM users WHERE id = $1 LIMIT 1;',
      [userId]
    );

    if (userRes.rows.length === 0 || !userRes.rows[0].is_active) {
      runCleanup(4403, 'Account Disabled', 'Tài khoản đã bị khóa hoặc không còn tồn tại trên hệ thống');
      return;
    }

    dbUser = userRes.rows[0];

    if (dbUser.role !== 'ADMIN') {
      runCleanup(4403, 'Forbidden Role', 'Tài khoản không đủ quyền hạn quản trị để mở Web SSH');
      return;
    }

    if (Number(dbUser.session_version) !== Number(sessionVersion)) {
      runCleanup(4401, 'Session Revoked', 'Phiên làm việc của vé đã bị thu hồi hoặc đăng xuất');
      return;
    }
  } catch (dbErr: any) {
    console.error('❌ [BASTION AUTH DB ERROR]:', dbErr.message);
    runCleanup(4503, 'Database Unavailable', 'Không thể xác thực quyền truy cập do sự cố CSDL');
    return;
  }

  if (isCancelled) {
    runCleanup();
    return;
  }

  let targetIp = '';
  let nodeName = nodeIdentifier;
  let targetNodeId = nodeIdentifier;
  let expectedFingerprint = '';
  let sshUsername = config.BASTION_DEFAULT_USER;

  try {
    const nodeRes = await query(
      'SELECT id, name, ip_address, host_key_fingerprint, ssh_username FROM nodes WHERE (id::text = $1 OR name = $1) LIMIT 1;',
      [nodeIdentifier]
    );

    if (nodeRes.rows.length === 0) {
      runCleanup(4404, 'Node Not Found', 'Không tìm thấy thông tin máy chủ con');
      return;
    }

    targetNodeId = nodeRes.rows[0].id;
    targetIp = nodeRes.rows[0].ip_address;
    nodeName = nodeRes.rows[0].name;
    expectedFingerprint = (nodeRes.rows[0].host_key_fingerprint || '').trim();
    sshUsername = nodeRes.rows[0].ssh_username ?? config.BASTION_DEFAULT_USER;

    sessionRecord.nodeId = targetNodeId;
    sessionRecord.nodeName = nodeName;
  } catch (nodeDbErr: any) {
    console.error('❌ [BASTION NODE DB ERROR]:', nodeDbErr.message);
    runCleanup(4500, 'Database Error', 'Lỗi truy vấn thông tin máy chủ con');
    return;
  }

  if (isCancelled) {
    runCleanup();
    return;
  }

  const nodeOpenSessions = Array.from(activeSessions.values()).filter(
    s => s.nodeId === targetNodeId || s.nodeId === nodeIdentifier
  ).length;

  if (nodeOpenSessions > MAX_SESSIONS_PER_NODE) {
    runCleanup(4429, 'Node Quota Exceeded', `Máy chủ ${nodeName} đã đạt giới hạn tối đa ${MAX_SESSIONS_PER_NODE} phiên SSH đồng thời`);
    return;
  }

  // Opening a shell requires a committed START audit; failures close the session.
  isAuditStarting = true;
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, target, details, ip_address)
       VALUES ($1, 'BASTION_SESSION_START', 'bastion', $2, $3::inet);`,
      [dbUser.id, JSON.stringify({ session_id: sessionId, node_id: nodeIdentifier, target_ip: targetIp, ssh_username: sshUsername }), auditClientIp]
    );
    isAuditStarted = true;
    sessionRecord.isAuditStarted = true;

    // The reconciler uses this lease to recover END after a Gateway crash.
    await query(
      `INSERT INTO bastion_session_leases (session_id, user_id, node_id, instance_id, lease_expires_at, status)
       VALUES ($1, $2, $3, $4, (NOW() AT TIME ZONE 'UTC') + INTERVAL '10 seconds', 'ACTIVE')
       ON CONFLICT (session_id) DO UPDATE
       SET lease_expires_at = (NOW() AT TIME ZONE 'UTC') + INTERVAL '10 seconds', status = 'ACTIVE';`,
      [sessionId, dbUser.id, targetNodeId, GATEWAY_INSTANCE_ID]
    ).catch((leaseInitErr) => {
      console.warn('⚠️ [BASTION LEASE INIT ERROR]:', leaseInitErr.message);
    });
  } catch (auditErr: any) {
    console.error('❌ [BASTION AUDIT FAILURE] Không thể ghi audit log mở phiên, Fail-Closed:', auditErr.message);
    runCleanup(4503, 'Audit Failure', 'Không thể mở phiên do không thể ghi nhận vết kiểm toán an toàn');
    return;
  } finally {
    isAuditStarting = false;
    // Disconnect during START is finalized only after that START commits.
    if (pendingEndAuditAfterStart && isAuditStarted) {
      pendingEndAuditAfterStart = false;
      query(
        `INSERT INTO audit_logs (user_id, action, target, details, ip_address)
         VALUES ($1, 'BASTION_SESSION_END', 'bastion', $2, $3::inet);`,
        [dbUser.id, JSON.stringify({ session_id: sessionId, node_id: nodeIdentifier, reason: closeReasonForEndAudit }), auditClientIp]
      ).catch((err) => {
        console.warn('⚠️ [BASTION AUDIT END ERROR] Lỗi ghi audit log khi kết thúc phiên (late resolve):', err.message);
      });
    }
  }

  if (isCancelled) {
    runCleanup();
    return;
  }

  let privateKeyContent: Buffer;
  try {
    privateKeyContent = fs.readFileSync(config.BASTION_SSH_KEY_PATH);
  } catch (fsErr: any) {
    console.error('❌ [BASTION ERROR] Không thể đọc khóa riêng SSH:', fsErr.message);
    runCleanup(4500, 'SSH Key Missing', 'Lỗi cấu hình khóa xác thực Bastion Gateway');
    return;
  }

  sessionState = 'PROBING';
  sessionRecord.state = 'PROBING';
  probeSocket = new net.Socket();
  let probeDone = false;

  const handleProbeFailure = () => {
    if (probeDone || sessionState === 'CLOSED' || isCancelled) return;
    probeDone = true;
    runCleanup(4502, 'SSH Connection Interrupted', 'Không thể kết nối SSH tới máy chủ đích qua mạng ngầm (Cổng 22 không phản hồi)');
  };

  probeSocket.setTimeout(400);
  probeSocket.on('timeout', handleProbeFailure);
  probeSocket.on('error', handleProbeFailure);

  probeSocket.on('connect', () => {
    if (probeDone || sessionState === 'CLOSED' || isCancelled) {
      if (probeSocket) { try { probeSocket.destroy(); } catch {} probeSocket = null; }
      return;
    }
    probeDone = true;
    if (probeSocket) { try { probeSocket.destroy(); } catch {} probeSocket = null; }

    sessionState = 'CONNECTING';
    sessionRecord.state = 'CONNECTING';
    sshClient = new Client();
    sessionRecord.sshClient = sshClient;

    sshClient.on('error', (err) => {
      console.warn(`⚠️ [BASTION SSH ERROR ${sessionId}] Kết nối SSH tới ${targetIp} thất bại:`, err.message);
      // Do not expose internal ssh2 failure details to the client.
      runCleanup(4502, 'SSH Connection Interrupted', 'Mất kết nối SSH với máy chủ đích (Xác thực hoặc giao thức SSH thất bại)');
    });

    sshClient.on('ready', () => {
      // A resource arriving after cleanup must never reopen the session.
      if (sessionState === 'CLOSED' || isCancelled || !sshClient) {
        if (sshClient) { try { sshClient.end(); } catch {} sshClient = null; }
        return;
      }

      const client = sshClient;
      sessionState = 'READY';
      sessionRecord.state = 'READY';

      client.shell(
        {
          term: 'xterm-256color',
          rows: 24,
          cols: 80,
        },
        (shellErr, stream) => {
          if (shellErr) {
            console.error('❌ [BASTION SHELL ERROR]:', shellErr.message);
            runCleanup(4502, 'Shell Error', 'Không thể khởi tạo PTY Shell');
            return;
          }

          if (sessionState === 'CLOSED' || isCancelled) {
            try { stream.end(); } catch {}
            try { client.end(); } catch {}
            return;
          }

          sshStream = stream;
          sessionRecord.sshStream = stream;

          if (socket.readyState === 1) {
            socket.send(JSON.stringify({
              type: 'READY',
              message: `Đã kết nối thành công tới ${nodeName} (${targetIp})`,
              ssh_username: sshUsername,
            }));
          }

          const outputDecoder = new StringDecoder('utf8');
          let outputEnded = false;
          const sendOutput = (data: string) => {
            if (!data || sessionState === 'CLOSED' || isCancelled) return;
            if (socket.readyState === 1) {
              try {
                // Shell text must never impersonate Gateway READY/ERROR frames.
                socket.send(JSON.stringify({ type: 'DATA', data }));
                if ((socket as any).bufferedAmount > 65536) {
                  if (typeof stream.pause === 'function') stream.pause();

                  // Keep one owned timer so disconnect cleanup can always clear it.
                  if (!sessionRecord.outputDrainInterval) {
                    sessionRecord.outputDrainInterval = setInterval(() => {
                      if (sessionState === 'CLOSED' || isCancelled) {
                        if (sessionRecord.outputDrainInterval) {
                          clearInterval(sessionRecord.outputDrainInterval);
                          sessionRecord.outputDrainInterval = null;
                        }
                        return;
                      }

                      if ((socket as any).bufferedAmount < 16384) {
                        if (sessionRecord.outputDrainInterval) {
                          clearInterval(sessionRecord.outputDrainInterval);
                          sessionRecord.outputDrainInterval = null;
                        }
                        if (sessionState === 'READY' && typeof stream.resume === 'function') {
                          stream.resume();
                        }
                      }
                    }, 40);
                    sessionRecord.outputDrainInterval.unref();
                  }
                }
              } catch (sendErr) {
                runCleanup(1011, 'Send Error');
              }
            }
          };

          const finishOutput = () => {
            if (outputEnded) return;
            outputEnded = true;
            sendOutput(outputDecoder.end());
          };

          stream.on('data', (chunk: Buffer) => {
            if (outputEnded || sessionState === 'CLOSED' || isCancelled) return;
            sessionRecord.lastActivityTime = Date.now();
            sendOutput(outputDecoder.write(chunk));
          });
          stream.once('end', finishOutput);

          stream.on('error', (streamErr: any) => {
            console.warn('⚠️ [BASTION STREAM ERROR]:', streamErr.message);
            runCleanup(4502, 'Stream Error', 'Mất kết nối SSH với máy chủ đích');
          });

          stream.on('close', () => {
            finishOutput();
            runCleanup(1000, 'Session Closed');
          });
        }
      );
    });

    // Reject missing or mismatched host pins before accepting the SSH server.
    try {
      sshClient.connect({
        host: targetIp,
        port: 22,
        username: sshUsername,
        privateKey: privateKeyContent,
        readyTimeout: 3000,
        hostHash: 'sha256',
        hostVerifier: (hashedKey: string) => {
          if (!expectedFingerprint || expectedFingerprint.trim() === '') {
            console.error(`🚨 [BASTION ZERO TRUST] Máy chủ ${nodeName} chưa được ghim Host Key Fingerprint. Từ chối kết nối!`);
            return false;
          }

          let normExpected = expectedFingerprint.trim().toLowerCase().replace(/^sha256:/, '');
          const normReceived = hashedKey.trim().toLowerCase().replace(/^sha256:/, '');

          // Hỗ trợ chuẩn hóa nếu expectedFingerprint được lưu ở dạng Base64 (OpenSSH ssh-keygen chuẩn)
          if (normExpected.length !== 64) {
            try {
              const rawB64 = expectedFingerprint.trim().replace(/^sha256:/i, '');
              const padded = rawB64.padEnd(rawB64.length + ((4 - (rawB64.length % 4)) % 4), '=');
              normExpected = Buffer.from(padded, 'base64').toString('hex').toLowerCase();
            } catch {}
          }

          const isMatch = (normExpected === normReceived);

          if (!isMatch) {
            console.error(`🚨 [BASTION HOST KEY MISMATCH] Máy chủ ${nodeName} có fingerprint (${normReceived}) KHÔNG KHỚP với fingerprint đã ghim (${normExpected})!`);
          }
          return isMatch;
        },
      });
    } catch {
      runCleanup(4502, 'SSH Connection Interrupted', 'Mất kết nối SSH với máy chủ đích (Xác thực hoặc giao thức SSH thất bại)');
    }
  });

  socket.on('message', (rawMessage: string | Buffer) => {
    if (sessionState === 'CLOSED' || isCancelled) return;
    sessionRecord.lastActivityTime = Date.now();

    // Bound each input frame before parsing or queueing it.
    if (rawMessage.length > 65536) {
      console.warn(`⚠️ [BASTION INPUT FLOOD] Nhận frame kích thước vượt 64KB (${rawMessage.length} bytes), ngắt phiên`);
      runCleanup(4429, 'Frame Size Exceeded', 'Frame dữ liệu vượt quá giới hạn cho phép 64KB');
      return;
    }

    try {
      const text = rawMessage.toString('utf-8');

      if (text.startsWith('{') && text.includes('"type"')) {
        try {
          const parsed = JSON.parse(text);
          if (parsed.type === 'RESIZE' && sshStream && typeof sshStream.setWindow === 'function') {
            const { rows, cols } = clampPtyDimensions(parsed.rows, parsed.cols);
            sshStream.setWindow(rows, cols, 0, 0);
            return;
          }
        } catch {}
      }

      const pumpInputQueue = () => {
        if ((sessionState as string) === 'CLOSED' || isCancelled || !sshStream) {
          if (inputPauseTimer) {
            clearTimeout(inputPauseTimer);
            inputPauseTimer = null;
          }
          return;
        }

        while (inputQueue.length > 0) {
          const nextChunk = inputQueue[0];
          const ok = sshStream.write(nextChunk);
          if (!ok) {
            // Stream đã nhận chunk vào internal buffer nhưng tiếp tục nghẽn
            inputQueue.shift();
            totalBufferedInputBytes -= nextChunk.length;

            // Repeated backpressure must rearm drain without resetting the slow-peer deadline.
            isInputPaused = true;
            if (!inputPauseTimer) {
              inputPauseTimer = setTimeout(() => {
                if (isInputPaused && (sessionState as string) !== 'CLOSED') {
                  console.error(`🚨 [BASTION SLOW PEER TIMEOUT] SSH stream bị nghẽn quá 15s không drain, ngắt phiên`);
                  runCleanup(4503, 'Slow Peer Timeout', 'Máy chủ đích phản hồi quá chậm (Timeout 15s)');
                }
              }, 15000);
              inputPauseTimer.unref();
            }
            sshStream.once('drain', pumpInputQueue);
            return;
          }

          inputQueue.shift();
          totalBufferedInputBytes -= nextChunk.length;
        }

        if (inputPauseTimer) {
          clearTimeout(inputPauseTimer);
          inputPauseTimer = null;
        }
        isInputPaused = false;
        totalBufferedInputBytes = 0;
        if ((sessionState as string) !== 'CLOSED' && !isCancelled && typeof (socket as any).resume === 'function') {
          (socket as any).resume();
        }
      };

      if (sshStream && typeof sshStream.write === 'function') {
        const chunk = Buffer.isBuffer(rawMessage) ? rawMessage : Buffer.from(rawMessage);

        if (isInputPaused) {
          // Queue paused input without writing it again; bound the total queued bytes.
          if (totalBufferedInputBytes + chunk.length > MAX_TOTAL_BUFFERED_INPUT) {
            console.error(`🚨 [BASTION INPUT OVERFLOW] Vượt ngưỡng bộ đệm tối đa 64KB (${totalBufferedInputBytes + chunk.length} bytes), ngắt phiên bảo vệ Gateway`);
            runCleanup(4429, 'Buffer Overflow', 'Bộ đệm dữ liệu đầu vào vượt quá ngưỡng cho phép 64KB');
            return;
          }
          inputQueue.push(chunk);
          totalBufferedInputBytes += chunk.length;
        } else {
          const canWrite = sshStream.write(chunk);
          if (!canWrite) {
            isInputPaused = true;
            if (typeof (socket as any).pause === 'function') {
              (socket as any).pause();
            }

            if (!inputPauseTimer) {
              inputPauseTimer = setTimeout(() => {
                if (isInputPaused && (sessionState as string) !== 'CLOSED') {
                  console.error(`🚨 [BASTION SLOW PEER TIMEOUT] SSH stream bị nghẽn quá 15s không drain, ngắt phiên`);
                  runCleanup(4503, 'Slow Peer Timeout', 'Máy chủ đích phản hồi quá chậm (Timeout 15s)');
                }
              }, 15000);
              inputPauseTimer.unref();
            }

            sshStream.once('drain', pumpInputQueue);
          }
        }
      }
    } catch (msgErr: any) {
      console.warn('⚠️ [BASTION MSG ERROR]:', msgErr.message);
    }
  });

  try {
    probeSocket.connect(22, targetIp);
  } catch {
    handleProbeFailure();
  }
}
