import type { Client } from 'ssh2';
import type { WebSocket } from 'ws';
import { query } from '../db.js';

export interface ActiveSession {
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
  lastLeaseRenewNs: bigint; // Monotonic time tolerates wall-clock changes.
  lastActivityTime: number;
  isAuditStarted: boolean;
  hardExpiryTimer: NodeJS.Timeout | null;
  outputDrainInterval: NodeJS.Timeout | null;
  cleanupFn: (closeCode?: number, reason?: string, userMsg?: string) => void;
}

export const activeSessions = new Map<string, ActiveSession>();
export const MAX_SESSIONS_PER_USER = 5;
export const MAX_SESSIONS_PER_NODE = 10;
export const MAX_GLOBAL_SESSIONS = 50;

export const GATEWAY_INSTANCE_ID = process.env.GATEWAY_INSTANCE_ID || `gw_${process.pid}_${Date.now().toString(36)}`;

let isCheckingDb = false;
let maintenanceGeneration = 0;
let sessionCheckerInterval: NodeJS.Timeout | null = null;
let independentWatchdogInterval: NodeJS.Timeout | null = null;

// Batch current account permissions and renew leases without overlapping DB calls.
async function checkSessions(): Promise<void> {
  if (activeSessions.size === 0) return;
  if (isCheckingDb) return; // Never overlap batches while the database is slow.
  isCheckingDb = true;
  const generation = maintenanceGeneration;

  // A pending query must not apply its result to sessions created after this snapshot.
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

    // A stopped/restarted owner must not apply a response from the previous run.
    if (generation !== maintenanceGeneration) return;

    const userMap = new Map<string, any>();
    for (const row of res.rows) {
      userMap.set(row.id, row);
    }

    const nowNs = process.hrtime.bigint();
    const aliveSessionIds: string[] = [];

    for (const [sessionId, session] of sessionSnapshot.entries()) {
      if (!activeSessions.has(sessionId)) continue; // Phiên đã bị đóng trong lúc chờ DB
      if (session.state === 'CLOSED') continue; // Chặn late response hồi sinh session

      session.lastLeaseRenewNs = nowNs;
      aliveSessionIds.push(sessionId);
      const user = userMap.get(session.userId);

      if (!user || !user.is_active || user.role !== 'ADMIN' || Number(user.session_version) !== Number(session.sessionVersion)) {
        console.warn(`🔒 [BASTION REVOCATION] Thu hồi phiên ${sessionId} của user ${session.userId} do vi phạm trạng thái tài khoản CSDL`);
        session.cleanupFn(4403, 'Session Revoked', 'Phiên làm việc đã bị quản trị viên thu hồi hoặc bạn đã đăng xuất');
      }
    }

    if (aliveSessionIds.length > 0) {
      query(
        `UPDATE bastion_session_leases
         SET lease_expires_at = (NOW() AT TIME ZONE 'UTC') + INTERVAL '10 seconds'
         WHERE session_id = ANY($1::uuid[]) AND status = 'ACTIVE';`,
        [aliveSessionIds]
      ).catch((leaseErr) => {
        console.warn('⚠️ [BASTION LEASE RENEW ERROR]:', leaseErr.message);
      });
    }
  } catch (err: any) {
    console.warn('⚠️ [BASTION SESSION CHECKER] Lỗi truy vấn CSDL trong batch check:', err.message);
  } finally {
    isCheckingDb = false;
  }
}

// A hung query cannot hold sessions open: check the monotonic 4800ms deadline every 200ms.
const DB_WATCHDOG_DEADLINE_MS = 4800;
function checkSessionDeadlines(): void {
  if (activeSessions.size === 0) return;
  const nowNs = process.hrtime.bigint();
  for (const [sessionId, session] of activeSessions.entries()) {
    if (session.state === 'CLOSED') continue;
    const elapsedMs = Number((nowNs - session.lastLeaseRenewNs) / 1_000_000n);
    if (elapsedMs >= DB_WATCHDOG_DEADLINE_MS) {
      console.error(`🚨 [BASTION DB DEADLINE EXCEEDED] Đóng phiên ${sessionId} vì mất kết nối CSDL quá deadline (thực tế: ${elapsedMs}ms, trần SLA 5.2s)`);
      session.cleanupFn(4503, 'DB Deadline Exceeded', 'Mất kết nối kiểm tra an ninh cơ sở dữ liệu quá thời hạn cho phép');
    }
  }
}

export function startSessionMaintenance(): void {
  if (sessionCheckerInterval || independentWatchdogInterval) return;
  maintenanceGeneration++;
  sessionCheckerInterval = setInterval(checkSessions, 2000);
  independentWatchdogInterval = setInterval(checkSessionDeadlines, 200);
  sessionCheckerInterval.unref();
  independentWatchdogInterval.unref();
}

export function stopSessionMaintenance(): void {
  maintenanceGeneration++;
  if (sessionCheckerInterval) clearInterval(sessionCheckerInterval);
  if (independentWatchdogInterval) clearInterval(independentWatchdogInterval);
  sessionCheckerInterval = null;
  independentWatchdogInterval = null;
  // Keep the in-flight guard until the pending query settles, including across restart.
}

export function shutdownAllBastionSessions(): void {
  console.log(`🛑 [BASTION SHUTDOWN] Đang đóng an toàn ${activeSessions.size} phiên Web SSH...`);
  for (const session of activeSessions.values()) {
    session.cleanupFn(1001, 'Gateway Shutting Down', 'Máy chủ Gateway đang bảo trì khởi động lại');
  }
  activeSessions.clear();
}
