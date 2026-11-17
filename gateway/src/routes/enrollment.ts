import type { FastifyPluginAsync } from 'fastify';
import { claimEnrollment } from '../services/enrollment.js';
import { EnrollmentError, enrollmentPublicConfig } from '../services/enrollment-contract.js';
import { config } from '../config/env.js';

export const enrollmentRoutes: FastifyPluginAsync = async app => {
  app.get('/info', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!config.ENROLLMENT_ENABLED) return reply.status(404).send({ code: 'NOT_FOUND' });
    try { return { version: 1, ...enrollmentPublicConfig(config) }; }
    catch { return reply.status(503).send({ code: 'ENROLLMENT_UNAVAILABLE' }); }
  });
  app.post('/claim', { bodyLimit: 4096, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const result = await claimEnrollment(request.body, request.headers['x-enrollment-token']);
      if (!result.peer_ready) reply.header('Retry-After', '3');
      return reply.status(result.peer_ready ? 200 : 202).send(result);
    } catch (error) {
      const failure = error instanceof EnrollmentError ? error : new EnrollmentError(503, 'ENROLLMENT_UNAVAILABLE');
      if (failure.status === 503) reply.header('Retry-After', '3');
      return reply.status(failure.status).send({ status: failure.status, code: failure.code,
        detail: 'Không thể hoàn tất ghép Worker; kiểm tra mã ghép, cấu hình và trạng thái Gateway.' });
    }
  });
};
