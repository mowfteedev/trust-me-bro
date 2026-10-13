import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, authorize, AuthUserPayload } from '../middlewares/auth.middleware.js';
import { createBastionTicket, attachBastionSession } from '../services/bastion.js';
import { query } from '../services/db.js';

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

      // Giới hạn thời hạn ticket theo thời hạn JWT còn lại (tối đa 30s)
      const jwtExp = (req.user as any).exp ? ((req.user as any).exp * 1000 - Date.now()) : 30000;
      const ttlSeconds = Math.max(5, Math.min(30, Math.floor(jwtExp / 1000)));

      const ticket = createBastionTicket(node_id, user.id, user.session_version, ttlSeconds);

      // Ghi nhận sự kiện cấp vé Bastion vào audit_logs - BẮT BUỘC THÀNH CÔNG (FAIL-CLOSED)
      const clientIp = (req.ip || '127.0.0.1').replace(/^::ffff:/, '');
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
  const handleWsTerminal = (connection: any, req: any) => {
    const { node_id } = req.params as { node_id: string };
    const socket = connection?.socket || connection;

    if (!socket || typeof socket.on !== 'function') {
      req.log.error('WebSocket connection không hợp lệ hoặc thiếu đối tượng socket');
      return;
    }

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
          attachBastionSession(socket, node_id, payload.ticket);
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
