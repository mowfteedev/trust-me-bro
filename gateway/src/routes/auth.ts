import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { query } from '../services/db.js';
import { verifyPassword } from '../utils/crypto.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { config } from '../config/env.js';

/**
 * ==============================================================================
 * TUYẾN ĐIỀU HƯỚNG XÁC THỰC DANH TÍNH (auth.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: security (chủ trì), backend, frontend
 * ==============================================================================
 */

const LoginDTOSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(6).max(100),
});

export const authRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * POST /api/auth/login
   * Xác thực tài khoản quản trị và cấp phát JWT Token
   */
  fastify.post('/login', async (req, reply) => {
    const parseResult = LoginDTOSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Dữ liệu không hợp lệ',
        status: 400,
        code: 'VALIDATION_ERROR',
        detail: 'Tên người dùng hoặc mật khẩu không đúng định dạng',
        errors: parseResult.error.errors,
      });
    }

    const { username, password } = parseResult.data;

    try {
      // 1. Tìm người dùng trong CSDL
      const userRes = await query(
        'SELECT id, username, password_hash, role, is_active FROM users WHERE username = $1 LIMIT 1;',
        [username]
      );

      if (userRes.rows.length === 0) {
        // CHÚ THÍCH BẢO MẬT: Trả về thông báo chung để chống tấn công dò quét người dùng (User Enumeration)
        return reply.status(401).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Đăng nhập thất bại',
          status: 401,
          code: 'INVALID_CREDENTIALS',
          detail: 'Tên đăng nhập hoặc mật khẩu không chính xác',
        });
      }

      const user = userRes.rows[0];

      if (!user.is_active) {
        return reply.status(403).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Tài khoản bị khóa',
          status: 403,
          code: 'ACCOUNT_DISABLED',
          detail: 'Tài khoản của bạn đã bị vô hiệu hóa trong hệ thống',
        });
      }

      // 2. Kiểm tra mật khẩu an toàn với Scrypt và timingSafeEqual
      const isPasswordValid = verifyPassword(password, user.password_hash);
      if (!isPasswordValid) {
        return reply.status(401).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Đăng nhập thất bại',
          status: 401,
          code: 'INVALID_CREDENTIALS',
          detail: 'Tên đăng nhập hoặc mật khẩu không chính xác',
        });
      }

      // 3. Cấp phát JWT Ký số HMAC-SHA256
      const payload = {
        id: user.id,
        username: user.username,
        role: user.role,
      };

      const token = fastify.jwt.sign(payload, {
        expiresIn: config.JWT_EXPIRES_IN,
      });

      // 4. Ghi nhận log kiểm toán bất biến
      const clientIp = req.ip || '127.0.0.1';
      // Chuẩn hóa IP nếu là IPv6 loopback
      const normalizedIp = clientIp === '::1' ? '127.0.0.1' : clientIp.replace(/^::ffff:/, '');

      await query(
        `INSERT INTO audit_logs (user_id, action, target, details, ip_address)
         VALUES ($1, 'LOGIN_SUCCESS', 'auth', $2, $3::inet);`,
        [user.id, JSON.stringify({ user_agent: req.headers['user-agent'] || 'unknown' }), normalizedIp]
      ).catch((logErr) => {
        console.error('⚠️ [AUDIT WARNING] Không thể ghi log đăng nhập:', logErr.message);
      });

      return reply.status(200).send({
        success: true,
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
        },
      });
    } catch (err: any) {
      req.log.error({ err }, 'Lỗi hệ thống trong luồng đăng nhập');
      return reply.status(500).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Lỗi máy chủ nội bộ',
        status: 500,
        code: 'INTERNAL_SERVER_ERROR',
        detail: 'Đã xảy ra lỗi trong quá trình xác thực danh tính',
      });
    }
  });

  /**
   * GET /api/auth/me
   * Lấy thông tin phiên làm việc hiện tại
   */
  fastify.get('/me', { preHandler: [authenticate] }, async (req, reply) => {
    return reply.status(200).send({
      success: true,
      user: req.user,
    });
  });
};
