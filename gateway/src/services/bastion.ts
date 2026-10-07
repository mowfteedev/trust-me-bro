import fs from 'node:fs';
import { Client } from 'ssh2';
import type { WebSocket } from 'ws';
import { config } from '../config/env.js';
import { query } from './db.js';
import { generateSecureToken } from '../utils/crypto.js';

/**
 * ==============================================================================
 * DỊCH VỤ CẦU NỐI WEB SSH PTY BASTION BRIDGE (bastion.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: backend (chủ trì), security, tester
 * ==============================================================================
 *
 * LÝ DO PHI TRỰC GIÁC (RATIONALE):
 * 1. Chống crash Shell PTY (BUG-004): Bộ kẹp biên (Clamping Guard) bắt buộc phải ép giá trị
 *    rows về [10, 200] và cols về [20, 500]. Kẻ xấu gửi số âm hoặc số cực đại để làm vỡ
 *    bộ đệm kernel SIGWINCH sẽ bị triệt tiêu hoàn toàn.
 * 2. Bảo mật phiên WebSocket: Không truyền JWT qua URL query string (sẽ bị rò rỉ vào Access Log).
 *    Sử dụng One-Time Ticket có thời hạn 30 giây và tiêu hủy ngay sau khi xác thực thành công.
 * 3. Ẩn thông tin nhạy cảm: Mọi lỗi rớt mạng hoặc từ chối kết nối SSH đều được bọc mã lỗi
 *    chuẩn 4502 trước khi trả về trình duyệt.
 */

interface BastionTicket {
  nodeId: string;
  userId: string;
  expiresAt: number;
}

// Bảng lưu trữ One-Time Ticket trong bộ nhớ RAM
const ticketStore = new Map<string, BastionTicket>();

// Dọn dẹp các ticket hết hạn mỗi 30 giây
setInterval(() => {
  const now = Date.now();
  for (const [ticket, data] of ticketStore.entries()) {
    if (data.expiresAt < now) {
      ticketStore.delete(ticket);
    }
  }
}, 30000).unref();

/**
 * Cấp phát One-Time Ticket dùng một lần để kết nối Web SSH
 */
export function createBastionTicket(nodeId: string, userId: string): string {
  const ticket = generateSecureToken(32);
  ticketStore.set(ticket, {
    nodeId,
    userId,
    expiresAt: Date.now() + 30000, // Hạn dùng 30 giây
  });
  return ticket;
}

/**
 * Thẩm định và tiêu hủy vé dùng một lần
 */
export function verifyAndConsumeTicket(ticket: string, nodeId: string): { valid: boolean; userId?: string } {
  const ticketData = ticketStore.get(ticket);
  if (!ticketData) {
    return { valid: false };
  }

  // Tiêu hủy vé ngay lập tức (Single-Use Guard)
  ticketStore.delete(ticket);

  if (ticketData.expiresAt < Date.now()) {
    return { valid: false };
  }

  if (ticketData.nodeId !== nodeId) {
    return { valid: false };
  }

  return { valid: true, userId: ticketData.userId };
}

/**
 * Kẹp biên tham số cửa sổ PTY Terminal chống crash tiến trình shell (BUG-004)
 */
export function clampPtyDimensions(rawRows: any, rawCols: any): { rows: number; cols: number } {
  const parsedRows = Math.floor(Number(rawRows)) || 24;
  const parsedCols = Math.floor(Number(rawCols)) || 80;

  const rows = Math.min(200, Math.max(10, parsedRows));
  const cols = Math.min(500, Math.max(20, parsedCols));

  return { rows, cols };
}

/**
 * Khởi tạo phiên cầu nối hai chiều giữa WebSocket và OpenSSH Channel
 */
