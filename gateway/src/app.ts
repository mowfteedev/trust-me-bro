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
import { hostRoutes } from './routes/host.js';
import { telegramRoutes } from './routes/telegram.js';
import { usersRoutes } from './routes/users.js';
import { incidentsRoutes } from './routes/incidents.js';
import { enrollmentRoutes } from './routes/enrollment.js';
import { offboardingRoutes } from './routes/offboarding.js';

export async function buildServer(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-enrollment-token"]',
          'req.headers["x-cleanup-token"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
    },
    // Only the configured Caddy peer may supply the client IP through X-Forwarded-For.
    trustProxy: config.TRUSTED_PROXY_IP || false,
  });

  // Install before routes: encapsulated plugins inherit the error handler at registration.
  fastify.setErrorHandler((error, req, reply) => {
    // Fastify 5 exposes thrown values as unknown; non-Error throws remain a 500.
    const requestError = error instanceof Error ? error as FastifyError : undefined;
    const statusCode = requestError?.statusCode || 500;
    // BẢO MẬT: Không rò rỉ chi tiết lỗi CSDL hay stack trace ra ngoài nếu là lỗi 500 ở Production
    req.log.error({ statusCode, request_id: req.id }, 'Request failed');
    const detail = statusCode >= 500
      ? 'Đã xảy ra lỗi nội bộ trên hệ thống'
      : (requestError?.message || 'Đã xảy ra lỗi nội bộ trên hệ thống');

    reply.status(statusCode).send({
      type: 'https://tools.ietf.org/html/rfc7807',
      title: statusCode >= 500 ? 'Lỗi xử lý yêu cầu' : requestError?.name || 'Lỗi xử lý yêu cầu',
      status: statusCode,
      code: statusCode >= 500 ? 'INTERNAL_ERROR' : requestError?.code || 'INTERNAL_ERROR',
      detail,
      request_id: req.id,
      timestamp: new Date().toISOString(),
    });
  });

  await fastify.register(cors, {
    origin: false, // Dashboard and API share one origin; Agents do not need CORS.
  });

  await fastify.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: async (request) => {
      // Never let an unverified JWT/header select a different rate-limit bucket.
      // Login remains IP-limited even when the caller supplies an existing JWT.
      if (request.routeOptions.url !== '/api/auth/login' && request.headers.authorization) {
        try {
          const identity = await request.jwtVerify<{ id: string }>();
          if (typeof identity.id === 'string') return `user:${identity.id}`;
        } catch { /* Invalid/expired credentials share the ordinary IP bucket. */ }
      }
      return `ip:${request.ip}`;
    },
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
        database: { healthy: false, latencyMs: dbHealth.latencyMs },
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
  await fastify.register(hostRoutes, { prefix: '/api' });
  await fastify.register(telegramRoutes, { prefix: '/api/telegram' });
  await fastify.register(usersRoutes, { prefix: '/api/users' });
  await fastify.register(incidentsRoutes, { prefix: '/api/incidents' });
  await fastify.register(enrollmentRoutes, { prefix: '/api/enrollment' });
  await fastify.register(offboardingRoutes, { prefix: '/api' });

  return fastify;
}
