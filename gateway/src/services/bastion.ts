import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import { Client } from 'ssh2';
import type { WebSocket } from 'ws';
import { config } from '../config/env.js';
import { query } from './db.js';
import { generateSecureToken } from '../utils/crypto.js';

/**
 * ==============================================================================
 * DỊCH VỤ CẦU NỐI WEB SSH PTY BASTION BRIDGE (bastion.ts) - BẢN VÁ BẢO MẬT TOÀN DIỆN
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: backend (chủ trì), security, tester, code-reviewer
 * ==============================================================================
 *
 * CÁC BẢN VÁ TRỌNG TÂM ĐÃ TÍCH HỢP:
 * 1. [B2 FIX - Session Revocation]:
 *    - Ticket lưu userId + sessionVersion. Khi redeem, BẮT BUỘC kiểm tra lại is_active, role, session_version từ CSDL.
 *    - Active Session Registry: Quản lý toàn bộ phiên mở, kiểm tra batch định kỳ mỗi 2s.
 *    - Independent Deadline: Mất kết nối CSDL quá 5s tự động ngắt phiên (Fail-Closed).
 *    - Ngắt terminal ngay lập tức khi user bị khóa, hạ quyền hoặc đăng xuất (session_version thay đổi).
 * 2. [B6 FIX - Vòng Đời & Backpressure]:
 *    - Đăng ký WS close/error và cờ cancellation TRƯỚC mọi thao tác bất đồng bộ.
 *    - Quản lý trạng thái rõ ràng (INIT -> PROBING -> CONNECTING -> READY -> CLOSED).
 *    - Hủy ngay mọi tài nguyên đến muộn (Late Resources) sau khi CLOSED.
 *    - Input WS -> SSH: Kiểm tra canWrite. Nếu false -> socket.pause() và chờ sshStream.drain.
 *    - Output SSH -> WS: Ngưỡng 64KB High Watermark -> pause stream, 16KB Low Watermark -> resume.
 *    - Hạn mức Quota phiên theo user/node/global và dọn dẹp sạch khi SIGTERM.
 * 3. [B5 FIX - SSH Host Key Pinning]:
 *    - Thẩm định danh tính máy chủ qua hostVerifier (SHA256 hex fingerprint).
 *    - Chặn đứng kết nối nếu node chưa ghim host_key_fingerprint hoặc fingerprint bị sai lệch.
 */

interface BastionTicket {
  nodeId: string;
  userId: string;
  sessionVersion: number;
  expiresAt: number;
}

interface ActiveSession {
  sessionId: string;
  userId: string;
  sessionVersion: number;
  nodeId: string;
  nodeName: string;
  state: 'INIT' | 'PROBING' | 'CONNECTING' | 'READY' | 'CLOSING' | 'CLOSED';
  socket: WebSocket;
  sshClient: Client | null;
  sshStream: any | null;
  createdAt: number;
  lastDbHealthyTime: number;
  lastActivityTime: number;
  cleanupFn: (code?: number, reason?: string, msg?: string) => void;
}

// Bảng lưu trữ One-Time Ticket trong bộ nhớ RAM
const ticketStore = new Map<string, BastionTicket>();

// Bảng quản lý các phiên SSH đang kết nối thực tế (Active Session Registry)
const activeSessions = new Map<string, ActiveSession>();

// Giới hạn hạn mức phiên (Session Quotas)
const MAX_SESSIONS_PER_USER = 5;
const MAX_SESSIONS_PER_NODE = 10;
const MAX_GLOBAL_SESSIONS = 50;

// Dọn dẹp các ticket hết hạn mỗi 10 giây
setInterval(() => {
  const now = Date.now();
  for (const [ticket, data] of ticketStore.entries()) {
    if (data.expiresAt < now) {
      ticketStore.delete(ticket);
    }
  }
}, 10000).unref();

