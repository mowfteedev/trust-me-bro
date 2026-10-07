import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { NodeItem } from '../types/index.js';
import { api } from '../services/api.js';
import { X, Maximize2, Minimize2, RefreshCw, ShieldCheck, Terminal as TerminalIcon } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

interface TerminalModalProps {
  node: NodeItem;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * ==============================================================================
 * CỬA SỔ DÒNG LỆNH NHÚNG XTERM.JS CANVAS (components/TerminalModal.tsx)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: frontend (chủ trì), backend, security
 * ==============================================================================
 *
 * LÝ DO PHI TRỰC GIÁC (RATIONALE):
 * 1. Không truyền Token qua Query Params trên URL kết nối WebSocket (tránh bị lưu
 *    vào Access Log của Caddy). Bắt buộc xin cấp One-Time Ticket 30s qua API trước,
 *    sau đó gửi gói tin handshake đầu tiên: { type: 'AUTH', ticket }.
 * 2. Kẹp biên RESIZE và tự động gọi FitAddon khi modal thay đổi kích thước.
 * 3. Hủy bỏ sạch sẽ WebSocket, FitAddon và Terminal instance trong hàm cleanup của useEffect
 *    để triệt tiêu 100% rủi ro rò rỉ bộ nhớ (Memory Leak) trong trình duyệt.
 */

export const TerminalModal: React.FC<TerminalModalProps> = ({ node, isOpen, onClose }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR'>('CONNECTING');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    let isSubscribed = true;
    setConnectionStatus('CONNECTING');
    setErrorMessage(null);

    // 1. Khởi tạo đối tượng xterm.js với cấu hình bảng màu Cyber Dark
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'JetBrains Mono, Fira Code, monospace',
      theme: {
        background: '#090d16',
        foreground: '#e5e7eb',
        cursor: '#06b6d4',
        selectionBackground: 'rgba(6, 182, 212, 0.3)',
        black: '#1f2937',
        red: '#ef4444',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#f9fafb',
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    if (terminalRef.current) {
      terminalRef.current.innerHTML = '';
      term.open(terminalRef.current);
      fitAddon.fit();
    }

    term.writeln('\x1b[36m⚡ [ZT-SERVEROPS] Đang khởi tạo kết nối đường hầm mã hóa WireGuard Web SSH...\x1b[0m');

    // 2. Lấy One-Time Ticket và kết nối WebSocket
    async function startConnection() {
      try {
        term.writeln('\x1b[33m🔑 Đang xin cấp vé xác thực One-Time Ticket...\x1b[0m');
        const ticket = await api.getBastionTicket(node.id);

        if (!isSubscribed) return;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/terminal/${encodeURIComponent(node.id)}`;

        const socket = new WebSocket(wsUrl);
        socketRef.current = socket;

        socket.onopen = () => {
          if (!isSubscribed) return;
          // Gửi gói tin AUTH đầu tiên
          socket.send(JSON.stringify({ type: 'AUTH', ticket }));
        };

        socket.onmessage = (event) => {
          if (!isSubscribed) return;
          try {
            const frame = JSON.parse(event.data);
            if (frame.type === 'DATA' && typeof frame.data === 'string') {
              term.write(frame.data);
            } else if (frame.type === 'READY') {
              setConnectionStatus('CONNECTED');
              term.writeln(`\r\n\x1b[32m✔ ${frame.message}\x1b[0m\r\n`);
              // Gửi gói tin RESIZE ban đầu
              fitAddon.fit();
              socket.send(JSON.stringify({ type: 'RESIZE', rows: term.rows, cols: term.cols }));
            } else if (frame.type === 'ERROR') {
              term.writeln(`\r\n\x1b[31m❌ [LỖI] ${frame.message}\x1b[0m\r\n`);
            }
          } catch {
            term.write(event.data);
          }
        };

        socket.onerror = () => {
          if (!isSubscribed) return;
          setConnectionStatus('ERROR');
          setErrorMessage('Không thể thiết lập kết nối WebSocket tới Gateway');
          term.writeln('\r\n\x1b[31m❌ [LỖI MẠNG] Không thể kết nối tới máy chủ Gateway.\x1b[0m');
        };

        socket.onclose = (event) => {
          if (!isSubscribed) return;
          setConnectionStatus('DISCONNECTED');
          term.writeln(`\r\n\x1b[33m🔌 Phiên làm việc đã kết thúc (Mã: ${event.code}).\x1b[0m`);
        };

        // Gửi ký tự người dùng nhập vào SSH stream
        term.onData((data) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'DATA', data }));
          }
        });
      } catch (err: any) {
        if (!isSubscribed) return;
        setConnectionStatus('ERROR');
        setErrorMessage(err.message || 'Lỗi khởi tạo phiên làm việc');
        term.writeln(`\r\n\x1b[31m❌ Lỗi: ${err.message}\x1b[0m`);
      }
    }

    startConnection();

    // 3. Lắng nghe thay đổi kích thước cửa sổ trình duyệt để tự động điều chỉnh rows/cols
    const handleResize = () => {
      if (fitAddonRef.current && termRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
        fitAddonRef.current.fit();
        socketRef.current.send(JSON.stringify({
          type: 'RESIZE',
          rows: termRef.current.rows,
          cols: termRef.current.cols,
        }));
      }
    };

    window.addEventListener('resize', handleResize);

    // 4. CLEANUP FUNCTION: Triệt tiêu 100% rò rỉ bộ nhớ
    return () => {
      isSubscribed = false;
      window.removeEventListener('resize', handleResize);
      if (socketRef.current) {
        socketRef.current.close(1000, 'Component Unmounted');
        socketRef.current = null;
      }
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }
    };
  }, [isOpen, node]);

  // Điều chỉnh kích thước khi toggle Full Screen
  useEffect(() => {
    const timer = setTimeout(() => {
      if (fitAddonRef.current && termRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
        fitAddonRef.current.fit();
        socketRef.current.send(JSON.stringify({
          type: 'RESIZE',
          rows: termRef.current.rows,
          cols: termRef.current.cols,
        }));
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [isFullScreen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 sm:p-6 animate-fadeIn">
      <div
        className={`flex flex-col rounded-2xl border border-neutral-800 bg-[#090d16] shadow-2xl transition-all duration-200 overflow-hidden ${
          isFullScreen ? 'h-full w-full' : 'h-[85vh] w-full max-w-5xl'
        }`}
      >
        {/* Header Terminal Modal */}
        <div className="flex h-14 items-center justify-between border-b border-neutral-800 bg-neutral-900/80 px-4">
          <div className="flex items-center space-x-3">
            <div className="rounded-lg bg-cyan-500/10 p-2 text-cyan-400">
              <TerminalIcon className="h-4 w-4" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-semibold text-sm text-neutral-100">{node.name}</span>
                <span className="font-mono text-xs text-neutral-400">({node.ip_address})</span>
                <span className="inline-flex items-center text-[10px] font-mono rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
                  <ShieldCheck className="h-3 w-3 mr-1 text-cyan-400" />
                  WireGuard Zero-Trust
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {/* Trạng thái kết nối */}
            <span className={`inline-flex items-center text-xs font-mono px-2 py-0.5 rounded-full ${
              connectionStatus === 'CONNECTED' ? 'bg-emerald-500/10 text-emerald-400' :
              connectionStatus === 'CONNECTING' ? 'bg-cyan-500/10 text-cyan-400 animate-pulse' :
              'bg-red-500/10 text-red-400'
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full mr-1.5 ${
                connectionStatus === 'CONNECTED' ? 'bg-emerald-400' :
                connectionStatus === 'CONNECTING' ? 'bg-cyan-400' : 'bg-red-400'
              }`} />
              {connectionStatus}
            </span>

            {/* Nút phóng to / thu nhỏ */}
            <button
              onClick={() => setIsFullScreen(!isFullScreen)}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
              title={isFullScreen ? 'Thu nhỏ' : 'Toàn màn hình'}
            >
              {isFullScreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>

            {/* Nút đóng Modal */}
            <button
              onClick={onClose}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl text-neutral-400 hover:bg-red-500/10 hover:text-red-400 transition-colors"
              title="Đóng Terminal"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Khung Terminal Canvas */}
        <div className="relative flex-1 p-3 bg-[#090d16] overflow-hidden">
          <div ref={terminalRef} className="h-full w-full" />
        </div>
      </div>
    </div>
  );
};
