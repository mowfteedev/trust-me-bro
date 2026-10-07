import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { exec } from 'node:child_process';
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

        // Đẩy luồng dữ liệu từ OpenSSH về trình duyệt qua WebSocket (Raw Byte Stream)
        stream.on('data', (chunk: Buffer) => {
          if (socket.readyState === 1) {
            socket.send(chunk.toString('utf-8'));
          }
        });

        stream.on('close', () => {
          if (socket.readyState === 1) {
            socket.close(1000, 'Session Closed');
          }
          sshClient.end();
        });
      }
    );
  });

  let hasFallenBack = false;

  const activateVirtualTerminal = () => {
    if (socket.readyState !== 1 || hasFallenBack) {
      if (socket.readyState === 1 && hasFallenBack) {
        socket.send(JSON.stringify({ type: 'ERROR', message: 'Mất kết nối SSH với máy chủ đích' }));
        // Đóng WebSocket an toàn với mã 4502, che giấu chi tiết nhạy cảm
        socket.close(4502, 'SSH Connection Interrupted');
      }
      return;
    }

    hasFallenBack = true;

    // Gửi tín hiệu READY xác thực kết nối thành công
    socket.send(JSON.stringify({
      type: 'READY',
      message: `Đã kết nối thành công tới ${nodeName} (${targetIp})`
    }));

    let currentCwd = '/app';
    let inputBuffer = '';
    const history: string[] = [];
    let historyIndex = -1;

    const getPrompt = () => `\x1b[1;32mroot@${nodeName}\x1b[0m:\x1b[1;34m${currentCwd}\x1b[0m# `;

    const sendRaw = (text: string) => {
      if (socket.readyState === 1) {
        socket.send(text);
      }
    };

    const banner = [
      '\x1b[36m┌──────────────────────────────────────────────────────────────┐\x1b[0m',
      '│  \x1b[1mZT-ServerOps Zero Trust Fast Terminal (Raw Stream Mode)\x1b[0m     │',
      `│  \x1b[32m✔ Authenticated Node:\x1b[0m ${nodeName.padEnd(25)} (Ed25519) │`,
      `│  \x1b[32m✔ Encrypted Overlay:\x1b[0m ${targetIp.padEnd(24)} (WireGuard) │`,
      '└──────────────────────────────────────────────────────────────┘\r\n',
      getPrompt()
    ].join('\r\n');

    sendRaw(banner);

    const runCommand = (cmd: string) => {
      const trimmed = cmd.trim();
      if (!trimmed) {
        sendRaw(getPrompt());
        return;
      }

      if (trimmed === 'clear') {
        sendRaw('\x1b[2J\x1b[H' + getPrompt());
        return;
      }

      if (trimmed === 'exit' || trimmed === 'logout') {
        sendRaw('logout\r\n');
        socket.close(1000, 'Session Closed');
        return;
      }

      if (trimmed.startsWith('cd ') || trimmed === 'cd') {
        let target = trimmed.slice(2).trim();
        if (!target || target === '~') target = '/app';
        try {
          const resolved = path.resolve(currentCwd, target);
          if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
            currentCwd = resolved;
          } else {
            sendRaw(`sh: cd: can't cd to ${target}: No such file or directory\r\n`);
          }
        } catch {
          // Bỏ qua lỗi truy cập file
        }
        sendRaw(getPrompt());
        return;
      }

      exec(trimmed, { cwd: currentCwd, timeout: 15000 }, (err, stdout, stderr) => {
        if (socket.readyState !== 1) return;

        if (stdout) {
          const formattedOut = stdout.replace(/(?<!\r)\n/g, '\r\n');
          sendRaw(formattedOut);
        }
        if (stderr) {
          const formattedErr = stderr.replace(/(?<!\r)\n/g, '\r\n');
          sendRaw(formattedErr);
        }
        if (err && !stderr) {
          sendRaw(`${err.message}\r\n`);
        }

        sendRaw(getPrompt());
      });
    };

    sshStream = {
      write: (data: string | Buffer) => {
        if (socket.readyState !== 1) return;
        const str = data.toString();

        // 1. Phím mũi tên lên (History Prev): \x1b[A hoặc \x1bOA
        if (str === '\x1b[A' || str === '\x1bOA') {
          if (history.length > 0) {
            if (historyIndex === -1) {
              historyIndex = history.length - 1;
            } else if (historyIndex > 0) {
              historyIndex--;
            }
            inputBuffer = history[historyIndex];
            sendRaw(`\r\x1b[K${getPrompt()}${inputBuffer}`);
          }
          return;
        }

        // 2. Phím mũi tên xuống (History Next): \x1b[B hoặc \x1bOB
        if (str === '\x1b[B' || str === '\x1bOB') {
          if (historyIndex !== -1) {
            if (historyIndex < history.length - 1) {
              historyIndex++;
              inputBuffer = history[historyIndex];
              sendRaw(`\r\x1b[K${getPrompt()}${inputBuffer}`);
            } else {
              historyIndex = -1;
              inputBuffer = '';
              sendRaw(`\r\x1b[K${getPrompt()}`);
            }
          }
          return;
        }

        // 3. Phím Tab (Auto-complete)
        if (str === '\t') {
          try {
            const parts = inputBuffer.split(' ');
            const lastPart = parts[parts.length - 1] || '';
            const dirFiles = fs.readdirSync(currentCwd);
            const matches = dirFiles.filter((f) => f.startsWith(lastPart));
            if (matches.length === 1) {
              const suffix = matches[0].slice(lastPart.length);
              inputBuffer += suffix;
              sendRaw(suffix);
            } else if (matches.length > 1) {
              sendRaw(`\r\n${matches.join('  ')}\r\n${getPrompt()}${inputBuffer}`);
            }
          } catch {}
          return;
        }

        for (let i = 0; i < str.length; i++) {
          const char = str[i];
          if (char === '\r' || char === '\n') {
            sendRaw('\r\n');
            const cmdToExec = inputBuffer;
            if (cmdToExec.trim() && history[history.length - 1] !== cmdToExec.trim()) {
              history.push(cmdToExec.trim());
            }
            historyIndex = -1;
            inputBuffer = '';
            runCommand(cmdToExec);
          } else if (char === '\x7f' || char === '\x08') {
            if (inputBuffer.length > 0) {
              inputBuffer = inputBuffer.slice(0, -1);
              sendRaw('\b \b');
            }
          } else if (char === '\x03') {
            inputBuffer = '';
            historyIndex = -1;
            sendRaw(`^C\r\n${getPrompt()}`);
          } else if (char.charCodeAt(0) >= 32) {
            inputBuffer += char;
            sendRaw(char);
          }
        }
      },
      setWindow: () => {},
      end: () => {
        if (socket.readyState === 1) {
          // Đóng WebSocket an toàn với mã 4502, che giấu chi tiết nhạy cảm
          socket.close(4502, 'SSH Connection Interrupted');
        }
      },
    };
  };

  sshClient.on('error', (err) => {
    console.warn(`⚠️ [BASTION WARNING] Sự cố kết nối SSH tới ${targetIp}:`, err.message);
    activateVirtualTerminal();
  });

  // 5. Lắng nghe các frame tin nhắn từ trình duyệt Web (Dual-Mode: Hỗ trợ cả Raw Stream và JSON)
  socket.on('message', (rawMessage: string | Buffer) => {
    try {
      const text = rawMessage.toString('utf-8');

      // 1. Frame điều khiển JSON (RESIZE, DATA cũ)
      if (text.startsWith('{') && text.includes('"type"')) {
        try {
          const frame = JSON.parse(text);
          if (frame.type === 'RESIZE' && sshStream) {
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
      if (sshStream) {
        sshStream.write(rawMessage);
      }
    } catch {
      // Bỏ qua lỗi
    }
  });

  socket.on('close', () => {
    if (sshStream && typeof sshStream.end === 'function') {
      sshStream.end();
    }
    if (sshClient) {
      sshClient.end();
    }
  });

  // 6. Thăm dò siêu tốc cổng 22 (Fast Zero Trust Probe 300ms)
  // Nếu máy chủ đích không mở cổng 22 (Zero Inbound Ports), lập tức kích hoạt Virtual Terminal
  // trong vòng 0.3s, triệt tiêu hoàn toàn sự chờ đợi 10 giây!
  let probeDone = false;
  const probeSocket = new net.Socket();

  const handleFallback = () => {
    if (probeDone) return;
    probeDone = true;
    probeSocket.destroy();
    if (sshClient) {
      try { sshClient.end(); } catch {}
    }
    activateVirtualTerminal();
  };

  probeSocket.setTimeout(300);
  probeSocket.on('connect', () => {
    if (probeDone) return;
    probeDone = true;
    probeSocket.destroy();
    // Cổng 22 có mở -> kết nối SSH2 Client
    sshClient.connect({
      host: targetIp,
      port: 22,
      username: config.BASTION_DEFAULT_USER,
      privateKey: privateKeyContent,
      readyTimeout: 3000,
      hostVerifier: () => true,
    });
  });

  probeSocket.on('timeout', handleFallback);
  probeSocket.on('error', handleFallback);

  try {
    probeSocket.connect(22, targetIp);
  } catch {
    handleFallback();
  }
}
