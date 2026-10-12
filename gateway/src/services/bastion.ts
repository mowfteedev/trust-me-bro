import fs from 'node:fs';
import net from 'node:net';
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
 * 4. Zero Trust Fail-Closed (R1 Fix): Tuyệt đối không fallback sang shell cục bộ trên Gateway.
 *    Nếu kết nối SSH tới máy chủ đích thất bại, phiên sẽ bị ngắt lập tức với mã 4502.
 * 5. Chống cạn kiệt RAM (H4 Fix): Áp dụng WebSocket Backpressure. Nếu bufferedAmount > 64KB,
 *    tạm dừng (pause) luồng đọc từ SSH cho đến khi buffer mạng xả sạch (drain).
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

  // Ghi nhận bắt đầu phiên Bastion vào Audit Log
  if (authResult.userId) {
    await query(
      `INSERT INTO audit_logs (user_id, action, target, details, ip_address)
       VALUES ($1, 'BASTION_SESSION_START', 'bastion', $2, $3::inet);`,
      [authResult.userId, JSON.stringify({ node_id: nodeIdentifier, target_ip: targetIp }), '127.0.0.1']
    ).catch(() => {});
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
  let isClosed = false;

  const closeSession = (code: number, reason: string, userMsg?: string) => {
    if (isClosed) return;
    isClosed = true;

    if (userMsg && socket.readyState === 1) {
      try {
        socket.send(JSON.stringify({ type: 'ERROR', message: userMsg }));
      } catch {}
    }

    if (sshStream && typeof sshStream.end === 'function') {
      try { sshStream.end(); } catch {}
    }

    if (sshClient) {
      try { sshClient.end(); } catch {}
    }

    if (socket.readyState === 1) {
      try {
        if (code === 4502) {
          socket.close(4502, 'SSH Connection Interrupted');
        } else {
          socket.close(code, reason);
        }
      } catch {}
    }

    // Ghi nhận kết thúc phiên Bastion vào Audit Log
    if (authResult.userId) {
      query(
        `INSERT INTO audit_logs (user_id, action, target, details, ip_address)
         VALUES ($1, 'BASTION_SESSION_END', 'bastion', $2, $3::inet);`,
        [authResult.userId, JSON.stringify({ node_id: nodeIdentifier, code, reason }), '127.0.0.1']
      ).catch(() => {});
    }
  };

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
          closeSession(4502, 'SSH Connection Interrupted', 'Không thể khởi tạo phiên PTY trên máy chủ');
          return;
        }

        sshStream = stream;
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'READY', message: `Đã kết nối thành công tới ${nodeName} (${targetIp})` }));
        }

        // Lắng nghe drain để phục hồi luồng đọc (Backpressure recovery)
        const rawSocket = (socket as any)._socket;
        if (rawSocket && typeof rawSocket.on === 'function') {
          rawSocket.on('drain', () => {
            if (sshStream && typeof sshStream.resume === 'function') {
              sshStream.resume();
            }
          });
        }

        // Đẩy luồng dữ liệu từ OpenSSH về trình duyệt qua WebSocket (Raw Byte Stream)
        stream.on('data', (chunk: Buffer) => {
          if (socket.readyState === 1) {
            try {
              socket.send(chunk.toString('utf-8'));
              // WebSocket Backpressure Guard: nếu bufferedAmount > 64KB thì tạm dừng SSH stream
              if ((socket as any).bufferedAmount > 65536 && typeof stream.pause === 'function') {
                stream.pause();
              }
            } catch (sendErr) {
              console.warn('⚠️ [BASTION SEND ERROR]', sendErr);
            }
          }
        });

        stream.on('error', (streamErr: any) => {
          console.warn('⚠️ [BASTION STREAM ERROR]', streamErr.message);
          closeSession(4502, 'SSH Connection Interrupted', 'Mất kết nối SSH với máy chủ đích');
        });

        stream.on('close', () => {
          closeSession(1000, 'Session Closed');
        });
      }
    );
  });

  sshClient.on('error', (err) => {
    console.warn(`⚠️ [BASTION ERROR] Sự cố kết nối SSH tới ${targetIp}:`, err.message);
    // Zero Trust Fail-Closed: Không bao giờ fallback sang container gateway!
    closeSession(4502, 'SSH Connection Interrupted', 'Mất kết nối SSH với máy chủ đích');
  });

  // 5. Lắng nghe các frame tin nhắn từ trình duyệt Web (Dual-Mode: Hỗ trợ cả Raw Stream và JSON)
  socket.on('message', (rawMessage: string | Buffer) => {
    try {
      const text = rawMessage.toString('utf-8');

      // 1. Frame điều khiển JSON (RESIZE, DATA cũ)
      if (text.startsWith('{') && text.includes('"type"')) {
        try {
          const frame = JSON.parse(text);
          if (frame.type === 'RESIZE' && sshStream && typeof sshStream.setWindow === 'function') {
            // CHÚ THÍCH BẢO MẬT: Bắt buộc kẹp biên để bảo vệ an toàn Shell Process
            const { rows, cols } = clampPtyDimensions(frame.rows, frame.cols);
            sshStream.setWindow(rows, cols, 0, 0);
            return;
          } else if (frame.type === 'DATA' && typeof frame.data === 'string' && sshStream) {
            sshStream.write(frame.data);
            return;
          }
        } catch {
          // Bỏ qua lỗi parse
        }
      }

      // 2. Mặc định: Luồng dữ liệu phím thô siêu tốc (Raw Stream)
      if (sshStream && typeof sshStream.write === 'function') {
        sshStream.write(rawMessage);
      }
    } catch {
      // Bỏ qua lỗi write
    }
  });

  socket.on('error', (sockErr: any) => {
    console.warn('⚠️ [BASTION WS ERROR]', sockErr.message);
    closeSession(4502, 'SSH Connection Interrupted');
  });

  socket.on('close', () => {
    closeSession(1000, 'Session Closed');
  });

  // 6. Thăm dò siêu tốc cổng 22 (Fast Zero Trust Probe)
  let probeDone = false;
  const probeSocket = new net.Socket();

  const handleProbeFailure = () => {
    if (probeDone) return;
    probeDone = true;
    try { probeSocket.destroy(); } catch {}
    // Zero Trust Fail-Closed: Cổng 22 không mở hoặc probe timeout -> đóng phiên an toàn 4502
    closeSession(4502, 'SSH Connection Interrupted', 'Không thể kết nối SSH tới máy chủ đích qua mạng ngầm (Cổng 22 không phản hồi)');
  };

  probeSocket.setTimeout(300);
  probeSocket.on('connect', () => {
    if (probeDone) return;
    probeDone = true;
    try { probeSocket.destroy(); } catch {}

    // Cổng 22 có mở -> kết nối SSH2 Client
    try {
      sshClient.connect({
        host: targetIp,
        port: 22,
        username: config.BASTION_DEFAULT_USER,
        privateKey: privateKeyContent,
        readyTimeout: 3000,
        hostVerifier: () => true,
      });
    } catch {
      handleProbeFailure();
    }
  });

  probeSocket.on('timeout', handleProbeFailure);
  probeSocket.on('error', handleProbeFailure);

  try {
    probeSocket.connect(22, targetIp);
  } catch {
    handleProbeFailure();
  }
}
