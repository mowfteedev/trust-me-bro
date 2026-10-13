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
 * DỊCH VỤ CẦU NỐI WEB SSH PTY BASTION BRIDGE (bastion.ts) - BẢN VÁ BẢO MẬT v3.3
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: backend (chủ trì), security, tester, code-reviewer
 * ==============================================================================
 *
 * CÁC BẢN VÁ TRỌNG TÂM ĐÃ TÍCH HỢP (REMEDIATION ROUND 2):
 * 1. [B2 FIX / R03 - Independent Watchdog & Lease Deadline]:
 *    - In-flight check guard chống query chồng chéo khi CSDL bị trễ/treo.
 *    - Independent Watchdog Timer chạy mỗi 1s bằng monotonic clock (Date.now()).
 *    - Cưỡng chế ngắt phiên sau 5s mất kết nối CSDL (Fail-Closed 4503) độc lập với DB query.
 *    - Chặn đứng Late Response hồi sinh các phiên đã đóng.
 * 2. [B2 FIX / R04 - JWT Expiry, Ticket TTL & Terminal Hard-Expiry]:
 *    - Bảo toàn authExpiresAt từ JWT payload qua ticket vào ActiveSession.
 *    - Cấp ticket giới hạn nghiêm ngặt theo thời hạn còn lại của JWT.
 *    - Hard-Expiry Timer tự động ngắt terminal ngay khi JWT hết hạn.
 * 3. [B6 FIX / R05 - Synchronous Slot Reservation & Node Quota]:
 *    - Đặt chỗ đồng bộ (Synchronous Slot Reservation) trong activeSessions trước mọi await.
 *    - Áp dụng triệt để giới hạn MAX_SESSIONS_PER_NODE = 10 sau khi lookup node.
 * 4. [B6 FIX / R06 - Input/Output Backpressure, Timer Leak & RFC 6455 Compliant]:
 *    - Single drain listener cho input backpressure kèm bounded queue chống tràn RAM.
 *    - Quản lý tập trung output interval timer, dọn dẹp sạch sẽ trong runCleanup().
 *    - Loại bỏ mã đóng WebSocket 1006 (bị cấm bởi RFC 6455), dùng mã hợp lệ 1011/4500.
 * 5. [B3 FIX / R07 - Audit Logging Fail-Closed & Session End]:
 *    - BASTION_SESSION_START bắt buộc thành công (Fail-Closed).
 *    - Ghi nhận sự kiện BASTION_SESSION_END khi kết thúc phiên.
 * 6. [B5 FIX - SSH Host Key Pinning & Error Masking]:
 *    - Ghim vân tay SHA-256 fingerprint chống MITM.
 *    - Che giấu chi tiết lỗi SSH nội bộ (Masked Errors) ra phía client.
 */

