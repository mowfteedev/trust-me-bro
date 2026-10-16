import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { query } from '../services/db.js';

export const AUDIT_ACTIONS = [
  'LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT_SUCCESS', 'BASTION_TICKET_ISSUED',
  'BASTION_SESSION_START', 'BASTION_SESSION_END', 'CPU_HIGH', 'NODE_OFFLINE',
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
  if (action === 'LOGIN_FAILED' && typeof values.attempted_username === 'string') {
    result.attempted_username = values.attempted_username.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 50);
  }
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
  return result;
}

export const auditRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/logs', { preHandler: [authenticate, authorize(['ADMIN'])] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = AuditQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        status: 400, code: 'INVALID_AUDIT_QUERY', title: 'Bộ lọc nhật ký không hợp lệ',
        detail: 'Trang phải từ 1 đến 10000, loại sự kiện hợp lệ và tìm kiếm tối đa 100 ký tự.',
      });
    }

    const { page, action, q } = parsed.data;
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
        OR n.name ILIKE ${placeholder} ESCAPE '!'
        OR host(a.ip_address) ILIKE ${placeholder} ESCAPE '!'
        OR host(n.ip_address) ILIKE ${placeholder} ESCAPE '!'
        OR a.target ILIKE ${placeholder} ESCAPE '!')`);
    }
    params.push(PAGE_SIZE + 1, (page - 1) * PAGE_SIZE);

    try {
      const result = await query<AuditLogItem>(`
        SELECT a.id, a.created_at, a.action, a.user_id, u.username,
          COALESCE(a.node_id, n.id) AS node_id, n.name AS node_name,
          host(a.ip_address) AS ip_address, a.target,
          jsonb_build_object(
            'session_id', a.details->'session_id', 'reason', a.details->'reason',
            'target_ip', a.details->'target_ip', 'message', a.details->'message',
            'cpu_percent', a.details->'cpu_percent', 'threshold', a.details->'threshold',
            'ip', a.details->'ip', 'last_seen', a.details->'last_seen',
            'attempted_username', a.details->'attempted_username'
          ) AS details
        FROM audit_logs a
        LEFT JOIN users u ON u.id = a.user_id
        -- Legacy Bastion rows stored the node identifier only inside JSON.
        -- Compare text rather than casting untrusted historical JSON to UUID.
        LEFT JOIN nodes n ON n.id::text = COALESCE(a.node_id::text, a.details->>'node_id')
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length};`, params);

      return {
        success: true,
        data: result.rows.slice(0, PAGE_SIZE).map((row) => ({
          id: row.id, created_at: row.created_at, action: row.action,
          user_id: row.user_id, username: row.username, node_id: row.node_id,
          node_name: row.node_name, ip_address: row.ip_address, target: row.target,
          details: safeDetails(row.details, row.action),
        })),
        page, page_size: PAGE_SIZE, has_more: result.rows.length > PAGE_SIZE,
      };
    } catch (err) {
      req.log.error({ err }, 'Không thể đọc nhật ký kiểm toán');
      return reply.status(503).send({
        status: 503, code: 'AUDIT_UNAVAILABLE', title: 'Nhật ký tạm thời không khả dụng',
        detail: 'Không thể tải nhật ký lúc này. Vui lòng thử lại sau.',
      });
    }
  });
};
