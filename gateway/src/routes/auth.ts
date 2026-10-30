import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { verifyPassword } from '../utils/crypto.js';
import { query } from '../services/db.js';
import { config } from '../config/env.js';
import { authenticate, AuthUserPayload } from '../middlewares/auth.middleware.js';
import { normalizeClientIp } from '../utils/client-ip.js';
import { revokeUserSessions } from '../services/bastion/registry.js';

/**
 * ==============================================================================
 * TUYẾN ĐIỀU HƯỚNG XÁC THỰC DANH TÍNH (routes/auth.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: security (chủ trì), backend
 * ==============================================================================
 */

const LoginRequestSchema = z.object({
  username: z.string().min(1, 'Tên đăng nhập không được để trống').max(50),
  password: z.string().min(1, 'Mật khẩu không được để trống'),
});

const DUMMY_HASH = 'c0ffee00deadbeef1337c0ffee00dead:c0ffee00deadbeef1337c0ffee00deadbeef1337c0ffee00deadbeef1337c0ffee00deadbeef1337c0ffee00deadbeef1337c0ffee00deadbeef1337c0ffee00deadbeef';

export const authRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * POST /api/auth/login
   * Đăng nhập và phát hành JSON Web Token (HMAC-SHA256) kèm session_version
   */
  fastify.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parseResult = LoginRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Dữ liệu không hợp lệ',
        status: 400,
        code: 'INVALID_REQUEST',
        detail: 'Tên đăng nhập hoặc mật khẩu không đúng định dạng',
        errors: parseResult.error.errors,
      });
    }

    const { username, password } = parseResult.data;
    const clientIp = normalizeClientIp(req.ip);
    // Runs only after the rate limiter and validation. No passwords/tokens/raw body.
    // A failed audit write must never convert invalid credentials into a login.
    const recordLoginFailure = async (userId: string | null, reason: 'invalid_credentials' | 'account_disabled') => {
      try {
        await query(
          `INSERT INTO audit_logs (user_id, action, target, details, ip_address)
           VALUES ($1, 'LOGIN_FAILED', 'auth', $2, $3::inet);`,
          [userId, JSON.stringify({
            attempted_username: username.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 50), reason,
          }), clientIp]
        );
      } catch (auditErr) {
        req.log.error({ auditErr }, 'Không thể ghi nhật ký đăng nhập thất bại');
      }
    };

    try {
      // 1. Tìm người dùng trong CSDL kèm session_version
      const userRes = await query(
        'SELECT id, username, password_hash, role, is_active, session_version FROM users WHERE username = $1 LIMIT 1;',
        [username]
      );

      if (userRes.rows.length === 0) {
        verifyPassword(password, DUMMY_HASH);
        await recordLoginFailure(null, 'invalid_credentials');
        return reply.status(401).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Đăng nhập thất bại',
          status: 401,
          code: 'INVALID_CREDENTIALS',
          detail: 'Tên đăng nhập hoặc mật khẩu không chính xác',
        });
      }

      const user = userRes.rows[0];

      // 2. Kiểm tra mật khẩu an toàn với Scrypt và timingSafeEqual
      const isPasswordValid = verifyPassword(password, user.password_hash);
      if (!isPasswordValid) {
        await recordLoginFailure(user.id, 'invalid_credentials');
        return reply.status(401).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Đăng nhập thất bại',
          status: 401,
          code: 'INVALID_CREDENTIALS',
          detail: 'Tên đăng nhập hoặc mật khẩu không chính xác',
        });
      }

      // 3. Chỉ sau khi mật khẩu hợp lệ mới kiểm tra trạng thái tài khoản
      if (!user.is_active) {
        await recordLoginFailure(user.id, 'account_disabled');
        return reply.status(403).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Tài khoản bị khóa',
          status: 403,
          code: 'ACCOUNT_DISABLED',
          detail: 'Tài khoản của bạn đã bị vô hiệu hóa trong hệ thống',
        });
      }

      // 4. Cấp phát JWT Ký số HMAC-SHA256 kèm session_version
      const payload: AuthUserPayload = {
        id: user.id,
        username: user.username,
        role: user.role,
        session_version: Number(user.session_version) || 1,
      };

      const token = fastify.jwt.sign(payload, {
        expiresIn: config.JWT_EXPIRES_IN,
      });

      // 5. Ghi nhận log kiểm toán bất biến - FAIL-CLOSED (R07 Remediation)
      try {
        await query(
          `INSERT INTO audit_logs (user_id, action, target, details, ip_address)
           VALUES ($1, 'LOGIN_SUCCESS', 'auth', $2, $3::inet);`,
          [user.id, JSON.stringify({ user_agent: req.headers['user-agent'] || 'unknown' }), clientIp]
        );
      } catch (auditErr: any) {
        req.log.error({ auditErr }, 'Lỗi ghi audit log khi đăng nhập - Fail-Closed kích hoạt');
        return reply.status(503).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Lỗi ghi nhận nhật ký kiểm toán',
          status: 503,
          code: 'AUDIT_LOG_FAILURE',
          detail: 'Đăng nhập bị từ chối do không thể lưu vết kiểm toán an toàn trên hệ thống',
        });
      }

      return reply.status(200).send({
        success: true,
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          session_version: payload.session_version,
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
   * POST /api/auth/logout
   * Thu hồi toàn bộ phiên làm việc phía máy chủ bằng cách tăng session_version (Server-Side Session Revocation)
   */
  fastify.post('/logout', { preHandler: [authenticate] }, async (req, reply) => {
    const user = req.user as AuthUserPayload;
    try {
      const revoked = await query(
        'UPDATE users SET session_version = session_version + 1, updated_at = NOW() WHERE id = $1 RETURNING session_version;',
        [user.id]
      );
      const currentVersion = Number(revoked.rows[0]?.session_version);
      if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) throw new Error('Session revocation returned no valid version');
      revokeUserSessions(user.id, currentVersion);

      const clientIp = normalizeClientIp(req.ip);
      try {
        await query(
          `INSERT INTO audit_logs (user_id, action, target, details, ip_address)
           VALUES ($1, 'LOGOUT_SUCCESS', 'auth', $2, $3::inet);`,
          [user.id, JSON.stringify({ reason: 'user_initiated_logout' }), clientIp]
        );
      } catch (auditErr: any) {
        req.log.error({ auditErr }, 'Lỗi ghi audit log khi đăng xuất - Fail-Closed kích hoạt');
        return reply.status(503).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Lỗi ghi nhận nhật ký kiểm toán',
          status: 503,
          code: 'AUDIT_LOG_FAILURE',
          detail: 'Không thể ghi nhận nhật ký kiểm toán cho thao tác đăng xuất',
        });
      }

      return reply.status(200).send({
        success: true,
        message: 'Đăng xuất thành công. Toàn bộ phiên làm việc của tài khoản đã bị thu hồi.',
      });
    } catch (err: any) {
      req.log.error({ err }, 'Lỗi khi xử lý đăng xuất');
      return reply.status(503).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Lỗi máy chủ',
        status: 503,
        code: 'LOGOUT_FAILED',
        detail: 'Không thể thu hồi phiên làm việc do lỗi kết nối cơ sở dữ liệu',
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
