import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';

import { config } from './config/env.js';
import { checkDatabaseHealth, closeDatabasePool } from './services/db.js';
import { authRoutes } from './routes/auth.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { bastionRoutes } from './routes/bastion.js';
import { startSweeper, stopSweeper } from './services/sweeper.js';
import { telegramService } from './services/telegram.js';

/**
 * ==============================================================================
 * MÁY CHỦ ĐIỀU HÀNH TRUNG TÂM CONTROL PLANE GATEWAY (server.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: backend (chủ trì), security, tech-lead
 * ==============================================================================
 *
 * LÝ DO PHI TRỰC GIÁC (RATIONALE):
 * 1. trustProxy: true bắt buộc phải bật để Fastify nhận diện chính xác địa chỉ IP
 *    nguyên thủy của máy khách được Caddy chuyển tiếp qua tiêu đề X-Forwarded-For.
 *    Nếu không bật, bộ đếm Rate Limit sẽ tính toàn bộ request có IP của Caddy (172.x.x.x)
 *    và vô tình khóa toàn bộ cụm máy chủ!
 * 2. Cung cấp hai điểm kiểm tra sức khỏe độc lập:
 *    - /healthz (Liveness Probe): Kiểm tra tiến trình Node.js còn sống.
 *    - /readyz (Readiness Probe): Kiểm tra kết nối CSDL PostgreSQL trước khi cho phép Caddy đẩy lưu lượng vào.
 * 3. Graceful Shutdown xử lý tín hiệu SIGTERM / SIGINT bảo đảm không làm gián đoạn transaction CSDL dở dang.
 */

export async function buildServer(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
    },
    // Bắt buộc bật trustProxy khi chạy sau Caddy Reverse Proxy
    trustProxy: true,
  });

  // 1. Đăng ký plugin CORS cho phép Web Console tương tác an toàn
  await fastify.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // 2. Đăng ký Rate Limiting chống tấn công từ chối dịch vụ DoS/Brute-force
  await fastify.register(rateLimit, {
    max: 120, // Tối đa 120 yêu cầu mỗi phút trên mỗi địa chỉ IP
    timeWindow: '1 minute',
    errorResponseBuilder: (req, context) => ({
      type: 'https://tools.ietf.org/html/rfc7807',
      title: 'Quá giới hạn tần suất yêu cầu',
      status: 429,
      code: 'RATE_LIMIT_EXCEEDED',
      detail: `Bạn đã vượt quá giới hạn ${context.max} yêu cầu trong 1 phút. Vui lòng thử lại sau.`,
    }),
  });

  // 3. Đăng ký JWT Plugin phục vụ ký số và thẩm định danh tính HMAC-SHA256
  await fastify.register(jwt, {
    secret: config.JWT_SECRET,
  });

  // 4. Đăng ký WebSocket Plugin phục vụ luồng Web SSH PTY Bastion Bridge
  await fastify.register(websocket, {
    options: {
      maxPayload: 1048576, // 1MB payload limit
    },
  });

  // 5. Tuyến kiểm tra sức khỏe (Health Probes)
  fastify.get('/healthz', async (req, reply) => {
    return reply.status(200).send({
      status: 'UP',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
    });
  });

  fastify.get('/readyz', async (req, reply) => {
    const dbHealth = await checkDatabaseHealth();
    if (!dbHealth.healthy) {
      return reply.status(503).send({
        status: 'DOWN',
        database: dbHealth,
        timestamp: new Date().toISOString(),
      });
    }

    return reply.status(200).send({
      status: 'READY',
      database: dbHealth,
      timestamp: new Date().toISOString(),
    });
  });

  // 6. Đăng ký các nhóm Route chức năng
  await fastify.register(authRoutes, { prefix: '/api/auth' });
  await fastify.register(telemetryRoutes, { prefix: '/api/telemetry' });
  await fastify.register(bastionRoutes, { prefix: '/api/bastion' });

  // 7. Bắt lỗi toàn cục định dạng theo chuẩn RFC-7807 Problem Details
  fastify.setErrorHandler((error, req, reply) => {
    req.log.error(error);

    const statusCode = error.statusCode || 500;
    reply.status(statusCode).send({
      type: 'https://tools.ietf.org/html/rfc7807',
      title: error.name || 'Lỗi xử lý yêu cầu',
      status: statusCode,
      code: (error as any).code || 'INTERNAL_ERROR',
      detail: error.message || 'Đã xảy ra lỗi nội bộ trên hệ thống',
      request_id: req.id,
      timestamp: new Date().toISOString(),
    });
  });

  return fastify;
}

/**
 * Quy trình khởi chạy ứng dụng chính
 */
async function start() {
  try {
    const server = await buildServer();

    // Khởi động dịch vụ Sweeper chạy nền
    startSweeper();

    // Lắng nghe kết nối trên HOST và PORT đã cấu hình
    const address = await server.listen({
      port: config.GATEWAY_PORT,
      host: config.GATEWAY_HOST,
    });

    console.log(`🚀 [GATEWAY ENGINE] Control Plane đang hoạt động tại: ${address}`);
    console.log(`🛡️ [SECURITY ACTIVE] Zero Trust Mode | trustProxy: true | Port: ${config.GATEWAY_PORT}`);

    // Thiết lập Graceful Shutdown khi nhận tín hiệu từ OS/Docker
    const shutdown = async (signal: string) => {
      console.log(`\n🛑 [SHUTDOWN] Nhận tín hiệu ${signal}. Đang tiến hành ngắt êm đẹp...`);
      stopSweeper();
      telegramService.stop();
      await server.close();
      await closeDatabasePool();
      console.log('✔ [SHUTDOWN] Hệ thống đã tắt an toàn. Tạm biệt!');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err: any) {
    console.error('❌ [FATAL] Không thể khởi động Gateway Server:', err.message);
    process.exit(1);
  }
}

// Tự động kích hoạt khi được gọi trực tiếp qua Node.js CLI
const isDirectExecution = process.argv[1] && (
  process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js')
);

if (isDirectExecution) {
  start();
}
