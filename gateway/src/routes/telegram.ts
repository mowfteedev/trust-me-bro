import { FastifyPluginAsync } from 'fastify';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { telegramService } from '../services/telegram.js';
import { query } from '../services/db.js';
import { config } from '../config/env.js';

let isSendingTestAlert = false;
let lastSentTestAt = 0;
const TEST_ALERT_COOLDOWN_MS = 15000; // 15 giây cooldown chống spam

export const telegramRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/pairing', { preHandler: [authenticate, authorize(['ADMIN'])] }, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const paired = telegramService.isPaired();
    return { mode: config.TELEGRAM_MODE, paired,
      otp: !paired && config.TELEGRAM_MODE === 'live' ? telegramService.getPairOtp() : null };
  });
  fastify.post('/test', {
    preHandler: [authenticate, authorize(['ADMIN', 'VIEWER'])],
  }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');

    // Chống gửi trùng khi bấm liên tục (In-flight guard)
    if (isSendingTestAlert) {
      return reply.status(409).send({
        status: 409,
        code: 'TELEGRAM_TEST_IN_PROGRESS',
        title: 'Yêu cầu đang được xử lý',
        detail: 'Một yêu cầu gửi cảnh báo thử nghiệm đang được thực hiện. Vui lòng không bấm liên tục.',
      });
    }

    // Giới hạn tần suất gửi cảnh báo thử (15 giây)
    const now = Date.now();
    const elapsed = now - lastSentTestAt;
    if (elapsed < TEST_ALERT_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((TEST_ALERT_COOLDOWN_MS - elapsed) / 1000);
      return reply.status(429).send({
        status: 429,
        code: 'RATE_LIMIT_EXCEEDED',
        title: 'Giới hạn tần suất gửi thử',
        detail: `Tần suất gửi quá nhanh. Vui lòng chờ thêm ${waitSeconds} giây trước khi gửi cảnh báo thử nghiệm tiếp theo.`,
        retry_after: waitSeconds,
      });
    }

    isSendingTestAlert = true;
    try {
      const result = await telegramService.sendTestAlert(req.user.username, req.user.role);
      lastSentTestAt = Date.now();

      // Ghi nhận vào Nhật ký hoạt động (audit_logs) để truy vết, không tạo sự cố trong bảng alerts
      try {
        await query(`
          INSERT INTO audit_logs (user_id, action, target, details, ip_address)
          VALUES ($1, 'TELEGRAM_TEST', 'telegram', $2, $3::inet);
        `, [
          req.user.id,
          JSON.stringify({
            attempted_username: req.user.username,
            role: req.user.role,
            dry_run: result.dryRun,
            result: result.success ? 'SUCCESS' : 'FAILED',
            reason: result.reason || (result.success ? 'OK' : 'UNKNOWN_ERROR'),
          }),
          req.ip,
        ]);
      } catch (dbErr: any) {
        req.log.error({ err: dbErr }, 'Lỗi ghi nhật ký kiểm toán cho TELEGRAM_TEST');
      }

      if (result.success) {
        return reply.status(200).send({
          success: true,
          dryRun: result.dryRun,
          message: result.dryRun
            ? result.reason
            : 'Đã gửi cảnh báo thử nghiệm thành công tới Telegram quản trị viên.',
        });
      } else {
        return reply.status(400).send({
          status: 400,
          code: 'TELEGRAM_TEST_FAILED',
          title: 'Không thể gửi cảnh báo thử nghiệm',
          detail: result.reason || 'Lỗi gửi tin nhắn cảnh báo thử nghiệm tới Telegram.',
          dryRun: result.dryRun,
        });
      }
    } finally {
      isSendingTestAlert = false;
    }
  });
};