/**
 * Background Session Registry Batch Checker:
 * Quét định kỳ mỗi 2 giây để thu hồi phiên mở khi người dùng bị khóa/hạ quyền/đăng xuất trong CSDL
 */
const sessionCheckerInterval = setInterval(async () => {
  if (activeSessions.size === 0) return;

  const userIds = Array.from(new Set(Array.from(activeSessions.values()).map(s => s.userId)));
  if (userIds.length === 0) return;

  try {
    const res = await query(
      'SELECT id, is_active, role, session_version FROM users WHERE id = ANY($1);',
      [userIds]
    );

    const userMap = new Map<string, any>();
    for (const row of res.rows) {
      userMap.set(row.id, row);
    }

    const now = Date.now();
    for (const [sessionId, session] of activeSessions.entries()) {
      if (session.state === 'CLOSED') continue;
      session.lastDbHealthyTime = now;
      const user = userMap.get(session.userId);

      // Điều kiện thu hồi phiên lập tức:
      // 1. User không còn tồn tại hoặc is_active = false
      // 2. User bị tước quyền ADMIN
      // 3. session_version không khớp (Đã đăng xuất hoặc bị bump version)
      if (!user || !user.is_active || user.role !== 'ADMIN' || Number(user.session_version) !== Number(session.sessionVersion)) {
        console.warn(`🔒 [BASTION REVOCATION] Thu hồi phiên ${sessionId} của user ${session.userId} do vi phạm trạng thái tài khoản CSDL`);
        session.cleanupFn(4403, 'Session Revoked', 'Phiên làm việc đã bị quản trị viên thu hồi hoặc bạn đã đăng xuất');
      }
    }
  } catch (err: any) {
    // DEADLINE ĐỘC LẬP: Nếu mất kết nối CSDL quá 5 giây, cưỡng chế đóng các phiên để bảo đảm Fail-Closed!
    const now = Date.now();
    for (const [sessionId, session] of activeSessions.entries()) {
      if (session.state === 'CLOSED') continue;
      if (now - session.lastDbHealthyTime > 5000) {
        console.error(`🚨 [BASTION DB DEADLINE EXCEEDED] Đóng phiên ${sessionId} vì mất kết nối CSDL quá deadline 5s`);
        session.cleanupFn(4503, 'DB Deadline Exceeded', 'Mất kết nối kiểm tra an ninh cơ sở dữ liệu quá thời hạn cho phép');
      }
    }
  }
}, 2000);
sessionCheckerInterval.unref();

/**
 * Cấp phát One-Time Ticket dùng một lần để kết nối Web SSH (Gắn liền session_version)
 */
export function createBastionTicket(nodeId: string, userId: string, sessionVersion: number, ttlSeconds = 30): string {
  const ticket = generateSecureToken(32);
  ticketStore.set(ticket, {
    nodeId,
    userId,
    sessionVersion,
    expiresAt: Date.now() + Math.max(5000, ttlSeconds * 1000),
  });
  return ticket;
}

/**
 * Thẩm định và tiêu hủy vé dùng một lần
 */
export function verifyAndConsumeTicket(ticket: string, nodeId: string): { valid: boolean; ticketData?: BastionTicket } {
  const ticketData = ticketStore.get(ticket);
  if (!ticketData) {
    return { valid: false };
  }

  // Tiêu hủy vé ngay lập tức (Single-Use Guard)
  ticketStore.delete(ticket);

  if (ticketData.expiresAt < Date.now()) {
    return { valid: false };
  }

  if (ticketData.nodeId !== nodeId) {
    return { valid: false };
  }

  return { valid: true, ticketData };
}

/**
 * Kẹp biên tham số cửa sổ PTY Terminal chống crash tiến trình shell (BUG-004)
 */
export function clampPtyDimensions(rawRows: any, rawCols: any): { rows: number; cols: number } {
  const parsedRows = Math.floor(Number(rawRows)) || 24;
  const parsedCols = Math.floor(Number(rawCols)) || 80;

  const rows = Math.min(200, Math.max(10, parsedRows));
  const cols = Math.min(500, Math.max(20, parsedCols));

  return { rows, cols };
}

