import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { config } from '../config/env.js';
import { query } from '../services/db.js';
import { enrollmentPublicConfig } from '../services/enrollment-contract.js';
import {
  canonicalJson,
  mapSqlOffboardError,
  OffboardingError,
  reconcilePendingOffboardings,
  revokeNodeAccess,
} from '../services/offboarding.js';

const UuidParamSchema = z.object({
  id: z.string().uuid(),
});

const BeginOffboardBodySchema = z.object({
  confirm_node_name: z.string().trim().min(1).max(64),
}).strict();

const StepStatusEnum = z.enum(['DONE', 'REVIEW']);

const VerifyPayloadSchema = z.object({
  version: z.literal(1),
  operation_id: z.string().uuid(),
  gateway_id: z.string().min(1).max(128),
  node_id: z.string().uuid(),
  invitation_id: z.string().uuid(),
  wireguard_public_key: z.string().length(44),
  node_ip: z.string().ip({ version: 'v4' }),
}).strict();

const ReceiptStepsSchema = z.object({
  agent: StepStatusEnum,
  tunnel: StepStatusEnum,
  firewall: StepStatusEnum,
  ssh: StepStatusEnum,
  secrets: StepStatusEnum,
}).strict();

const ReceiptPayloadSchema = z.object({
  version: z.literal(1),
  operation_id: z.string().uuid(),
  node_id: z.string().uuid(),
  gateway_id: z.string().min(1).max(128),
  invitation_id: z.string().uuid(),
  wireguard_public_key: z.string().length(44),
  node_ip: z.string().ip({ version: 'v4' }),
  status: z.enum(['COMPLETE', 'NEEDS_REVIEW']),
  receipt: z.object({
    platform: z.enum(['linux', 'windows']),
    steps: ReceiptStepsSchema,
    evidence_digest: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
}).strict();

export const offboardingRoutes: FastifyPluginAsync = async app => {
  // 1. Khởi tạo quy trình offboarding (POST /api/nodes/:id/offboarding)
  app.post('/nodes/:id/offboarding', { preHandler: [authenticate, authorize(['ADMIN'])] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!config.ENROLLMENT_ENABLED) return reply.status(404).send({ code: 'NOT_FOUND' });

    const paramParsed = UuidParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      return reply.status(400).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'ID máy chủ không hợp lệ',
        status: 400,
        code: 'INVALID_NODE_ID',
        detail: 'Định dạng ID máy chủ bắt buộc phải là UUID hợp lệ.',
      });
    }

    const bodyParsed = BeginOffboardBodySchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Tải trọng không hợp lệ',
        status: 400,
        code: 'OFFBOARD_BAD_INPUT',
        detail: 'Yêu cầu truyền tên xác nhận máy chủ hợp lệ (confirm_node_name).',
      });
    }

    let gatewayId: string;
    try {
      gatewayId = enrollmentPublicConfig(config).gateway_id;
    } catch {
      return reply.status(503).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Cấu hình Gateway không khả dụng',
        status: 503,
        code: 'OFFBOARD_UNAVAILABLE',
        detail: 'Không thể xác định Gateway ID từ cấu hình hệ thống.',
      });
    }

    const { id } = paramParsed.data;
    const { confirm_node_name } = bodyParsed.data;
    const actorId = req.user.id;

    try {
      const beginRes = await query(
        'SELECT * FROM public.begin_worker_offboarding($1, $2, $3, $4)',
        [id, confirm_node_name, gatewayId, actorId]
      );
      const row = beginRes.rows[0];

      // Ngay sau khi CSDL commit, thu hồi toàn bộ phiên và vé SSH của máy chủ này
      revokeNodeAccess(id);

      // Kích hoạt chu kỳ đối soát và xuất tệp .remove
      void reconcilePendingOffboardings().catch(() => {});

      if (row.state === 'PENDING_PEER_REMOVAL') {
        reply.header('Retry-After', '3');
        return reply.status(202).send({
          success: true,
          status: 'RETIRING',
          operation: {
            operation_id: row.operation_id,
            node_id: row.node_id,
            node_name: row.node_name,
            node_ip: row.node_ip,
            node_type: row.node_type,
            worker_os: row.worker_os,
            wireguard_public_key: row.wireguard_public_key,
            state: row.state,
            created_at: row.created_at,
          },
        });
      }

      return reply.status(200).send({
        success: true,
        status: row.state,
        operation: {
          operation_id: row.operation_id,
          node_id: row.node_id,
          node_name: row.node_name,
          node_ip: row.node_ip,
          node_type: row.node_type,
          worker_os: row.worker_os,
          wireguard_public_key: row.wireguard_public_key,
          state: row.state,
          created_at: row.created_at,
        },
      });
    } catch (err: unknown) {
      const mapped = mapSqlOffboardError(err);
      return reply.status(mapped.status).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Lỗi khởi tạo thu hồi máy chủ',
        status: mapped.status,
        code: mapped.code,
        detail: mapped.message,
      });
    }
  });

  // 2. Tra cứu trạng thái offboarding (GET /api/nodes/:id/offboarding)
  app.get('/nodes/:id/offboarding', { preHandler: [authenticate, authorize(['ADMIN', 'VIEWER'])] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!config.ENROLLMENT_ENABLED) return reply.status(404).send({ code: 'NOT_FOUND' });

    const paramParsed = UuidParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      return reply.status(400).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'ID máy chủ không hợp lệ',
        status: 400,
        code: 'INVALID_NODE_ID',
        detail: 'Định dạng ID máy chủ bắt buộc phải là UUID hợp lệ.',
      });
    }

    let gatewayId: string;
    try {
      gatewayId = enrollmentPublicConfig(config).gateway_id;
    } catch {
      return reply.status(503).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Cấu hình Gateway không khả dụng',
        status: 503,
        code: 'OFFBOARD_UNAVAILABLE',
        detail: 'Không thể xác định Gateway ID từ cấu hình hệ thống.',
      });
    }

    const { id } = paramParsed.data;
    try {
      const statusRes = await query(
        'SELECT * FROM public.get_worker_offboarding_status($1, $2)',
        [id, gatewayId]
      );

      if (statusRes.rows.length === 0) {
        return reply.status(200).send({
          success: true,
          status: 'NOT_STARTED',
          offboarding: null,
        });
      }

      const row = statusRes.rows[0];
      return reply.status(200).send({
        success: true,
        offboarding: {
          operation_id: row.operation_id,
          node_id: row.node_id,
          node_name: row.node_name,
          node_ip: row.node_ip,
          wireguard_public_key: row.wireguard_public_key,
          state: row.state,
          lifecycle_state: row.lifecycle_state,
          created_at: row.created_at,
          peer_removed_at: row.peer_removed_at,
          completed_at: row.completed_at,
          last_error: row.last_error,
          has_cleanup_token: Boolean(row.has_cleanup_token),
        },
      });
    } catch (err: unknown) {
      const mapped = mapSqlOffboardError(err);
      return reply.status(mapped.status).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Lỗi tra cứu trạng thái thu hồi',
        status: mapped.status,
        code: mapped.code,
        detail: mapped.message,
      });
    }
  });

  // 3. Cấp phát bundle capability dọn dẹp (POST /api/nodes/:id/offboarding/authorization)
  app.post('/nodes/:id/offboarding/authorization', { preHandler: [authenticate, authorize(['ADMIN'])] }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!config.ENROLLMENT_ENABLED) return reply.status(404).send({ code: 'NOT_FOUND' });

    const paramParsed = UuidParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      return reply.status(400).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'ID máy chủ không hợp lệ',
        status: 400,
        code: 'INVALID_NODE_ID',
        detail: 'Định dạng ID máy chủ bắt buộc phải là UUID hợp lệ.',
      });
    }

    let meta: ReturnType<typeof enrollmentPublicConfig>;
    try {
      meta = enrollmentPublicConfig(config);
    } catch {
      return reply.status(503).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Cấu hình Gateway không khả dụng',
        status: 503,
        code: 'OFFBOARD_UNAVAILABLE',
        detail: 'Không thể tải cấu hình công khai của Gateway.',
      });
    }

    const { id } = paramParsed.data;
    try {
      const statusRes = await query(
        'SELECT * FROM public.get_worker_offboarding_status($1, $2)',
        [id, meta.gateway_id]
      );
      if (statusRes.rows.length === 0) {
        return reply.status(404).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Quy trình chưa khởi tạo',
          status: 404,
          code: 'OFFBOARD_NOT_FOUND',
          detail: 'Chưa khởi tạo quy trình thu hồi cho máy chủ này.',
        });
      }

      const op = statusRes.rows[0];
      if (op.state === 'COMPLETED') {
        return reply.status(409).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Quy trình đã hoàn tất',
          status: 409,
          code: 'OFFBOARD_ALREADY_COMPLETED',
          detail: 'Quy trình thu hồi máy chủ đã hoàn tất trước đó.',
        });
      }

      // Tạo chuỗi ngẫu nhiên bảo mật 256-bit và băm SHA-256
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      const issueRes = await query(
        'SELECT * FROM public.issue_worker_cleanup_token($1, $2, $3, $4, $5)',
        [op.operation_id, id, meta.gateway_id, req.user.id, tokenHash]
      );
      const issued = issueRes.rows[0];

      const origin = new URL(config.ENROLLMENT_PUBLIC_URL || '').origin;
      const bundle = {
        version: 1,
        gateway_id: meta.gateway_id,
        operation_id: issued.operation_id,
        node_id: issued.node_id,
        node_name: issued.node_name,
        invitation_id: issued.invitation_id,
        wireguard_public_key: issued.wireguard_public_key,
        node_ip: issued.node_ip,
        completion_url: `${origin}/api/offboarding/complete`,
        cleanup_token: rawToken,
      };

      reply.header('Content-Type', 'application/json; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="offboarding-${issued.node_name}.json"`);
      return reply.status(200).send(bundle);
    } catch (err: unknown) {
      const mapped = mapSqlOffboardError(err);
      return reply.status(mapped.status).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Lỗi cấp quyền dọn dẹp',
        status: mapped.status,
        code: mapped.code,
        detail: mapped.message,
      });
    }
  });

  // 4. Xác minh capability dọn dẹp trước khi Worker gỡ bỏ cài đặt (POST /api/offboarding/verify)
  app.post('/offboarding/verify', {
    bodyLimit: 8192,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');

    const rawToken = req.headers['x-cleanup-token'];
    if (typeof rawToken !== 'string' || !/^[0-9a-f]{64}$/.test(rawToken)) {
      return reply.status(401).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Mã xác thực không hợp lệ',
        status: 401,
        code: 'OFFBOARD_CAPABILITY_INVALID',
        detail: 'Header X-Cleanup-Token bị thiếu hoặc không đúng định dạng 256-bit hex.',
      });
    }

    const bodyParsed = VerifyPayloadSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Tải trọng không đúng định dạng',
        status: 400,
        code: 'OFFBOARD_BAD_INPUT',
        detail: 'Dữ liệu xác minh vi phạm cấu trúc yêu cầu.',
      });
    }

    const payload = bodyParsed.data;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    try {
      const verifyRes = await query(
        'SELECT * FROM public.verify_worker_cleanup_capability($1, $2, $3)',
        [payload.operation_id, tokenHash, payload.gateway_id]
      );
      if (verifyRes.rows.length === 0) {
        return reply.status(401).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Xác minh thất bại',
          status: 401,
          code: 'OFFBOARD_CAPABILITY_INVALID',
          detail: 'Không tìm thấy quyền dọn dẹp hợp lệ.',
        });
      }

      const row = verifyRes.rows[0];
      if (
        row.node_id !== payload.node_id ||
        row.invitation_id !== payload.invitation_id ||
        row.wireguard_public_key !== payload.wireguard_public_key ||
        row.node_ip !== payload.node_ip
      ) {
        return reply.status(409).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Định danh không khớp',
          status: 409,
          code: 'OFFBOARD_TUPLE_MISMATCH',
          detail: 'Thông tin định danh máy chủ không khớp với hồ sơ thu hồi.',
        });
      }

      return reply.status(200).send({
        success: true,
        operation_id: row.operation_id,
        gateway_id: payload.gateway_id,
        node_id: row.node_id,
        node_name: row.node_name,
        node_ip: row.node_ip,
        invitation_id: row.invitation_id,
        wireguard_public_key: row.wireguard_public_key,
        state: row.state,
        lifecycle_state: row.lifecycle_state,
      });
    } catch (err: unknown) {
      const mapped = mapSqlOffboardError(err);
      return reply.status(mapped.status).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Lỗi xác minh quyền dọn dẹp',
        status: mapped.status,
        code: mapped.code,
        detail: mapped.message,
      });
    }
  });

  // 5. Tiếp nhận biên bản dọn dẹp cục bộ (POST /api/offboarding/complete)
  app.post('/offboarding/complete', {
    bodyLimit: 8192,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');

    const rawToken = req.headers['x-cleanup-token'];
    if (typeof rawToken !== 'string' || !/^[0-9a-f]{64}$/.test(rawToken)) {
      return reply.status(401).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Mã xác thực không hợp lệ',
        status: 401,
        code: 'OFFBOARD_CAPABILITY_INVALID',
        detail: 'Header X-Cleanup-Token bị thiếu hoặc không đúng định dạng 256-bit hex.',
      });
    }

    const bodyParsed = ReceiptPayloadSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return reply.status(400).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Biên bản không hợp lệ',
        status: 400,
        code: 'OFFBOARD_BAD_INPUT',
        detail: 'Dữ liệu biên bản dọn dẹp vi phạm cấu trúc yêu cầu.',
      });
    }

    const payload = bodyParsed.data;

    // Nếu báo cáo COMPLETE, bắt buộc tất cả 5 bước phải đạt DONE
    if (payload.status === 'COMPLETE') {
      const steps = payload.receipt.steps;
      if (
        steps.agent !== 'DONE' ||
        steps.tunnel !== 'DONE' ||
        steps.firewall !== 'DONE' ||
        steps.ssh !== 'DONE' ||
        steps.secrets !== 'DONE'
      ) {
        return reply.status(400).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Các bước dọn dẹp chưa hoàn tất',
          status: 400,
          code: 'OFFBOARD_STEPS_INCOMPLETE',
          detail: 'Báo cáo COMPLETE yêu cầu tất cả 5 bước dọn dẹp phải ở trạng thái DONE.',
        });
      }
    }

    // Tính mã băm chuẩn tắc canonical JSON của toàn bộ tải trọng trên máy chủ (chống client giả mạo hash)
    const receiptHash = crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    try {
      const completeRes = await query(
        'SELECT * FROM public.complete_worker_offboarding($1, $2, $3, $4, $5, $6::jsonb)',
        [payload.operation_id, tokenHash, payload.gateway_id, payload.status, receiptHash, JSON.stringify(payload)]
      );
      const row = completeRes.rows[0];

      return reply.status(200).send({
        success: true,
        operation_id: row.operation_id,
        node_id: row.node_id,
        state: row.state,
        lifecycle_state: row.lifecycle_state,
        replayed: Boolean(row.replayed),
      });
    } catch (err: unknown) {
      const mapped = mapSqlOffboardError(err);
      return reply.status(mapped.status).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Lỗi hoàn tất thu hồi máy chủ',
        status: mapped.status,
        code: mapped.code,
        detail: mapped.message,
      });
    }
  });
};
