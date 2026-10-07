import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { createBastionTicket, attachBastionSession } from '../services/bastion.js';

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
      const user = req.user as any;
      const ticket = createBastionTicket(node_id, user.id);

      return reply.status(200).send({
        success: true,
        ticket,
        expires_in_seconds: 30,
      });
    }
  );

  /**
   * WebSocket /ws/terminal/:node_id
   * Điểm cuối tương tác luồng nhị phân dòng lệnh hai chiều PTY
   */
  fastify.get('/ws/terminal/:node_id', { websocket: true }, (connection, req) => {
    const { node_id } = req.params as { node_id: string };
    const socket = connection.socket;

    // Lắng nghe gói tin đầu tiên để xác thực vé One-Time Ticket
    const authTimeout = setTimeout(() => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'ERROR', message: 'Hết thời gian chờ gửi vé xác thực Handshake' }));
        socket.close(4408, 'Handshake Timeout');
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
  });
};