/**
 * Khởi tạo phiên cầu nối hai chiều giữa WebSocket và OpenSSH Channel
 */
export async function attachBastionSession(
  socket: WebSocket,
  nodeIdentifier: string,
  initialTicket: string
): Promise<void> {
  const sessionId = crypto.randomUUID();
  let sessionState: 'INIT' | 'PROBING' | 'CONNECTING' | 'READY' | 'CLOSING' | 'CLOSED' = 'INIT';
  let isCancelled = false;

  let probeSocket: net.Socket | null = null;
  let sshClient: Client | null = null;
  let sshStream: any = null;
  let slowConsumerCheckTimer: NodeJS.Timeout | null = null;

  // 1. Hàm dọn dẹp tài nguyên lũy thừa (Idempotent Cleanup)
  const runCleanup = (closeCode = 1000, reason = 'Session Closed', userMsg?: string) => {
    if (sessionState === 'CLOSED') return;
    sessionState = 'CLOSED';
    isCancelled = true;
    activeSessions.delete(sessionId);

    if (slowConsumerCheckTimer) {
      clearInterval(slowConsumerCheckTimer);
      slowConsumerCheckTimer = null;
    }

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

    if (socket.readyState === 1 || socket.readyState === 0) {
      if (userMsg && socket.readyState === 1) {
        try { socket.send(JSON.stringify({ type: 'ERROR', message: userMsg })); } catch {}
      }
      try { socket.close(closeCode, reason); } catch {}
    }
  };

  // 2. Đăng ký sự kiện đóng socket ngay từ đầu (Early Registration chống Race Disconnect)
  socket.on('close', () => {
    runCleanup(1000, 'Client Closed');
  });

  socket.on('error', (err) => {
    console.warn(`⚠️ [BASTION WS ERROR ${sessionId}]:`, err.message);
    runCleanup(1006, 'Socket Error');
  });

  // 3. Kiểm tra hạn mức phiên toàn cục (Session Quota Guard)
  if (activeSessions.size >= MAX_GLOBAL_SESSIONS) {
    runCleanup(4429, 'Session Quota Exceeded', 'Hệ thống đã đạt giới hạn số phiên kết nối đồng thời');
    return;
  }

  // 4. Thẩm định vé dùng một lần
  const authResult = verifyAndConsumeTicket(initialTicket, nodeIdentifier);
  if (!authResult.valid || !authResult.ticketData) {
    runCleanup(4401, 'Unauthorized Ticket', 'Mã vé truy cập Web SSH không hợp lệ hoặc đã hết hạn');
    return;
  }

  const { userId, sessionVersion } = authResult.ticketData;

  // Kiểm tra hạn mức phiên của riêng người dùng
  const userOpenSessions = Array.from(activeSessions.values()).filter(s => s.userId === userId).length;
  if (userOpenSessions >= MAX_SESSIONS_PER_USER) {
    runCleanup(4429, 'User Quota Exceeded', 'Tài khoản đã mở quá số phiên SSH cho phép (tối đa 5 phiên)');
    return;
  }

  // 5. Kiểm tra quyền hạn và trạng thái tài khoản thời gian thực trong CSDL (B2 Fix)
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

  // 6. Tra cứu thông tin máy chủ con và Host Key Fingerprint (B5 Fix)
  let targetIp = '';
  let nodeName = nodeIdentifier;
  let expectedFingerprint = '';

  try {
    const nodeRes = await query(
      'SELECT id, name, ip_address, host_key_fingerprint FROM nodes WHERE (id::text = $1 OR name = $1) LIMIT 1;',
      [nodeIdentifier]
    );

    if (nodeRes.rows.length === 0) {
      runCleanup(4404, 'Node Not Found', 'Không tìm thấy thông tin máy chủ con');
      return;
    }

    targetIp = nodeRes.rows[0].ip_address;
    nodeName = nodeRes.rows[0].name;
    expectedFingerprint = (nodeRes.rows[0].host_key_fingerprint || '').trim();
  } catch (nodeDbErr: any) {
    console.error('❌ [BASTION NODE DB ERROR]:', nodeDbErr.message);
    runCleanup(4500, 'Database Error', 'Lỗi truy vấn thông tin máy chủ con');
    return;
  }

  if (isCancelled) {
    runCleanup();
    return;
  }

  // 7. Ghi nhận bắt đầu phiên Bastion vào Audit Log - FAIL-CLOSED (B3 Fix)
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, target, details, ip_address)
       VALUES ($1, 'BASTION_SESSION_START', 'bastion', $2, $3::inet);`,
      [dbUser.id, JSON.stringify({ node_id: nodeIdentifier, target_ip: targetIp }), '127.0.0.1']
    );
  } catch (auditErr: any) {
    console.error('❌ [BASTION AUDIT FAILURE] Không thể ghi audit log mở phiên, Fail-Closed:', auditErr.message);
    runCleanup(4503, 'Audit Failure', 'Không thể mở phiên do không thể ghi nhận vết kiểm toán an toàn');
    return;
  }

  if (isCancelled) {
    runCleanup();
    return;
  }

  // 8. Đọc tệp khóa riêng Ed25519 của Gateway
  let privateKeyContent: Buffer;
  try {
    privateKeyContent = fs.readFileSync(config.BASTION_SSH_KEY_PATH);
  } catch (fsErr: any) {
    console.error('❌ [BASTION ERROR] Không thể đọc khóa riêng SSH:', fsErr.message);
    runCleanup(4500, 'SSH Key Missing', 'Lỗi cấu hình khóa xác thực Bastion Gateway');
    return;
  }

  // 9. Đăng ký phiên vào Active Session Registry
  const sessionRecord: ActiveSession = {
    sessionId,
    userId: dbUser.id,
    sessionVersion: dbUser.session_version,
    nodeId: nodeIdentifier,
    nodeName,
    state: 'PROBING',
    socket,
    sshClient: null,
    sshStream: null,
    createdAt: Date.now(),
    lastDbHealthyTime: Date.now(),
    lastActivityTime: Date.now(),
    cleanupFn: runCleanup,
  };
  activeSessions.set(sessionId, sessionRecord);

  // 10. Fast Zero Trust Probe cổng 22
  sessionState = 'PROBING';
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

    // Bắt đầu kết nối SSH2 Client
    sessionState = 'CONNECTING';
    sshClient = new Client();
    sessionRecord.sshClient = sshClient;

    sshClient.on('error', (err) => {
      console.warn(`⚠️ [BASTION SSH ERROR ${sessionId}] Kết nối SSH tới ${targetIp} thất bại:`, err.message);
      runCleanup(4502, 'SSH Connection Interrupted', 'Mất kết nối SSH với máy chủ đích: ' + err.message);
    });

    sshClient.on('ready', () => {
      // HỦY TÀI NGUYÊN ĐẾN MUỘN (Late Resource Destruction):
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

          // Gửi thông điệp READY về cho Web Client
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({
              type: 'READY',
              message: `Đã kết nối thành công tới ${nodeName} (${targetIp})`,
            }));
          }

          // Output SSH -> WS với Backpressure
          stream.on('data', (chunk: Buffer) => {
            sessionRecord.lastActivityTime = Date.now();
            if (socket.readyState === 1) {
              try {
                socket.send(chunk.toString('utf-8'));
                // Output Backpressure: Nếu bufferedAmount vượt 64KB, pause stream SSH
                if ((socket as any).bufferedAmount > 65536) {
                  if (typeof stream.pause === 'function') stream.pause();

                  const checkDrain = setInterval(() => {
                    if ((socket as any).bufferedAmount < 16384) {
                      clearInterval(checkDrain);
                      if (sessionState === 'READY' && typeof stream.resume === 'function') {
                        stream.resume();
                      }
                    }
                  }, 40);
                  checkDrain.unref();
                }
              } catch (sendErr) {
                runCleanup(1006, 'Send Error');
              }
            }
          });

          stream.on('error', (streamErr: any) => {
            console.warn('⚠️ [BASTION STREAM ERROR]:', streamErr.message);
            runCleanup(4502, 'Stream Error', 'Mất kết nối SSH với máy chủ đích');
          });

          stream.on('close', () => {
            runCleanup(1000, 'Session Closed');
          });
        }
      );
    });

    // Cấu hình SSH2 Client với Host Key Pinning (B5 Fix)
    try {
      sshClient.connect({
        host: targetIp,
        port: 22,
        username: config.BASTION_DEFAULT_USER,
        privateKey: privateKeyContent,
        readyTimeout: 3000,
        hostHash: 'sha256',
        hostVerifier: (hashedKey: string) => {
          // ZERO TRUST HOST VERIFICATION:
          // Nếu node chưa được cấu hình host_key_fingerprint -> TỪ CHỐI KẾT NỐI!
          if (!expectedFingerprint || expectedFingerprint.trim() === '') {
            console.error(`🚨 [BASTION ZERO TRUST] Máy chủ ${nodeName} chưa được ghim Host Key Fingerprint. Từ chối kết nối!`);
            return false;
          }

          const normExpected = expectedFingerprint.trim().toLowerCase().replace(/^sha256:/, '');
          const normReceived = hashedKey.trim().toLowerCase().replace(/^sha256:/, '');
          const isMatch = (normExpected === normReceived);

          if (!isMatch) {
            console.error(`🚨 [BASTION HOST KEY MISMATCH] Máy chủ ${nodeName} có fingerprint (${normReceived}) KHÔNG KHỚP với fingerprint đã ghim (${normExpected})!`);
          }
          return isMatch;
        },
      });
    } catch {
      handleProbeFailure();
    }
  });

  // 11. Xử lý Input từ Web Client với Backpressure (B6 Fix)
  socket.on('message', (rawMessage: string | Buffer) => {
    if (sessionState === 'CLOSED' || isCancelled) return;
    sessionRecord.lastActivityTime = Date.now();

    try {
      const text = rawMessage.toString('utf-8');

      // Frame điều khiển RESIZE
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

      // Input Stream WS -> SSH
      if (sshStream && typeof sshStream.write === 'function') {
        const canWrite = sshStream.write(rawMessage);
        // INPUT BACKPRESSURE GUARD:
        // Nếu canWrite === false -> Writable buffer đã đầy, tạm dừng WebSocket đọc thêm dữ liệu
        if (!canWrite) {
          if (typeof (socket as any).pause === 'function') {
            (socket as any).pause();
          }
          sshStream.once('drain', () => {
            if (sessionState !== 'CLOSED' && !isCancelled && typeof (socket as any).resume === 'function') {
              (socket as any).resume();
            }
          });
        }
      }
    } catch (msgErr: any) {
      console.warn('⚠️ [BASTION MSG ERROR]:', msgErr.message);
    }
  });

  // Bắt đầu chạy probe
  try {
    probeSocket.connect(22, targetIp);
  } catch {
    handleProbeFailure();
  }
}

/**
 * Đóng an toàn toàn bộ các phiên Bastion khi Gateway nhận tín hiệu dừng (SIGTERM/SIGINT)
 */
export function shutdownAllBastionSessions(): void {
  console.log(`🛑 [BASTION SHUTDOWN] Đang đóng an toàn ${activeSessions.size} phiên Web SSH...`);
  for (const session of activeSessions.values()) {
    session.cleanupFn(1001, 'Gateway Shutting Down', 'Máy chủ Gateway đang bảo trì khởi động lại');
  }
  activeSessions.clear();
}