interface BastionTicket {
  nodeId: string;
  userId: string;
  sessionVersion: number;
  expiresAt: number;
  authExpiresAt: number;
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
  authExpiresAt: number;
  lastLeaseRenewNs: bigint; // Monotonic Clock nano-giây (N06 REMEDIATION - Chống wall-clock lùi giờ)
  lastActivityTime: number;
  isAuditStarted: boolean;
  hardExpiryTimer: NodeJS.Timeout | null;
  outputDrainInterval: NodeJS.Timeout | null;
  cleanupFn: (closeCode?: number, reason?: string, userMsg?: string) => void;
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

// Cờ chống truy vấn chồng chéo (In-flight guard)
let isCheckingDb = false;

/**
 * Background Session Registry Batch Checker (R03 & N07 Remediation):
 * Quét định kỳ mỗi 2 giây để thu hồi phiên mở khi người dùng bị khóa/hạ quyền/đăng xuất trong CSDL
 */
const sessionCheckerInterval = setInterval(async () => {
  if (activeSessions.size === 0) return;
  if (isCheckingDb) return; // In-flight check guard chống query chồng chéo khi CSDL treo
  isCheckingDb = true;

  // N07 REMEDIATION: Tạo snapshot danh sách phiên tại thời điểm bắt đầu query
  const sessionSnapshot = new Map(activeSessions.entries());
  const userIds = Array.from(new Set(Array.from(sessionSnapshot.values()).map(s => s.userId)));
  if (userIds.length === 0) {
    isCheckingDb = false;
    return;
  }

  try {
    const res = await query(
      'SELECT id, is_active, role, session_version FROM users WHERE id = ANY($1);',
      [userIds]
    );

    const userMap = new Map<string, any>();
    for (const row of res.rows) {
      userMap.set(row.id, row);
    }

    const nowNs = process.hrtime.bigint();
    // N07 REMEDIATION: Chỉ thẩm định và áp dụng cho các phiên nằm trong snapshot ban đầu!
    // Các phiên mới kết nối trong lúc query pending giữ nguyên quyền hợp lệ cho đợt batch sau.
    for (const [sessionId, session] of sessionSnapshot.entries()) {
      if (!activeSessions.has(sessionId)) continue; // Phiên đã bị đóng trong lúc chờ DB
      if (session.state === 'CLOSED') continue; // Chặn late response hồi sinh session

      session.lastLeaseRenewNs = nowNs;
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
    console.warn('⚠️ [BASTION SESSION CHECKER] Lỗi truy vấn CSDL trong batch check:', err.message);
  } finally {
    isCheckingDb = false;
  }
}, 2000);
sessionCheckerInterval.unref();

/**
 * Independent Watchdog Timer (R03 & N06 Remediation):
 * Chạy mỗi 500ms hoàn toàn độc lập với DB query. Sử dụng monotonic clock process.hrtime.bigint().
 * Nếu quá deadline >= 5000ms -> ngắt phiên ngay lập tức với mã 4503, bảo đảm SLA <= 5.2s.
 */
const independentWatchdogInterval = setInterval(() => {
  if (activeSessions.size === 0) return;
  const nowNs = process.hrtime.bigint();
  for (const [sessionId, session] of activeSessions.entries()) {
    if (session.state === 'CLOSED') continue;
    const elapsedMs = Number((nowNs - session.lastLeaseRenewNs) / 1_000_000n);
    if (elapsedMs >= 5000) {
      console.error(`🚨 [BASTION DB DEADLINE EXCEEDED] Đóng phiên ${sessionId} vì mất kết nối CSDL quá deadline 5s (thực tế: ${elapsedMs}ms)`);
      session.cleanupFn(4503, 'DB Deadline Exceeded', 'Mất kết nối kiểm tra an ninh cơ sở dữ liệu quá thời hạn cho phép');
    }
  }
}, 500);
independentWatchdogInterval.unref();

/**
 * Cấp phát One-Time Ticket dùng một lần để kết nối Web SSH (Gắn liền session_version và authExpiresAt)
 */
export function createBastionTicket(
  nodeId: string,
  userId: string,
  sessionVersion: number,
  ttlSeconds = 30,
  authExpiresAt = Date.now() + 86400000
): string {
  const ticket = generateSecureToken(32);
  ticketStore.set(ticket, {
    nodeId,
    userId,
    sessionVersion,
    expiresAt: Date.now() + Math.max(1000, ttlSeconds * 1000),
    authExpiresAt,
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
  let isInputPaused = false;

  let probeSocket: net.Socket | null = null;
  let sshClient: Client | null = null;
  let sshStream: any = null;

  // N05 REMEDIATION: Quản lý hàng đợi bộ đệm byte thực tế và slow-consumer timeout
  const inputQueue: Buffer[] = [];
  let totalBufferedInputBytes = 0;
  const MAX_TOTAL_BUFFERED_INPUT = 65536; // Trần cứng 64KB cho toàn bộ hàng đợi đệm
  let inputPauseTimer: NodeJS.Timeout | null = null;

  // N08 REMEDIATION: Quản lý vòng đời START và END audit chống race disconnect
  let currentUserId = '';
  let isAuditStarting = false;
  let isAuditStarted = false;
  let pendingEndAuditAfterStart = false;
  let closeReasonForEndAudit = 'Session Closed';

  // 1. Hàm dọn dẹp tài nguyên lũy thừa (Idempotent Cleanup)
  const runCleanup = (closeCode = 1000, reason = 'Session Closed', userMsg?: string) => {
    if (sessionState === 'CLOSED') return;
    sessionState = 'CLOSED';
    isCancelled = true;

    // Dọn dẹp hàng đợi input và timer backpressure (N05)
    if (inputPauseTimer) {
      clearTimeout(inputPauseTimer);
      inputPauseTimer = null;
    }
    inputQueue.length = 0;
    totalBufferedInputBytes = 0;

    const existingSession = activeSessions.get(sessionId);
    activeSessions.delete(sessionId);

    // Dọn dẹp Hard Expiry Timer (R04)
    if (existingSession?.hardExpiryTimer) {
      clearTimeout(existingSession.hardExpiryTimer);
      existingSession.hardExpiryTimer = null;
    }

    // Dọn dẹp Output Drain Timer (R06)
    if (existingSession?.outputDrainInterval) {
      clearInterval(existingSession.outputDrainInterval);
      existingSession.outputDrainInterval = null;
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

    // Forced-Close Deadline 3s (N05 REMEDIATION): Hủy cưỡng bức nếu socket/stream chưa giải phóng
    const forcedTimer = setTimeout(() => {
      if (probeSocket) { try { (probeSocket as any).destroy(); } catch {} probeSocket = null; }
      if (sshStream) { try { (sshStream as any).destroy(); } catch {} sshStream = null; }
      if (sshClient) { try { (sshClient as any).destroy(); } catch {} sshClient = null; }
    }, 3000);
    forcedTimer.unref();

    // Ghi nhận Audit Log phiên kết thúc nếu đã từng bắt đầu (R07 & N08 Remediation)
    const auditUserId = existingSession?.userId || currentUserId;
    if (isAuditStarted || existingSession?.isAuditStarted) {
      isAuditStarted = false;
      if (existingSession) existingSession.isAuditStarted = false;
      query(
        `INSERT INTO audit_logs (user_id, action, target, details, ip_address)
         VALUES ($1, 'BASTION_SESSION_END', 'bastion', $2, '127.0.0.1'::inet);`,
        [auditUserId, JSON.stringify({ session_id: sessionId, node_id: nodeIdentifier, reason })]
      ).catch((err) => {
        console.warn('⚠️ [BASTION AUDIT END ERROR] Lỗi ghi audit log khi kết thúc phiên:', err.message);
      });
    } else if (isAuditStarting) {
      // N08 REMEDIATION: Nếu socket bị đóng trong lúc START query đang pending,
      // kích hoạt ghi END ngay sau khi START resolve xong!
      pendingEndAuditAfterStart = true;
      closeReasonForEndAudit = reason;
    }

    // Đóng WebSocket an toàn tuân thủ RFC 6455 (Không dùng mã 1006)
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

  // 2. Đăng ký sự kiện đóng socket ngay từ đầu (Early Registration chống Race Disconnect)
  socket.on('close', () => {
    runCleanup(1000, 'Client Closed');
  });

  socket.on('error', (err) => {
    console.warn(`⚠️ [BASTION WS ERROR ${sessionId}]:`, err.message);
    // RFC 6455: Dùng 1011 (Internal Error) thay vì 1006
    runCleanup(1011, 'Socket Error');
  });

  // 3. SYNCHRONOUS SLOT RESERVATION (R05 Remediation):
  // Kiểm tra hạn mức toàn cục đồng bộ trước bất kỳ await nào
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

  const { userId, sessionVersion, authExpiresAt } = authResult.ticketData;
  currentUserId = userId;

  // Kiểm tra hạn mức người dùng đồng bộ
  const userOpenSessions = Array.from(activeSessions.values()).filter(s => s.userId === userId).length;
  if (userOpenSessions >= MAX_SESSIONS_PER_USER) {
    runCleanup(4429, 'User Quota Exceeded', 'Tài khoản đã mở quá số phiên SSH cho phép (tối đa 5 phiên)');
    return;
  }

  // Khởi tạo và thiết lập Hard-Expiry Timer (R04 Remediation)
  const timeUntilJwtExpires = Math.max(0, authExpiresAt - Date.now());
  const hardExpiryTimer = setTimeout(() => {
    console.warn(`⏰ [BASTION JWT EXPIRED] Phiên ${sessionId} đã đạt giới hạn thời gian sống của JWT (${authExpiresAt})`);
    runCleanup(4401, 'Token Expired', 'Mã xác thực JWT đã hết hạn');
  }, timeUntilJwtExpires);
  hardExpiryTimer.unref();

  // ĐĂNG KÝ NGAY LẬP TỨC VÀO ACTIVE SESSIONS ĐỂ CHIẾM SLOT ĐỒNG BỘ (Chống Race Condition R05)
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
  let targetNodeId = nodeIdentifier;
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

    targetNodeId = nodeRes.rows[0].id;
    targetIp = nodeRes.rows[0].ip_address;
    nodeName = nodeRes.rows[0].name;
    expectedFingerprint = (nodeRes.rows[0].host_key_fingerprint || '').trim();

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

  // KIỂM TRA HẠN MỨC PHIÊN THEO MÁY CHỦ CON (MAX_SESSIONS_PER_NODE = 10) (R05 Remediation)
  const nodeOpenSessions = Array.from(activeSessions.values()).filter(
    s => s.nodeId === targetNodeId || s.nodeId === nodeIdentifier
  ).length;

  if (nodeOpenSessions > MAX_SESSIONS_PER_NODE) {
    runCleanup(4429, 'Node Quota Exceeded', `Máy chủ ${nodeName} đã đạt giới hạn tối đa ${MAX_SESSIONS_PER_NODE} phiên SSH đồng thời`);
    return;
  }

  // 7. Ghi nhận bắt đầu phiên Bastion vào Audit Log - FAIL-CLOSED & FINALIZER (B3 & N08 Fix)
  isAuditStarting = true;
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, target, details, ip_address)
       VALUES ($1, 'BASTION_SESSION_START', 'bastion', $2, $3::inet);`,
      [dbUser.id, JSON.stringify({ session_id: sessionId, node_id: nodeIdentifier, target_ip: targetIp }), '127.0.0.1']
    );
    isAuditStarted = true;
    sessionRecord.isAuditStarted = true;
  } catch (auditErr: any) {
    console.error('❌ [BASTION AUDIT FAILURE] Không thể ghi audit log mở phiên, Fail-Closed:', auditErr.message);
    runCleanup(4503, 'Audit Failure', 'Không thể mở phiên do không thể ghi nhận vết kiểm toán an toàn');
    return;
  } finally {
    isAuditStarting = false;
    // N08 REMEDIATION: Nếu socket bị ngắt trong lúc START đang pending, ghi ngay END audit sau khi START commit thành công!
    if (pendingEndAuditAfterStart && isAuditStarted) {
      pendingEndAuditAfterStart = false;
      query(
        `INSERT INTO audit_logs (user_id, action, target, details, ip_address)
         VALUES ($1, 'BASTION_SESSION_END', 'bastion', $2, '127.0.0.1'::inet);`,
        [dbUser.id, JSON.stringify({ session_id: sessionId, node_id: nodeIdentifier, reason: closeReasonForEndAudit })]
      ).catch((err) => {
        console.warn('⚠️ [BASTION AUDIT END ERROR] Lỗi ghi audit log khi kết thúc phiên (late resolve):', err.message);
      });
    }
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

  // 9. Fast Zero Trust Probe cổng 22
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

    // Bắt đầu kết nối SSH2 Client
    sessionState = 'CONNECTING';
    sessionRecord.state = 'CONNECTING';
    sshClient = new Client();
    sessionRecord.sshClient = sshClient;

    sshClient.on('error', (err) => {
      console.warn(`⚠️ [BASTION SSH ERROR ${sessionId}] Kết nối SSH tới ${targetIp} thất bại:`, err.message);
      // P1: Masked error message, không để lộ raw err.message của ssh2
      runCleanup(4502, 'SSH Connection Interrupted', 'Mất kết nối SSH với máy chủ đích (Xác thực hoặc giao thức SSH thất bại)');
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

          // Output SSH -> WS với Backpressure & Timer Management (R06 Remediation)
          stream.on('data', (chunk: Buffer) => {
            sessionRecord.lastActivityTime = Date.now();
            if (socket.readyState === 1) {
              try {
                socket.send(chunk.toString('utf-8'));
                // Output Backpressure: Nếu bufferedAmount vượt 64KB, pause stream SSH
                if ((socket as any).bufferedAmount > 65536) {
                  if (typeof stream.pause === 'function') stream.pause();

                  // Chỉ khởi tạo một timer duy nhất gắn vào sessionRecord
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
                // RFC 6455: Dùng 1011 thay vì 1006
                runCleanup(1011, 'Send Error');
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
          // ZERO TRUST HOST VERIFICATION (B5 Enforced):
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
      handleProbeFailure();
    }
  });

  // 10. Xử lý Input từ Web Client với Bounded Backpressure (R06 Fix)
  socket.on('message', (rawMessage: string | Buffer) => {
    if (sessionState === 'CLOSED' || isCancelled) return;
    sessionRecord.lastActivityTime = Date.now();

    // Bounded Input Guard: Chặn frame quá 64KB chống cạn kiệt RAM
    if (rawMessage.length > 65536) {
      console.warn(`⚠️ [BASTION INPUT FLOOD] Nhận frame kích thước vượt 64KB (${rawMessage.length} bytes), từ chối`);
      return;
    }

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

      // N05 REMEDIATION: Input Stream WS -> SSH với Bounded Queue tổng byte & Slow-Consumer Timeout
      if (sshStream && typeof sshStream.write === 'function') {
        const chunk = Buffer.isBuffer(rawMessage) ? rawMessage : Buffer.from(rawMessage);

        if (isInputPaused) {
          // Khi đang nghẽn: KHÔNG gọi sshStream.write() trực tiếp!
          // Đưa vào hàng đợi và kiểm tra trần tổng dung lượng đệm (MAX_TOTAL_BUFFERED_INPUT = 64KB)
          if (totalBufferedInputBytes + chunk.length > MAX_TOTAL_BUFFERED_INPUT) {
            console.error(`🚨 [BASTION INPUT OVERFLOW] Vượt ngưỡng bộ đệm tối đa 64KB (${totalBufferedInputBytes + chunk.length} bytes), ngắt phiên bảo vệ Gateway`);
            runCleanup(4429, 'Buffer Overflow', 'Bộ đệm dữ liệu đầu vào vượt quá ngưỡng cho phép 64KB');
            return;
          }
          inputQueue.push(chunk);
          totalBufferedInputBytes += chunk.length;
        } else {
          // Chưa nghẽn: thử ghi trực tiếp
          const canWrite = sshStream.write(chunk);
          if (!canWrite) {
            isInputPaused = true;
            if (typeof (socket as any).pause === 'function') {
              (socket as any).pause();
            }

            // Kích hoạt timer slow-consumer timeout 15s (N05 REMEDIATION)
            if (!inputPauseTimer) {
              inputPauseTimer = setTimeout(() => {
                if (isInputPaused && sessionState !== 'CLOSED') {
                  console.error(`🚨 [BASTION SLOW PEER TIMEOUT] SSH stream bị nghẽn quá 15s không drain, ngắt phiên`);
                  runCleanup(4503, 'Slow Peer Timeout', 'Máy chủ đích phản hồi quá chậm (Timeout 15s)');
                }
              }, 15000);
              inputPauseTimer.unref();
            }

            // Đăng ký drain listener duy nhất để xả hàng đợi
            sshStream.once('drain', () => {
              if (inputPauseTimer) {
                clearTimeout(inputPauseTimer);
                inputPauseTimer = null;
              }

              // Xả dần các chunk đã đệm trong inputQueue
              while (inputQueue.length > 0) {
                const nextChunk = inputQueue.shift()!;
                totalBufferedInputBytes -= nextChunk.length;
                const ok = sshStream.write(nextChunk);
                if (!ok) {
                  // Vẫn còn nghẽn, tiếp tục chờ drain đợt sau
                  return;
                }
              }

              // Hàng đợi đã rỗng
              isInputPaused = false;
              totalBufferedInputBytes = 0;
              if (sessionState !== 'CLOSED' && !isCancelled && typeof (socket as any).resume === 'function') {
                (socket as any).resume();
              }
            });
          }
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
