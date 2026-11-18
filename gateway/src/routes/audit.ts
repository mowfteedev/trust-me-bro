import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { query } from '../services/db.js';
import { sendSpreadsheet } from '../services/spreadsheet-export.js';
import { exportTimestamp, MAX_EXPORT_ROWS } from '../utils/xlsx.js';

export const AUDIT_ACTIONS = [
  'LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT_SUCCESS', 'BASTION_TICKET_ISSUED',
  'BASTION_SESSION_START', 'BASTION_SESSION_END', 'CPU_HIGH', 'NODE_OFFLINE',
  'TELEGRAM_TEST', 'AUDIT_PURGED',
  'CPU_RECOVERED', 'USER_CREATED', 'USER_UPDATED', 'USER_PASSWORD_RESET', 'PASSWORD_CHANGED', 'WORKER_ENROLLED',
  'WORKER_OFFBOARD_STARTED', 'WORKER_PEER_REVOKED', 'WORKER_OFFBOARDED',
] as const;

const PAGE_SIZE = 25;
const AuditQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  action: z.enum(AUDIT_ACTIONS).optional(),
  q: z.string().trim().max(100).optional(),
});

export interface AuditLogDetails {
  attempted_username?: string;
  session_id?: string;
  reason?: string;
  target_ip?: string;
  message?: string;
  cpu_percent?: number;
  threshold?: number;
  ip?: string;
  last_seen?: string | null;
  dry_run?: boolean;
  result?: string;
  role?: string;
  deleted_count?: number;
  cutoff_time?: string;
  retention?: string;
  username?: string;
  is_active?: boolean;
  scope?: 'current' | 'all';
  node_type?: 'VM' | 'BARE_METAL';
  worker_os?: 'linux' | 'windows';
  operation_id?: string;
  wireguard_public_key?: string;
  receipt_hash?: string;
  reported_status?: string;
}

export interface AuditLogItem {
  id: string;
  created_at: string | Date;
  action: string;
  user_id: string | null;
  username: string | null;
  node_id: string | null;
  node_name: string | null;
  ip_address: string | null;
  target: string | null;
  details: AuditLogDetails;
}

const detailLimits = { session_id: 96, reason: 160, target_ip: 64, message: 500 } as const;
const DetailIp = z.string().max(64).ip();
const DetailTimestamp = z.string().max(64).datetime({ offset: true });

// Return only known display fields: old audit JSON may contain user agents or secrets.
function safeDetails(raw: unknown, action: string): AuditLogDetails {
  const result: AuditLogItem['details'] = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const key of Object.keys(detailLimits) as (keyof typeof detailLimits)[]) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string') result[key] = value.slice(0, detailLimits[key]);
  }
  const values = raw as Record<string, unknown>;
  if (action === 'WORKER_ENROLLED') {
    if (values.node_type === 'VM' || values.node_type === 'BARE_METAL') result.node_type = values.node_type;
    if (values.worker_os === 'linux' || values.worker_os === 'windows') result.worker_os = values.worker_os;
  }
  if (['WORKER_OFFBOARD_STARTED', 'WORKER_PEER_REVOKED', 'WORKER_OFFBOARDED'].includes(action)) {
    if (typeof values.operation_id === 'string' && /^[0-9a-f-]{36}$/i.test(values.operation_id)) {
      result.operation_id = values.operation_id;
    }
    if (typeof values.wireguard_public_key === 'string' && values.wireguard_public_key.length <= 64) {
      result.wireguard_public_key = values.wireguard_public_key;
    }
    if (typeof values.receipt_hash === 'string' && /^[0-9a-f]{64}$/.test(values.receipt_hash)) {
      result.receipt_hash = values.receipt_hash;
    }
    if (typeof values.reported_status === 'string') {
      result.reported_status = values.reported_status.slice(0, 32);
    }
  }
  if (action === 'LOGIN_FAILED' && typeof values.attempted_username === 'string') {
    result.attempted_username = values.attempted_username.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 50);
  }
  if (['USER_CREATED', 'USER_UPDATED', 'USER_PASSWORD_RESET', 'PASSWORD_CHANGED'].includes(action)) {
    if (typeof values.username === 'string') result.username = values.username.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 50);
    if (typeof values.is_active === 'boolean') result.is_active = values.is_active;
  }
  if (action === 'LOGOUT_SUCCESS' && (values.scope === 'current' || values.scope === 'all')) result.scope = values.scope;
  for (const key of ['cpu_percent', 'threshold'] as const) {
    const value = values[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) {
      result[key] = value;
    }
  }
  if (DetailIp.safeParse(values.ip).success) result.ip = values.ip as string;
  if (DetailTimestamp.safeParse(values.last_seen).success) {
    result.last_seen = values.last_seen as string;
  } else if (action === 'NODE_OFFLINE' && values.last_seen === null) {
    result.last_seen = null;
  }
  if (typeof values.dry_run === 'boolean') {
    result.dry_run = values.dry_run;
  }
  if (typeof values.result === 'string') {
    result.result = values.result.slice(0, 100);
  }
  if (typeof values.role === 'string') {
    result.role = values.role.slice(0, 20);
  }
  if (typeof values.deleted_count === 'number' && Number.isFinite(values.deleted_count)) {
    result.deleted_count = values.deleted_count;
  }
  if (typeof values.cutoff_time === 'string') {
    result.cutoff_time = values.cutoff_time.slice(0, 64);
  }
  if (typeof values.retention === 'string') {
    result.retention = values.retention.slice(0, 32);
  }
  return result;
}