export async function attachBastionSession(
  socket: WebSocket,
  nodeIdentifier: string,
  initialTicket: string
): Promise<void> {
  // 1. Thẩm định vé dùng một lần
  const authResult = verifyAndConsumeTicket(initialTicket, nodeIdentifier);
  if (!authResult.valid) {
    socket.send(JSON.stringify({ type: 'ERROR', message: 'Mã vé truy cập Web SSH không hợp lệ hoặc đã hết hạn' }));
    socket.close(4401, 'Unauthorized Ticket');
    return;
  }

  // 2. Tra cứu địa chỉ IP mạng ngầm WireGuard của Node
  let targetIp = '';
  let nodeName = nodeIdentifier;

  try {
    const nodeRes = await query(
      'SELECT id, name, ip_address FROM nodes WHERE (id::text = $1 OR name = $1) LIMIT 1;',
      [nodeIdentifier]
    );

    if (nodeRes.rows.length === 0) {
      socket.send(JSON.stringify({ type: 'ERROR', message: 'Không tìm thấy thông tin máy chủ con' }));
      socket.close(4404, 'Node Not Found');
      return;
    }

    targetIp = nodeRes.rows[0].ip_address;
    nodeName = nodeRes.rows[0].name;
  } catch (dbErr: any) {
    socket.send(JSON.stringify({ type: 'ERROR', message: 'Lỗi truy vấn cơ sở dữ liệu' }));
    socket.close(4500, 'Database Error');
    return;
  }

  // 3. Đọc tệp khóa riêng Ed25519
  let privateKeyContent: Buffer;
  try {
    privateKeyContent = fs.readFileSync(config.BASTION_SSH_KEY_PATH);
  } catch (fsErr: any) {
    console.error('❌ [BASTION ERROR] Không thể đọc khóa riêng SSH:', fsErr.message);
    socket.send(JSON.stringify({ type: 'ERROR', message: 'Lỗi cấu hình khóa xác thực Bastion Gateway' }));
    socket.close(4500, 'SSH Key Missing');
    return;
  }

  // 4. Khởi tạo đối tượng SSH2 Client
  const sshClient = new Client();
  let sshStream: any = null;

  sshClient.on('ready', () => {
    // Mở luồng PTY tương tác với kích thước mặc định 80x24
    sshClient.shell(
      {
        term: 'xterm-256color',
        rows: 24,
        cols: 80,
      },
      (err, stream) => {
        if (err) {
          console.error('❌ [BASTION ERROR] Không thể cấp phát PTY Shell:', err.message);
          socket.send(JSON.stringify({ type: 'ERROR', message: 'Không thể khởi tạo phiên PTY trên máy chủ' }));
          socket.close(4502, 'PTY Shell Failed');
          sshClient.end();
          return;
        }

        sshStream = stream;
        socket.send(JSON.stringify({ type: 'READY', message: `Đã kết nối thành công tới ${nodeName} (${targetIp})` }));

        // Đẩy luồng dữ liệu từ OpenSSH về trình duyệt qua WebSocket
        stream.on('data', (chunk: Buffer) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: 'DATA', data: chunk.toString('utf-8') }));
          }
        });

        stream.on('close', () => {
          if (socket.readyState === socket.OPEN) {
            socket.close(1000, 'Session Closed');
          }
          sshClient.end();
        });
      }
    );
  });

  sshClient.on('error', (err) => {
    console.error(`⚠️ [BASTION WARNING] Sự cố kết nối SSH tới ${targetIp}:`, err.message);
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'ERROR', message: 'Mất kết nối SSH với máy chủ đích' }));
      // Đóng WebSocket an toàn với mã 4502, che giấu chi tiết nhạy cảm
      socket.close(4502, 'SSH Connection Interrupted');
    }
  });

  // 5. Lắng nghe các frame tin nhắn từ trình duyệt Web
  socket.on('message', (rawMessage: string | Buffer) => {
    try {
      const frame = JSON.parse(rawMessage.toString('utf-8'));

      if (frame.type === 'DATA' && typeof frame.data === 'string' && sshStream) {
        sshStream.write(frame.data);
      } else if (frame.type === 'RESIZE' && sshStream) {
        // CHÚ THÍCH BẢO MẬT: Bắt buộc kẹp biên để bảo vệ an toàn Shell Process
        const { rows, cols } = clampPtyDimensions(frame.rows, frame.cols);
        sshStream.setWindow(rows, cols, 0, 0);
      }
    } catch {
      // Bỏ qua gói tin không đúng định dạng JSON
    }
  });

  socket.on('close', () => {
    if (sshClient) {
      sshClient.end();
    }
  });

  // 6. Thực hiện kết nối tới IP WireGuard trên cổng 22
  sshClient.connect({
    host: targetIp,
    port: 22,
    username: config.BASTION_DEFAULT_USER,
    privateKey: privateKeyContent,
    readyTimeout: config.BASTION_CONNECT_TIMEOUT_MS,
    // hostVerifier: Chấp nhận khóa máy chủ trong mạng ngầm nội bộ được bảo vệ bởi WireGuard
    hostVerifier: () => true,
  });
}
