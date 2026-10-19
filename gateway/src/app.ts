import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';

import { config } from './config/env.js';
import { checkDatabaseHealth } from './services/db.js';
import { authRoutes } from './routes/auth.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { bastionRoutes } from './routes/bastion.js';
import { auditRoutes } from './routes/audit.js';

export async function buildServer(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    },
    // Only the configured Caddy peer may supply the client IP through X-Forwarded-For.
    trustProxy: config.TRUSTED_PROXY_IP || false,
  });

  // Install before routes: encapsulated plugins inherit the error handler at registration.
  fastify.setErrorHandler((error, req, reply) => {
    req.log.error(error);

    // Fastify 5 exposes thrown values as unknown; non-Error throws remain a 500.
    const requestError = error instanceof Error ? error as FastifyError : undefined;
    const statusCode = requestError?.statusCode || 500;
    // BẢO MẬT: Không rò rỉ chi tiết lỗi CSDL hay stack trace ra ngoài nếu là lỗi 500 ở Production
    const isProd = config.NODE_ENV === 'production';
    const detail = (statusCode >= 500 && isProd)
      ? 'Đã xảy ra lỗi nội bộ trên hệ thống'
      : (requestError?.message || 'Đã xảy ra lỗi nội bộ trên hệ thống');

    reply.status(statusCode).send({
      type: 'https://tools.ietf.org/html/rfc7807',
      title: requestError?.name || 'Lỗi xử lý yêu cầu',
      status: statusCode,
      code: requestError?.code || 'INTERNAL_ERROR',
      detail,
      request_id: req.id,
      timestamp: new Date().toISOString(),
    });
  });

  await fastify.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await fastify.register(rateLimit, {
    max: 120, // Tối đa 120 yêu cầu mỗi phút trên mỗi địa chỉ IP
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, context) => Object.assign(new Error(
      `Bạn đã vượt quá giới hạn ${context.max} yêu cầu trong 1 phút. Vui lòng thử lại sau.`
    ), {
      name: 'Quá giới hạn tần suất yêu cầu',
      statusCode: context.statusCode,
      code: 'RATE_LIMIT_EXCEEDED',
    }),
  });

  await fastify.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { algorithm: 'HS256' },
    verify: { algorithms: ['HS256'] },
  });

  await fastify.register(websocket, {
    options: {
      maxPayload: 1048576, // 1MB payload limit
    },
  });

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

  await fastify.register(authRoutes, { prefix: '/api/auth' });
  await fastify.register(telemetryRoutes, { prefix: '/api/telemetry' });
  await fastify.register(telemetryRoutes, { prefix: '/api' }); // Hỗ trợ /api/nodes và /api/nodes/:node_id/history theo openapi.yaml
  await fastify.register(bastionRoutes, { prefix: '/api/bastion' });
  await fastify.register(bastionRoutes); // Hỗ trợ cả đường dẫn trực tiếp /ws/terminal/:node_id
  await fastify.register(auditRoutes, { prefix: '/api/audit' });

  return fastify;
}