async function readAuditRows(action: typeof AUDIT_ACTIONS[number] | undefined, q: string | undefined,
  limit: number, offset: number) {
    const params: (string | number)[] = [];
    const filters: string[] = [];
    if (action) {
      params.push(action);
      filters.push(`a.action = $${params.length}`);
    }
    if (q) {
      // Use an explicit escape character so %, _ and ! in a search are literal.
      params.push(`%${q.replace(/[!%_]/g, (character) => `!${character}`)}%`);
      const placeholder = `$${params.length}`;
      filters.push(`(u.username ILIKE ${placeholder} ESCAPE '!'
        OR (a.action = 'LOGIN_FAILED' AND a.details->>'attempted_username' ILIKE ${placeholder} ESCAPE '!')
        OR (a.action IN ('USER_CREATED','USER_UPDATED','USER_PASSWORD_RESET','PASSWORD_CHANGED')
          AND a.details->>'username' ILIKE ${placeholder} ESCAPE '!')
        OR n.name ILIKE ${placeholder} ESCAPE '!'
        OR host(a.ip_address) ILIKE ${placeholder} ESCAPE '!'
        OR host(n.ip_address) ILIKE ${placeholder} ESCAPE '!'
        OR a.target ILIKE ${placeholder} ESCAPE '!')`);
    }

  params.push(limit, offset);
      const result = await query<AuditLogItem>(`
        SELECT a.id, a.created_at, a.action, a.user_id, u.username,
          COALESCE(a.node_id, n.id) AS node_id, n.name AS node_name,
          host(a.ip_address) AS ip_address, a.target,
          jsonb_build_object(
            'session_id', a.details->'session_id', 'reason', a.details->'reason',
            'target_ip', a.details->'target_ip', 'message', a.details->'message',
            'cpu_percent', a.details->'cpu_percent', 'threshold', a.details->'threshold',
            'ip', a.details->'ip', 'last_seen', a.details->'last_seen',
            'attempted_username', a.details->'attempted_username',
            'dry_run', a.details->'dry_run', 'result', a.details->'result',
            'role', a.details->'role',
            'username', a.details->'username', 'is_active', a.details->'is_active',
            'scope', a.details->'scope',
            'node_type', a.details->'node_type', 'worker_os', a.details->'worker_os',
            'operation_id', a.details->'operation_id', 'wireguard_public_key', a.details->'wireguard_public_key',
            'receipt_hash', a.details->'receipt_hash', 'reported_status', a.details->'reported_status',
            'deleted_count', a.details->'deleted_count',
            'cutoff_time', a.details->'cutoff_time',
            'retention', a.details->'retention'
          ) AS details
        FROM audit_logs a
        LEFT JOIN users u ON u.id = a.user_id
        -- Legacy Bastion rows stored the node identifier only inside JSON.
        -- Compare text rather than casting untrusted historical JSON to UUID.
        LEFT JOIN nodes n ON n.id::text = COALESCE(a.node_id::text, a.details->>'node_id')
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length};`, params);
  return result.rows.map(row => ({
    id: row.id, created_at: row.created_at, action: row.action,
    user_id: row.user_id, username: row.username, node_id: row.node_id,
    node_name: row.node_name, ip_address: row.ip_address, target: row.target,
    details: safeDetails(row.details, row.action),
  }));
}

export const auditRoutes: FastifyPluginAsync = async fastify => {
  fastify.get('/logs', { preHandler: [authenticate, authorize(['ADMIN', 'VIEWER'])] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = AuditQuery.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ status: 400, code: 'INVALID_AUDIT_QUERY',
      title: 'Bộ lọc nhật ký không hợp lệ', detail: 'Trang phải từ 1 đến 10000, loại sự kiện hợp lệ và tìm kiếm tối đa 100 ký tự.' });
    const { page, action, q } = parsed.data;
    try {
      const rows = await readAuditRows(action, q, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE);
      return { success: true, data: rows.slice(0, PAGE_SIZE), page, page_size: PAGE_SIZE, has_more: rows.length > PAGE_SIZE };
    } catch {
      req.log.error('Không thể đọc nhật ký kiểm toán');
      return reply.status(503).send({ status: 503, code: 'AUDIT_UNAVAILABLE', title: 'Nhật ký tạm thời không khả dụng',
        detail: 'Không thể tải nhật ký lúc này. Vui lòng thử lại sau.' });
    }
  });

  fastify.get('/logs/export', { preHandler: [authenticate, authorize(['ADMIN', 'VIEWER'])] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = AuditQuery.omit({ page: true }).strict().safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_AUDIT_QUERY', detail: 'Bộ lọc xuất nhật ký không hợp lệ.' });
    return sendSpreadsheet(reply, req.user.id, 'audit-logs', async () => {
      const rows = await readAuditRows(parsed.data.action, parsed.data.q, MAX_EXPORT_ROWS + 1, 0);
      return {
        name: 'Nhật ký',
        headers: ['ID', 'Thời điểm (UTC+7)', 'Sự kiện', 'ID người dùng', 'Người thực hiện',
          'ID máy chủ', 'Máy chủ', 'IP truy cập', 'Đối tượng', 'Chi tiết'],
        rows: rows.map(row => [row.id, exportTimestamp(row.created_at), row.action, row.user_id, row.username,
          row.node_id, row.node_name, row.ip_address, row.target, JSON.stringify(row.details)]),
      };
    });
  });
};
