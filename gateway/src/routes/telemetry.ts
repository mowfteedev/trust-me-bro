import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { query, getClient } from '../services/db.js';
import { hashToken, timingSafeCompare } from '../utils/crypto.js';
import { authenticate } from '../middlewares/auth.middleware.js';

/**
 * ==============================================================================
 * CỔNG TIẾP NHẬN DỮ LIỆU ĐO XA TELEMETRY INGESTION (telemetry.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: backend (chủ trì), security, database
 * ==============================================================================
 *
 * LÝ DO PHI TRỰC GIÁC (RATIONALE):
 * 1. Tra cứu Node qua chỉ mục B-Tree UNIQUE Index trên token_hash với truy vấn điểm:
 *    WHERE token_hash = $1 LIMIT 1, đạt độ phức tạp O(1) và thời gian thực thi < 1ms,
 *    loại trừ hoàn toàn việc tải toàn bộ bảng lên RAM quét vòng lặp (BUG-001).
 * 2. So sánh chuỗi băm bằng timingSafeCompare để chống Timing Attacks (BUG-002).
 * 3. Hỗ trợ linh hoạt cả hai định dạng tải trọng: lồng nhau chuẩn contracts/telemetry.schema.json
 *    và định dạng phẳng, tự động chuẩn hóa rx_bytes_total/rx_bytes.
 * 4. Ghi trực tiếp vào bảng phân vùng metrics_history theo đúng lược đồ cột ram_* và disk_*.
 */

// Schema kiểm thực tải trọng chuẩn sau khi đã chuẩn hóa
const NormalizedBeaconSchema = z.object({
  node_id: z.string().min(3).max(64),
  timestamp: z.number().int().positive(),
  cpu: z.object({
    percent: z.number().min(0).max(100),
    load_avg: z.array(z.number()).length(3).optional().default([0, 0, 0]),
  }),
  memory: z.object({
    total_bytes: z.number().int().positive(),
    used_bytes: z.number().int().nonnegative(),
    percent: z.number().min(0).max(100),
  }),
  disk: z.object({
    total_bytes: z.number().int().positive(),
    used_bytes: z.number().int().nonnegative(),
    percent: z.number().min(0).max(100),
  }),
  network: z.object({
    rx_bytes: z.number().int().nonnegative(),
    tx_bytes: z.number().int().nonnegative(),
  }),
  uptime_seconds: z.number().int().nonnegative().default(0),
});

/**
 * Hàm tiền xử lý chuẩn hóa tải trọng nhận được từ Worker Agent hoặc Mock Nodes
 */
function normalizePayload(raw: any) {
  if (!raw || typeof raw !== 'object') return raw;

  // Trường hợp tải trọng chuẩn lồng trong 'metrics' (telemetry.schema.json)
  if (raw.metrics && typeof raw.metrics === 'object') {
    const m = raw.metrics;
    return {
      node_id: raw.node_id,
      timestamp: raw.timestamp || Date.now(),
      cpu: m.cpu,
      memory: m.memory,
      disk: m.disk,
      network: {
        rx_bytes: m.network?.rx_bytes_total ?? m.network?.rx_bytes ?? 0,
        tx_bytes: m.network?.tx_bytes_total ?? m.network?.tx_bytes ?? 0,
      },
      uptime_seconds: m.uptime_seconds ?? 0,
    };
  }

  // Trường hợp tải trọng phẳng ở root
  return {
    node_id: raw.node_id,
    timestamp: raw.timestamp || Date.now(),
    cpu: raw.cpu,
    memory: raw.memory,
    disk: raw.disk,
    network: {
      rx_bytes: raw.network?.rx_bytes_total ?? raw.network?.rx_bytes ?? 0,
      tx_bytes: raw.network?.tx_bytes_total ?? raw.network?.tx_bytes ?? 0,
    },
    uptime_seconds: raw.uptime_seconds ?? 0,
  };
}

