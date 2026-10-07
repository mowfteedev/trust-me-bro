import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { query } from '../services/db.js';
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
 * 3. Kiểm soát ranh giới Anti-IDOR: Ép buộc node_id trong gói tin phải trùng khớp
 *    với bản ghi tương ứng của token xác thực.
 * 4. Ghi trực tiếp vào bảng phân vùng metrics_history đã thiết lập Range Partitioning.
 */

// Schema kiểm thực tải trọng Beacon bám sát contracts/telemetry.schema.json
const BeaconDTOSchema = z.object({
  node_id: z.string().min(3).max(64),
  timestamp: z.number().int().positive(),
  cpu: z.object({
    percent: z.number().min(0).max(100),
    load_avg: z.array(z.number()).length(3),
  }),
  memory: z.object({
    total_bytes: z.number().int().nonnegative(),
    used_bytes: z.number().int().nonnegative(),
    percent: z.number().min(0).max(100),
  }),
  disk: z.object({
    total_bytes: z.number().int().nonnegative(),
    used_bytes: z.number().int().nonnegative(),
    percent: z.number().min(0).max(100),
  }),
  network: z.object({
    rx_bytes: z.number().int().nonnegative(),
    tx_bytes: z.number().int().nonnegative(),
  }),
  uptime_seconds: z.number().int().nonnegative().optional(),
});

export const telemetryRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * POST /api/telemetry/beacon
   * Cổng tiếp nhận tín hiệu duy trì trạng thái Liveness và số liệu phần cứng định kỳ
   */
  fastify.post('/beacon', async (req, reply) => {
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
        'SELECT id, name, ip_address, token_hash, status FROM nodes WHERE token_hash = $1 LIMIT 1;',
        [inputHash]
      );

      if (nodeRes.rows.length === 0) {
        return reply.status(401).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Mã xác thực không hợp lệ',
          status: 401,
          code: 'INVALID_NODE_TOKEN',
          detail: 'Không tìm thấy máy chủ con tương ứng với mã token được cung cấp',
        });
      }

      const node = nodeRes.rows[0];

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

      // 5. Kiểm thực tính hợp lệ của gói tin JSON
      const parseResult = BeaconDTOSchema.safeParse(req.body);
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

      // 7. Ghi nhận số liệu vào bảng phân vùng Range Partitioning (metrics_history)
      // CHÚ THÍCH THIẾT LẬP: Sử dụng giờ máy chủ UTC chuẩn (now() AT TIME ZONE 'UTC')
      await query(
        `INSERT INTO metrics_history (
          node_id,
          cpu_percent,
          memory_used_bytes,
          memory_total_bytes,
          disk_used_bytes,
          disk_total_bytes,
          network_rx_bytes,
          network_tx_bytes,
          recorded_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, (now() AT TIME ZONE 'UTC')
        );`,
        [
          node.id,
          beacon.cpu.percent,
          beacon.memory.used_bytes,
          beacon.memory.total_bytes,
          beacon.disk.used_bytes,
          beacon.disk.total_bytes,
          beacon.network.rx_bytes,
          beacon.network.tx_bytes,
        ]
      );

      // 8. Cập nhật nhịp tim Liveness cho máy chủ con
      await query(
        `UPDATE nodes
         SET status = 'HEALTHY', last_seen = (now() AT TIME ZONE 'UTC'), updated_at = (now() AT TIME ZONE 'UTC')
         WHERE id = $1;`,
        [node.id]
      );

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
        detail: 'Không thể ghi nhận số liệu đo xa vào cơ sở dữ liệu',
      });
    }
  });

  /**
   * GET /api/telemetry/nodes
   * Lấy danh sách tất cả các Endpoint Hosts và trạng thái Liveness mới nhất
   */
  fastify.get('/nodes', { preHandler: [authenticate] }, async (req, reply) => {
    const nodesRes = await query(
      `SELECT id, name, ip_address, node_type, status, last_seen, created_at
       FROM nodes
       ORDER BY name ASC;`
    );
    return reply.status(200).send({
      success: true,
      data: nodesRes.rows,
    });
  });

  /**
   * GET /api/telemetry/nodes/:node_id/history
   * Truy vấn chuỗi thời gian số liệu đo xa của một máy chủ con (giới hạn 100 bản ghi mới nhất)
   */
  fastify.get('/nodes/:node_id/history', { preHandler: [authenticate] }, async (req, reply) => {
    const { node_id } = req.params as { node_id: string };

    const metricsRes = await query(
      `SELECT m.id, m.cpu_percent, m.memory_used_bytes, m.memory_total_bytes,
              m.disk_used_bytes, m.disk_total_bytes, m.network_rx_bytes, m.network_tx_bytes, m.recorded_at
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
