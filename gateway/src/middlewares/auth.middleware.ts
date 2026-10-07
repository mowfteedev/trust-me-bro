import { FastifyRequest, FastifyReply } from 'fastify';

/**
 * ==============================================================================
 * MIDDLEWARE PHÂN QUYỀN TRUY CẬP RBAC (auth.middleware.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: security (chủ trì), backend
 * ==============================================================================
 *
 * LÝ DO PHI TRỰC GIÁC (RATIONALE):
 * Không tin tưởng dữ liệu client tự khai báo trong token. Chữ ký JWT HMAC-SHA256 được
 * thẩm định nghiêm ngặt qua Fastify JWT Plugin. Nếu token dùng thuật toán 'none' hoặc
 * bị chỉnh sửa role từ VIEWER thành ADMIN thì chữ ký sẽ lập tức không hợp lệ (Signature Mismatch).
 */

export interface AuthUserPayload {
  id: string;
  username: string;
  role: 'ADMIN' | 'VIEWER';
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUserPayload;
  }
}

/**
 * Middleware thẩm định tính hợp lệ của JSON Web Token
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.status(401).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Chưa được xác thực',
        status: 401,
        code: 'UNAUTHORIZED',
        detail: 'Yêu cầu cung cấp Bearer Token hợp lệ trong tiêu đề Authorization',
      });
      return;
    }

    const payload = await req.jwtVerify<AuthUserPayload>();
    req.user = payload;
  } catch (err: any) {
    reply.status(401).send({
      type: 'https://tools.ietf.org/html/rfc7807',
      title: 'Xác thực thất bại',
      status: 401,
      code: 'INVALID_TOKEN',
      detail: 'Mã xác thực JWT không hợp lệ hoặc đã hết hạn',
    });
  }
}

/**
 * Middleware kiểm soát phân quyền dựa trên vai trò (Role-Based Access Control)
 */
export function authorize(allowedRoles: ('ADMIN' | 'VIEWER')[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.user) {
      reply.status(401).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Chưa được xác thực',
        status: 401,
        code: 'UNAUTHORIZED',
        detail: 'Cần xác thực danh tính trước khi kiểm tra phân quyền',
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      reply.status(403).send({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Quyền truy cập bị từ chối',
        status: 403,
        code: 'FORBIDDEN',
        detail: `Hành động này yêu cầu một trong các quyền sau: [${allowedRoles.join(', ')}]`,
      });
      return;
    }
  };
}
