import { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../services/db.js';

/**
 * ==============================================================================
 * MIDDLEWARE PHÂN QUYỀN TRUY CẬP RBAC & THU HỒI PHIÊN THỜI GIAN THỰC (auth.middleware.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: security (chủ trì), backend, code-reviewer
 * ==============================================================================
 *
 * LÝ DO PHI TRỰC GIÁC (RATIONALE):
 * 1. Chữ ký JWT HMAC-SHA256 chỉ chứng minh token do hệ thống cấp tại một thời điểm trong quá khứ.
 * 2. Để triệt tiêu hoàn toàn lỗ hổng B2 (Session Revocation Fail-Open):
 *    - BẮT BUỘC kiểm tra trạng thái is_active và session_version theo thời gian thực từ CSDL.
 *    - Nếu CSDL gặp sự cố (timeout, disconnect, connection limit) -> CƯỠNG CHẾ FAIL-CLOSED BẰNG HTTP 503.
 *      TUYỆT ĐỐI KHÔNG NUỐT LỖI RỒI CHO REQUEST ĐI TIẾP!
 *    - BẮT BUỘC ghi đè vai trò (role) từ bản ghi CSDL mới nhất vào req.user thay vì tin tưởng payload JWT,
 *      ngăn chặn kẻ tấn công lợi dụng việc hạ quyền (Role Downgrade) trong 24 giờ của token cũ.
 */

export interface AuthUserPayload {
  id: string;
  username: string;
  role: 'ADMIN' | 'VIEWER';
  session_version: number;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthUserPayload;
    user: AuthUserPayload;
  }
}

/**
 * Middleware thẩm định tính hợp lệ của JSON Web Token và thu hồi phiên thời gian thực
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  let payload: AuthUserPayload;
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Chưa được xác thực',
        status: 401,
        code: 'UNAUTHORIZED',
        detail: 'Yêu cầu cung cấp Bearer Token hợp lệ trong tiêu đề Authorization',
      });
    }

    payload = await req.jwtVerify<AuthUserPayload>();
  } catch (jwtErr: any) {
    return reply.status(401).send({
      type: 'https://tools.ietf.org/html/rfc7807',
      title: 'Xác thực thất bại',
      status: 401,
      code: 'INVALID_TOKEN',
      detail: 'Mã xác thực JWT không hợp lệ hoặc đã hết hạn',
    });
  }

  // 1. Kiểm tra session_version trong payload (Chặn token cũ trước migration)
  if (typeof payload.session_version !== 'number') {
    return reply.status(401).send({
      type: 'https://tools.ietf.org/html/rfc7807',
      title: 'Phiên làm việc cũ hết hiệu lực',
      status: 401,
      code: 'LEGACY_SESSION_EXPIRED',
      detail: 'Mã xác thực không chứa phiên bảo mật hợp lệ. Yêu cầu đăng nhập lại.',
    });
  }

  // 2. Xác thực trạng thái tài khoản và phiên với CSDL theo chuẩn Zero Trust Fail-Closed
  let dbUser: any;
  try {
    const userRes = await query(
      'SELECT id, username, role, is_active, session_version FROM users WHERE id = $1 LIMIT 1;',
      [payload.id]
    );

    if (userRes.rows.length === 0 || !userRes.rows[0].is_active) {
      return reply.status(403).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Tài khoản bị vô hiệu hóa',
        status: 403,
        code: 'ACCOUNT_DISABLED',
        detail: 'Tài khoản của bạn đã bị khóa hoặc không còn tồn tại trên hệ thống',
      });
    }

    dbUser = userRes.rows[0];
  } catch (dbErr: any) {
    // ZERO TRUST FAIL-CLOSED: Bất kỳ sự cố kết nối hoặc timeout CSDL nào ĐỀU PHẢI TỪ CHỐI REQUEST BẰNG 503!
    req.log.error({ dbErr }, 'Lỗi xác thực trạng thái tài khoản với CSDL - Fail-Closed kích hoạt');
    return reply.status(503).send({
      type: 'https://tools.ietf.org/html/rfc7807',
      title: 'Dịch vụ tạm thời không khả dụng',
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      detail: 'Hệ thống tạm thời không thể xác thực trạng thái phiên làm việc do sự cố kết nối cơ sở dữ liệu',
    });
  }

  // 3. Kiểm tra tính hợp lệ của phiên làm việc (Session Revocation / Logout Invalidation)
  if (Number(dbUser.session_version) !== Number(payload.session_version)) {
    return reply.status(401).send({
      type: 'https://tools.ietf.org/html/rfc7807',
      title: 'Phiên làm việc đã bị thu hồi',
      status: 401,
      code: 'SESSION_REVOKED',
      detail: 'Phiên làm việc của bạn đã bị hủy hoặc bạn đã đăng xuất trên một thiết bị khác',
    });
  }

  // 4. Gán quyền và danh tính TỪ CƠ SỞ DỮ LIỆU vào req.user (Không tin role trong JWT payload)
  req.user = {
    id: dbUser.id,
    username: dbUser.username,
    role: dbUser.role as 'ADMIN' | 'VIEWER',
    session_version: dbUser.session_version,
  };
}

/**
 * Middleware kiểm soát phân quyền dựa trên vai trò (Role-Based Access Control)
 */
export function authorize(allowedRoles: ('ADMIN' | 'VIEWER')[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.user) {
      return reply.status(401).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Chưa được xác thực',
        status: 401,
        code: 'UNAUTHORIZED',
        detail: 'Cần xác thực danh tính trước khi kiểm tra phân quyền',
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return reply.status(403).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Quyền truy cập bị từ chối',
        status: 403,
        code: 'FORBIDDEN',
        detail: `Hành động này yêu cầu một trong các quyền sau: [${allowedRoles.join(', ')}]`,
      });
    }
  };
}
