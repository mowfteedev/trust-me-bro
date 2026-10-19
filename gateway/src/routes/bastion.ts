import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { authenticate, authorize, AuthUserPayload } from '../middlewares/auth.middleware.js';
import { createBastionTicket, attachBastionSession } from '../services/bastion.js';
import { query } from '../services/db.js';
import { normalizeClientIp } from '../utils/client-ip.js';

/**
 * ==============================================================================
 * TUYẾN ĐIỀU HƯỚNG WEB SSH BASTION PTY (routes/bastion.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: backend (chủ trì), security, tester
 * ==============================================================================
 */

const TicketRequestSchema = z.object({
  node_id: z.string().min(1),
});

export const bastionRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * POST /api/bastion/ticket
   * Cấp phát One-Time Ticket kết nối Terminal (Chỉ cấp quyền cho ADMIN)
   */
  fastify.post(
    '/ticket',
    { preHandler: [authenticate, authorize(['ADMIN'])] },
    async (req, reply) => {
      const parseResult = TicketRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Dữ liệu không hợp lệ',
          status: 400,
          code: 'INVALID_REQUEST',
          detail: 'Yêu cầu truyền node_id hợp lệ',
        });
      }

      const { node_id } = parseResult.data;
      const user = req.user as AuthUserPayload;

      // Giới hạn thời hạn ticket theo thời hạn JWT còn lại (tối đa 30s) (R04 Remediation)
      const now = Date.now();
      const authExpiresAt = user.authExpiresAt || (user.exp ? user.exp * 1000 : now + 30000);
      const remainingSeconds = Math.floor((authExpiresAt - now) / 1000);

      if (remainingSeconds <= 0) {
        return reply.status(401).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Mã xác thực đã hết hạn',
          status: 401,
          code: 'TOKEN_EXPIRED',
          detail: 'Mã xác thực JWT đã hết hạn, không thể cấp vé kết nối Web SSH',
        });
      }

      const ttlSeconds = Math.min(30, remainingSeconds);
      const ticket = createBastionTicket(node_id, user.id, user.session_version, ttlSeconds, authExpiresAt);

      // Ghi nhận sự kiện cấp vé Bastion vào audit_logs - BẮT BUỘC THÀNH CÔNG (FAIL-CLOSED)
      const clientIp = normalizeClientIp(req.ip);
      try {
        await query(
          `INSERT INTO audit_logs (user_id, action, target, details, ip_address)
           VALUES ($1, 'BASTION_TICKET_ISSUED', 'bastion', $2, $3::inet);`,
          [user.id, JSON.stringify({ node_id }), clientIp]
        );
      } catch (auditErr: any) {
        req.log.error({ auditErr }, 'Lỗi ghi audit log khi cấp vé Bastion - Fail-Closed kích hoạt');
        return reply.status(503).send({
          type: 'https://tools.ietf.org/html/rfc7807',
          title: 'Lỗi ghi nhận nhật ký kiểm toán',
          status: 503,
          code: 'AUDIT_LOG_FAILURE',
          detail: 'Hành động đặc quyền bị từ chối do không thể lưu vết kiểm toán an toàn',
        });
      }

      return reply.status(200).send({
        success: true,
        ticket,
        expires_in_seconds: ttlSeconds,
      });
    }
  );

  /**
   * WebSocket handler dùng chung cho cả /ws/terminal/:node_id và /api/bastion/ws/terminal/:node_id
   */
  const handleWsTerminal = (socket: WebSocket, req: FastifyRequest) => {
    const { node_id } = req.params as { node_id: string };

    // Lắng nghe gói tin đầu tiên để xác thực vé One-Time Ticket
    const authTimeout = setTimeout(() => {
      try {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'ERROR', message: 'Hết thời gian chờ gửi vé xác thực Handshake' }));
          socket.close(4408, 'Handshake Timeout');
        }
      } catch {
        // Ngăn chặn crash tiến trình nếu socket đột ngột bị hủy
      }
    }, 5000);

    socket.once('message', (firstMessage: string | Buffer) => {
      clearTimeout(authTimeout);
      try {
        const payload = JSON.parse(firstMessage.toString('utf-8'));
        if (payload.type === 'AUTH' && typeof payload.ticket === 'string') {
          // Bắt đầu gán luồng phiên Bastion
          attachBastionSession(socket, node_id, payload.ticket, req.ip);
        } else {
          socket.send(JSON.stringify({ type: 'ERROR', message: 'Gói tin đầu tiên bắt buộc phải là vé AUTH' }));
          socket.close(4401, 'Unauthorized');
        }
      } catch {
        socket.send(JSON.stringify({ type: 'ERROR', message: 'Định dạng gói tin xác thực không hợp lệ' }));
        socket.close(4400, 'Bad Request');
      }
    });
  };

  // Đăng ký cả hai tuyến đường để nhận diện từ cả Gateway lẫn Dashboard
  fastify.get('/ws/terminal/:node_id', { websocket: true }, handleWsTerminal);
  fastify.get('/terminal/:node_id', { websocket: true }, handleWsTerminal);
};
