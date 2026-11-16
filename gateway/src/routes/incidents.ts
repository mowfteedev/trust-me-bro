import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { query } from '../services/db.js';
import { sendSpreadsheet } from '../services/spreadsheet-export.js';
import { exportTimestamp, MAX_EXPORT_ROWS } from '../utils/xlsx.js';

const filters = z.object({
  state: z.enum(['open', 'resolved', 'all']).default('open'),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  node_id: z.string().uuid().optional(),
}).strict();

export const incidentsRoutes: FastifyPluginAsync = async fastify => {
  fastify.get('/export', { preHandler: [authenticate, authorize(['ADMIN', 'VIEWER'])] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = filters.omit({ page: true, page_size: true }).strict().safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_INCIDENT_FILTER', detail: 'Bộ lọc xuất sự cố không hợp lệ.' });
    const { state, node_id } = parsed.data;
    return sendSpreadsheet(reply, req.user.id, 'incidents', async () => {
      const result = await query(`SELECT a.id, a.node_id, n.name AS node_name,
          host(n.ip_address) AS ip_address, a.severity, a.message,
          a.triggered_at AS created_at, a.resolved_at,
          GREATEST(0, floor(EXTRACT(EPOCH FROM (COALESCE(a.resolved_at, now()) - a.triggered_at))))::int AS duration_seconds,
          (SELECT d.status FROM alert_notifications d WHERE d.alert_id = a.id AND d.phase = 'OPEN') AS opening_status,
          (SELECT d.status FROM alert_notifications d WHERE d.alert_id = a.id AND d.phase = 'RECOVERY') AS recovery_status
        FROM alerts a JOIN nodes n ON n.id = a.node_id
        WHERE ($1 = 'all' OR ($1 = 'open' AND a.resolved_at IS NULL)
          OR ($1 = 'resolved' AND a.resolved_at IS NOT NULL))
          AND ($2::uuid IS NULL OR a.node_id = $2::uuid)
        ORDER BY a.triggered_at DESC, a.id DESC LIMIT $3;`, [state, node_id ?? null, MAX_EXPORT_ROWS + 1]);
      return {
        name: 'Sự cố', headers: ['ID', 'ID máy chủ', 'Máy chủ', 'IP WireGuard', 'Mức độ', 'Nội dung',
          'Bắt đầu (UTC+7)', 'Phục hồi (UTC+7)', 'Trạng thái', 'Thời gian (giây)', 'Gửi cảnh báo', 'Gửi phục hồi'],
        rows: result.rows.map(row => [row.id, row.node_id, row.node_name, row.ip_address, row.severity, row.message,
          exportTimestamp(row.created_at), exportTimestamp(row.resolved_at), row.resolved_at ? 'Đã phục hồi' : 'Đang mở',
          row.duration_seconds, row.opening_status, row.recovery_status]),
      };
    });
  });
  fastify.get('/', { preHandler: [authenticate, authorize(['ADMIN', 'VIEWER'])] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = filters.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_INCIDENT_FILTER', detail: 'Bộ lọc sự cố không hợp lệ.' });
    const { state, page, page_size, node_id } = parsed.data;
    try {
      const result = await query(
        `WITH selected AS (
          SELECT a.*, n.name AS node_name, host(n.ip_address) AS ip_address
          FROM alerts a JOIN nodes n ON n.id = a.node_id
          WHERE ($1 = 'all' OR ($1 = 'open' AND a.resolved_at IS NULL)
            OR ($1 = 'resolved' AND a.resolved_at IS NOT NULL))
            AND ($2::uuid IS NULL OR a.node_id = $2::uuid)
        ), page_rows AS (
          SELECT * FROM selected ORDER BY triggered_at DESC, id DESC LIMIT $3 OFFSET $4
        ), paged AS (
          SELECT a.id, a.node_id, a.node_name, a.ip_address,
            CASE WHEN a.message LIKE 'NODE_OFFLINE:%' THEN 'NODE_OFFLINE'
                 WHEN a.message LIKE 'CPU_HIGH:%' THEN 'CPU_HIGH' ELSE 'OTHER' END AS type,
            a.severity, a.message, a.triggered_at AS created_at, a.resolved_at,
            GREATEST(0, floor(EXTRACT(EPOCH FROM (COALESCE(a.resolved_at, now()) - a.triggered_at))))::int AS duration_seconds,
            (SELECT json_build_object('status', d.status, 'attempts', d.attempts,
              'last_attempt_at', d.last_attempt_at, 'last_error', d.last_error)
             FROM alert_notifications d WHERE d.alert_id = a.id AND d.phase = 'OPEN') AS opening_delivery,
            (SELECT json_build_object('status', d.status, 'attempts', d.attempts,
              'last_attempt_at', d.last_attempt_at, 'last_error', d.last_error)
             FROM alert_notifications d WHERE d.alert_id = a.id AND d.phase = 'RECOVERY') AS recovery_delivery
          FROM page_rows a
        ) SELECT COALESCE((SELECT json_agg(paged ORDER BY created_at DESC, id DESC) FROM paged), '[]'::json) AS data,
          (SELECT count(*)::int FROM selected) AS total;`,
        [state, node_id ?? null, page_size, (page - 1) * page_size],
      );
      const { data, total } = result.rows[0];
      return { success: true, data, pagination: { page, page_size, total, total_pages: Math.ceil(total / page_size) } };
    } catch {
      req.log.error('Không thể tải danh sách sự cố');
      return reply.code(503).send({ code: 'INCIDENTS_UNAVAILABLE', detail: 'Không thể tải sự cố. Vui lòng thử lại.' });
    }
  });
};
