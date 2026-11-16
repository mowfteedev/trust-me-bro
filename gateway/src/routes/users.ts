import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { query } from '../services/db.js';
import { AccountError, createAccount, updateAccount, changeAccountPassword, PUBLIC_USER_COLUMNS } from '../services/user-management.js';
import { normalizeClientIp } from '../utils/client-ip.js';

export const NewPasswordSchema = z.string().min(12).max(128);
const idSchema = z.object({ id: z.string().uuid() }).strict();
const createSchema = z.object({
  username: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{2,49}$/),
  password: NewPasswordSchema,
  role: z.enum(['ADMIN', 'VIEWER']),
}).strict();
const updateSchema = z.object({ role: z.enum(['ADMIN', 'VIEWER']).optional(), is_active: z.boolean().optional() })
  .strict().refine(value => Object.keys(value).length > 0);

export function accountFailure(error: unknown, req: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AccountError) return reply.status(error.status).send({
    status: error.status, code: error.code, title: 'Không thể cập nhật tài khoản', detail: error.message,
  });
  req.log.error({ err: error }, 'Account operation failed');
  return reply.status(503).send({ status: 503, code: 'ACCOUNT_OPERATION_FAILED',
    title: 'Dịch vụ tạm thời không khả dụng', detail: 'Không thể hoàn tất thao tác tài khoản. Vui lòng thử lại.' });
}

function invalid(reply: FastifyReply) {
  return reply.status(400).send({ status: 400, code: 'INVALID_REQUEST', title: 'Dữ liệu không hợp lệ',
    detail: 'Kiểm tra tên tài khoản, vai trò và mật khẩu (12–128 ký tự).' });
}

export const usersRoutes: FastifyPluginAsync = async fastify => {
  fastify.addHook('onSend', async (_request, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });
  fastify.get('/', { preHandler: [authenticate, authorize(['ADMIN'])] }, async (req, reply) => {
    const parsed = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).strict().safeParse(req.query);
    if (!parsed.success) return invalid(reply);
    try {
      const result = await query(`SELECT ${PUBLIC_USER_COLUMNS} FROM users ORDER BY username, id LIMIT 26 OFFSET $1;`, [(parsed.data.page - 1) * 25]);
      return { success: true, page: parsed.data.page, page_size: 25, has_more: result.rows.length > 25, data: result.rows.slice(0, 25) };
    } catch (error) { return accountFailure(error, req, reply); }
  });
  fastify.post('/', { preHandler: [authenticate, authorize(['ADMIN'])] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply);
    try { return reply.status(201).send({ success: true, user: await createAccount(req.user.id, parsed.data, normalizeClientIp(req.ip)) }); }
    catch (error) { return accountFailure(error, req, reply); }
  });
  fastify.patch('/:id', { preHandler: [authenticate, authorize(['ADMIN'])] }, async (req, reply) => {
    const params = idSchema.safeParse(req.params); const body = updateSchema.safeParse(req.body);
    if (!params.success || !body.success) return invalid(reply);
    try { return { success: true, user: await updateAccount(req.user.id, params.data.id, body.data, normalizeClientIp(req.ip)) }; }
    catch (error) { return accountFailure(error, req, reply); }
  });
  fastify.post('/:id/reset-password', { preHandler: [authenticate, authorize(['ADMIN'])] }, async (req, reply) => {
    const params = idSchema.safeParse(req.params); const body = z.object({ password: NewPasswordSchema }).strict().safeParse(req.body);
    if (!params.success || !body.success) return invalid(reply);
    try {
      await changeAccountPassword(req.user.id, params.data.id, body.data.password, normalizeClientIp(req.ip));
      return { success: true, message: 'Đã đặt lại mật khẩu và thu hồi mọi phiên của tài khoản.' };
    } catch (error) { return accountFailure(error, req, reply); }
  });
};