export const telemetryRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * Bộ xử lý cốt lõi cho tuyến Telemetry Beacon
   */
  const handleBeacon = async (req: any, reply: any) => {
    // 1. Kiểm tra header X-Node-Token
    const rawToken = req.headers['x-node-token'] as string | undefined;
    if (!rawToken || typeof rawToken !== 'string' || rawToken.trim() === '') {
      return reply.status(401).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Thiếu mã xác thực máy chủ con',
        status: 401,
        code: 'MISSING_NODE_TOKEN',
        detail: 'Yêu cầu cung cấp header X-Node-Token hợp lệ',
      });
    }

    // 2. Băm SHA-256 token đầu vào
    const inputHash = hashToken(rawToken.trim());

    try {
      // 3. Tra cứu điểm chính xác qua chỉ mục B-Tree UNIQUE Index (Tốc độ O(1), < 1ms)
      const nodeRes = await query(
        'SELECT id, name, ip_address, token_hash, status, is_token_revoked FROM nodes WHERE token_hash = $1 LIMIT 1;',
        [inputHash]
      );

      if (nodeRes.rows.length === 0) {
        // Kiểm tra xem có node nào mang token_prefix này mà đã bị revoked không (N04 REMEDIATION)
        const prefix = rawToken.trim().slice(0, 8);
        const revokedCheck = await query(
          "SELECT id FROM nodes WHERE token_prefix = $1 AND (is_token_revoked = TRUE OR token_hash LIKE 'REVOKED_%' OR status = 'REVOKED') LIMIT 1;",
          [prefix]
        );
        if (revokedCheck.rows.length > 0) {
          return reply.status(401).send({
            type: 'https://tools.ietf.org/html/rfc7807',
            title: 'Mã xác thực đã bị thu hồi',
            status: 401,
            code: 'REVOKED_NODE_TOKEN',
            detail: 'Mã token của máy chủ con này đã bị vô hiệu hóa hoặc thu hồi',
          });
        }

        return reply.status(401).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Mã xác thực không hợp lệ',
          status: 401,
          code: 'INVALID_NODE_TOKEN',
          detail: 'Không tìm thấy máy chủ con tương ứng với mã token được cung cấp',
        });
      }

      const node = nodeRes.rows[0];

      if (node.is_token_revoked || node.token_hash?.startsWith('REVOKED_') || node.status === 'REVOKED') {
        return reply.status(401).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Mã xác thực đã bị thu hồi',
          status: 401,
          code: 'REVOKED_NODE_TOKEN',
          detail: 'Mã token của máy chủ con này đã bị vô hiệu hóa hoặc thu hồi',
        });
      }

      // 4. So sánh bất biến thời gian chống Timing Attack (BUG-002)
      const isTokenSafe = timingSafeCompare(node.token_hash, inputHash);
      if (!isTokenSafe) {
        return reply.status(401).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Xác thực thất bại',
          status: 401,
          code: 'TOKEN_VERIFICATION_FAILED',
          detail: 'Xác thực token bất biến thời gian thất bại',
        });
      }

      // 5. Chuẩn hóa và kiểm thực tính hợp lệ của gói tin JSON
      const normalizedData = normalizePayload(req.body);
      const parseResult = NormalizedBeaconSchema.safeParse(normalizedData);
      if (!parseResult.success) {
        return reply.status(400).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Tải trọng không đúng định dạng',
          status: 400,
          code: 'INVALID_TELEMETRY_PAYLOAD',
          detail: 'Dữ liệu đo xa vi phạm hợp đồng JSON Schema',
          errors: parseResult.error.errors,
        });
      }

      const beacon = parseResult.data;

      // 6. Ràng buộc bảo mật Anti-IDOR: node_id trong gói tin phải trùng với bản ghi sở hữu token
      if (beacon.node_id !== node.name && beacon.node_id !== node.id) {
        return reply.status(403).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Vi phạm quyền sở hữu danh tính (Anti-IDOR)',
          status: 403,
          code: 'IDOR_MISMATCH',
          detail: `Node ID '${beacon.node_id}' không trùng khớp với mã token đã được cấp phát cho '${node.name}'`,
        });
      }

      // 7. Ghi nhận số liệu và cập nhật Liveness trong 1 ACID Transaction duy nhất
      const client = await getClient();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO metrics_history (
            node_id,
            cpu_percent,
            ram_used_bytes,
            ram_total_bytes,
            ram_percent,
            disk_used_bytes,
            disk_total_bytes,
            disk_percent,
            network_rx_bytes,
            network_tx_bytes,
            uptime_seconds,
            recorded_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, (now() AT TIME ZONE 'UTC')
          );`,
          [
            node.id,
            beacon.cpu.percent,
            beacon.memory.used_bytes,
            beacon.memory.total_bytes,
            beacon.memory.percent,
            beacon.disk.used_bytes,
            beacon.disk.total_bytes,
            beacon.disk.percent,
            beacon.network.rx_bytes,
            beacon.network.tx_bytes,
            beacon.uptime_seconds,
          ]
        );

        await client.query(
          `UPDATE nodes
           SET status = 'HEALTHY', last_seen = (now() AT TIME ZONE 'UTC'), updated_at = (now() AT TIME ZONE 'UTC')
           WHERE id = $1;`,
          [node.id]
        );
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }

      return reply.status(200).send({
        success: true,
        node_id: node.name,
        status: 'HEALTHY',
        recorded_at: new Date().toISOString(),
      });
    } catch (err: any) {
      req.log.error({ err }, 'Lỗi trong luồng tiếp nhận Telemetry Beacon');
      return reply.status(500).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Lỗi xử lý số liệu',
        status: 500,
        code: 'INTERNAL_SERVER_ERROR',
        detail: 'Không thể ghi nhận số liệu đo xa vào cơ sở dữ liệu: ' + (err.message || 'Lỗi không xác định'),
      });
    }
  };

  /**
   * Đăng ký đồng thời cả 2 đường dẫn để không bao giờ bị 404
   * 1. POST /api/telemetry/beacon
   * 2. POST /api/telemetry
   */
  fastify.post('/beacon', handleBeacon);
  fastify.post('/', handleBeacon);

  /**
   * GET /api/telemetry/nodes
   * Lấy danh sách tất cả các Endpoint Hosts kèm số liệu tài nguyên mới nhất (Realtime Lateral Join)
   */
  fastify.get('/nodes', { preHandler: [authenticate] }, async (req, reply) => {
    const nodesRes = await query(
      `SELECT n.id, n.name, n.ip_address, n.node_type, n.status, n.last_seen, n.created_at,
              m.cpu_percent,
              m.ram_used_bytes, m.ram_total_bytes, m.ram_percent,
              m.ram_used_bytes AS memory_used_bytes, m.ram_total_bytes AS memory_total_bytes,
              m.disk_used_bytes, m.disk_total_bytes, m.disk_percent
       FROM nodes n
       LEFT JOIN LATERAL (
         SELECT mh.cpu_percent, mh.ram_used_bytes, mh.ram_total_bytes, mh.ram_percent,
                mh.disk_used_bytes, mh.disk_total_bytes, mh.disk_percent
         FROM metrics_history mh
         WHERE mh.node_id = n.id
         ORDER BY mh.recorded_at DESC
         LIMIT 1
       ) m ON true
       ORDER BY n.name ASC;`
    );

    // Chuyển đổi dữ liệu chuẩn cho Frontend
    const mappedNodes = nodesRes.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      ip_address: row.ip_address,
      node_type: row.node_type,
      status: row.status,
      last_seen: row.last_seen,
      created_at: row.created_at,
      latest_metric: row.cpu_percent !== null ? {
        cpu_percent: Number(row.cpu_percent),
        memory_used_bytes: Number(row.ram_used_bytes),
        memory_total_bytes: Number(row.ram_total_bytes),
        disk_used_bytes: Number(row.disk_used_bytes),
        disk_total_bytes: Number(row.disk_total_bytes),
        recorded_at: row.last_seen || new Date().toISOString(),
      } : undefined,
    }));

    return reply.status(200).send({
      success: true,
      data: mappedNodes,
    });
  });

  /**
   * GET /api/telemetry/nodes/:node_id/history
   * Truy vấn chuỗi thời gian số liệu đo xa của một máy chủ con (giới hạn 100 bản ghi mới nhất)
   */
  fastify.get('/nodes/:node_id/history', { preHandler: [authenticate] }, async (req, reply) => {
    const { node_id } = req.params as { node_id: string };

    const metricsRes = await query(
      `SELECT m.node_id, m.cpu_percent,
              m.ram_used_bytes, m.ram_total_bytes, m.ram_percent,
              m.ram_used_bytes AS memory_used_bytes, m.ram_total_bytes AS memory_total_bytes,
              m.disk_used_bytes, m.disk_total_bytes, m.disk_percent,
              m.network_rx_bytes, m.network_tx_bytes, m.uptime_seconds, m.recorded_at
       FROM metrics_history m
       JOIN nodes n ON m.node_id = n.id
       WHERE (n.id::text = $1 OR n.name = $1)
       ORDER BY m.recorded_at DESC
       LIMIT 100;`,
      [node_id]
    );

    return reply.status(200).send({
      success: true,
      node_id,
      count: metricsRes.rows.length,
      data: metricsRes.rows,
    });
  });
};
