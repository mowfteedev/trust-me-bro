import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { query } from '../services/db.js';

export const AUDIT_ACTIONS = [
  'LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT_SUCCESS', 'BASTION_TICKET_ISSUED',
  'BASTION_SESSION_START', 'BASTION_SESSION_END', 'CPU_HIGH', 'NODE_OFFLINE',
  'TELEGRAM_TEST', 'AUDIT_PURGED',
  'CPU_RECOVERED', 'USER_CREATED', 'USER_UPDATED', 'USER_PASSWORD_RESET', 'PASSWORD_CHANGED',
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

export const auditRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/logs', { preHandler: [authenticate, authorize(['ADMIN', 'VIEWER'])] }, async (req, reply) => {
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
        OR (a.action IN ('USER_CREATED','USER_UPDATED','USER_PASSWORD_RESET','PASSWORD_CHANGED')
          AND a.details->>'username' ILIKE ${placeholder} ESCAPE '!')
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
            'attempted_username', a.details->'attempted_username',
            'dry_run', a.details->'dry_run', 'result', a.details->'result',
            'role', a.details->'role',
            'username', a.details->'username', 'is_active', a.details->'is_active',
            'scope', a.details->'scope',
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

  const PurgeSchema = z.object({
    retention: z.enum(['1d', '7d', '30d']).default('7d'),
  });

  const RETENTION_INTERVAL_MAP: Record<'1d' | '7d' | '30d', string> = {
    '1d': '1 day',
    '7d': '7 days',
    '30d': '30 days',
  };

  const RETENTION_LABEL_MAP: Record<'1d' | '7d' | '30d', string> = {
    '1d': 'Giữ 1 ngày gần nhất',
    '7d': 'Giữ 7 ngày gần nhất',
    '30d': 'Giữ 30 ngày gần nhất',
  };

  interface PurgePreviewRow {
    cutoff_time: string | Date;
    records_to_delete: string | number;
    records_to_keep: string | number;
    total_records: string | number;
  }

  // Xem trước số lượng bản ghi dự kiến dọn dẹp (chỉ đọc, chỉ ADMIN)
  fastify.get('/logs/purge-preview', { preHandler: [authenticate, authorize(['ADMIN'])] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = PurgeSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        status: 400,
        code: 'INVALID_RETENTION',
        title: 'Khoảng thời gian lưu trữ không hợp lệ',
        detail: 'Chỉ chấp nhận các mốc thời gian: 1d (1 ngày), 7d (7 ngày) hoặc 30d (30 ngày).',
      });
    }

    const { retention } = parsed.data;
    const intervalStr = RETENTION_INTERVAL_MAP[retention];

    try {
      const result = await query<PurgePreviewRow>(
        `SELECT
           ((now() AT TIME ZONE 'UTC') - $1::interval) AS cutoff_time,
           COUNT(*) FILTER (WHERE created_at < ((now() AT TIME ZONE 'UTC') - $1::interval))::int AS records_to_delete,
           COUNT(*) FILTER (WHERE created_at >= ((now() AT TIME ZONE 'UTC') - $1::interval))::int AS records_to_keep,
           COUNT(*)::int AS total_records
         FROM public.audit_logs;`,
        [intervalStr]
      );

      const row = result.rows[0];
      const recordsToDelete = Number(row?.records_to_delete ?? 0);
      const recordsToKeep = Number(row?.records_to_keep ?? 0);
      const totalRecords = Number(row?.total_records ?? 0);
      const cutoffTime = row?.cutoff_time instanceof Date
        ? row.cutoff_time.toISOString()
        : (row?.cutoff_time ? new Date(row.cutoff_time).toISOString() : new Date().toISOString());

      return reply.status(200).send({
        success: true,
        retention,
        retention_label: RETENTION_LABEL_MAP[retention],
        cutoff_time: cutoffTime,
        records_to_delete: recordsToDelete,
        records_to_keep: recordsToKeep,
        total_records: totalRecords,
        can_purge: recordsToDelete > 0,
      });
    } catch (err) {
      req.log.error({ err }, 'Không thể tính toán xem trước dọn nhật ký');
      return reply.status(503).send({
        status: 503,
        code: 'AUDIT_PREVIEW_FAILED',
        title: 'Xem trước dọn nhật ký tạm thời không khả dụng',
        detail: 'Không thể tính toán dữ liệu xem trước lúc này. Vui lòng thử lại sau.',
      });
    }
  });

  fastify.delete('/logs', { preHandler: [authenticate, authorize(['ADMIN'])] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const rawPayload = {
      ...((req.query && typeof req.query === 'object') ? req.query : {}),
      ...((req.body && typeof req.body === 'object') ? req.body : {}),
    };
    const parsed = PurgeSchema.safeParse(rawPayload);
    if (!parsed.success) {
      return reply.status(400).send({
        status: 400,
        code: 'INVALID_RETENTION',
        title: 'Khoảng thời gian lưu trữ không hợp lệ',
        detail: 'Chỉ chấp nhận các mốc thời gian: 1d (1 ngày), 7d (7 ngày) hoặc 30d (30 ngày).',
      });
    }

    const { retention } = parsed.data;
    const intervalStr = RETENTION_INTERVAL_MAP[retention];

    try {
      const user = req.user as { id?: string } | undefined;
      const result = await query<{ deleted_count: number }>(
        `SELECT public.purge_audit_logs($1::interval, $2, $3::inet) AS deleted_count;`,
        [intervalStr, user?.id || null, req.ip || null]
      );
      const deletedCount = Number(result.rows[0]?.deleted_count ?? 0);

      const message = deletedCount > 0
        ? `Đã dọn dẹp thành công ${deletedCount} bản ghi nhật ký (${RETENTION_LABEL_MAP[retention]}).`
        : `Không có bản ghi nhật ký nào cũ hơn mốc ${RETENTION_LABEL_MAP[retention]} để dọn dẹp.`;

      return reply.status(200).send({
        success: true,
        deleted_count: deletedCount,
        retention,
        retention_label: RETENTION_LABEL_MAP[retention],
        message,
      });
    } catch (err) {
      req.log.error({ err }, 'Không thể dọn dẹp nhật ký kiểm toán');
      return reply.status(503).send({
        status: 503,
        code: 'AUDIT_PURGE_FAILED',
        title: 'Dọn dẹp nhật ký tạm thời không khả dụng',
        detail: 'Không thể xóa nhật ký lúc này. Vui lòng kiểm tra quyền hệ thống hoặc thử lại sau.',
      });
    }
  });
};
