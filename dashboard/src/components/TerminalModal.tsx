import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { NodeItem } from '../types/index.js';
import { api } from '../services/api.js';
import { X, Maximize2, Minimize2, ShieldCheck, RefreshCw, Terminal as TerminalIcon } from 'lucide-react';
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
 * 3. Đóng WebSocket, observer và terminal khi modal đóng hoặc người dùng thử lại.
 */

export const TerminalModal: React.FC<TerminalModalProps> = ({ node, isOpen, onClose }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR'>('CONNECTING');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const background = Array.from(document.querySelectorAll<HTMLElement>('.console-workspace, .sidebar'));
    const previousInert = background.map((element) => element.inert);
    background.forEach((element) => { element.inert = true; });
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();
    return () => {
      background.forEach((element, index) => { element.inert = previousInert[index]; });
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    let isSubscribed = true;
    let isReady = false;
    let readyTimeout: ReturnType<typeof setTimeout> | undefined;
    setConnectionStatus('CONNECTING');
    setErrorMessage(null);
    closeButtonRef.current?.focus();

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
        readyTimeout = setTimeout(() => {
          if (!isSubscribed || isReady) return;
          setConnectionStatus('ERROR');
          setErrorMessage('Quá thời gian chờ Gateway mở SSH. Kiểm tra VPN và SSH của Worker rồi thử lại.');
          socket.close(1000, 'SSH ready timeout');
        }, 30_000);

        socket.onopen = () => {
          if (!isSubscribed) return;
          // Gửi gói tin AUTH đầu tiên
          socket.send(JSON.stringify({ type: 'AUTH', ticket }));
        };

        socket.onmessage = (event) => {
          if (!isSubscribed) return;
          try {
            if (typeof event.data === 'string' && event.data.startsWith('{')) {
              const frame = JSON.parse(event.data);
              if (frame.type === 'DATA' && typeof frame.data === 'string') {
                term.write(frame.data);
                return;
              } else if (frame.type === 'READY') {
                clearTimeout(readyTimeout);
                isReady = true;
                setConnectionStatus('CONNECTED');
                term.focus();
                term.writeln(`\r\n\x1b[32m✔ ${frame.message}\x1b[0m\r\n`);
                // Gửi gói tin RESIZE ban đầu
                fitAddon.fit();
                socket.send(JSON.stringify({ type: 'RESIZE', rows: term.rows, cols: term.cols }));
                return;
              } else if (frame.type === 'ERROR') {
                clearTimeout(readyTimeout);
                isReady = false;
                setConnectionStatus('ERROR');
                setErrorMessage(frame.message || 'Gateway không thể mở phiên SSH.');
                term.writeln(`\r\n\x1b[31m❌ [LỖI] ${frame.message}\x1b[0m\r\n`);
                return;
              }
            }
            term.write(event.data);
          } catch {
            term.write(event.data);
          }
        };

        socket.onerror = () => {
          if (!isSubscribed) return;
          clearTimeout(readyTimeout);
          isReady = false;
          setConnectionStatus('ERROR');
          setErrorMessage('Không thể thiết lập kết nối WebSocket tới Gateway');
          term.writeln('\r\n\x1b[31m❌ [LỖI MẠNG] Không thể kết nối tới máy chủ Gateway.\x1b[0m');
        };

        socket.onclose = (event) => {
          if (!isSubscribed) return;
          clearTimeout(readyTimeout);
          isReady = false;
          setConnectionStatus((status) => status === 'ERROR' ? 'ERROR' : 'DISCONNECTED');
          term.writeln(`\r\n\x1b[33m🔌 Phiên làm việc đã kết thúc (Mã: ${event.code}).\x1b[0m`);
        };

        // Gửi ký tự người dùng nhập vào SSH stream (Raw Stream siêu tốc không độ trễ)
        term.onData((data) => {
          if (isReady && socket.readyState === WebSocket.OPEN) {
            socket.send(data);
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
      if (fitAddonRef.current && termRef.current) {
        fitAddonRef.current.fit();
        if (isReady && socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({
            type: 'RESIZE',
            rows: termRef.current.rows,
            cols: termRef.current.cols,
          }));
        }
      }
    };

    const observer = new ResizeObserver(handleResize);
    if (terminalRef.current) observer.observe(terminalRef.current);

    // 4. Release the resources owned by this connection attempt.
    return () => {
      isSubscribed = false;
      clearTimeout(readyTimeout);
      observer.disconnect();
      if (socketRef.current) {
        socketRef.current.close(1000, 'Component Unmounted');
        socketRef.current = null;
      }
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }
      fitAddonRef.current = null;
    };
  }, [isOpen, node.id, attempt]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-3 sm:p-6 animate-fadeIn"
      onKeyDownCapture={(event) => {
        // Plain Escape and Tab remain available to the remote shell and editors.
        if (event.altKey && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}>
      <div
        role="dialog" aria-modal="true" aria-label={`Terminal ${node.name}`}
        className={`flex min-w-0 flex-col rounded-2xl border border-neutral-800 bg-[#090d16] shadow-2xl transition-all duration-200 overflow-hidden ${
          isFullScreen ? 'h-full w-full' : 'h-[85vh] w-full max-w-5xl'
        }`}
      >
        {/* Header Terminal Modal */}
        <div className="flex shrink-0 flex-wrap gap-2 py-2 items-center justify-between border-b border-neutral-800 bg-neutral-900/80 px-4">
          <div className="flex min-w-0 items-center space-x-3">
            <div className="rounded-lg bg-cyan-500/10 p-2 text-cyan-400">
              <TerminalIcon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap gap-2 items-center">
                <span className="break-all font-semibold text-sm text-neutral-100">{node.name}</span>
                <span className="font-mono text-xs text-neutral-400">({node.ip_address})</span>
                <span className="inline-flex items-center text-[10px] font-mono rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
                  <ShieldCheck className="h-3 w-3 mr-1 text-cyan-400" />
                  SSH qua Gateway
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {/* Trạng thái kết nối */}
            <span role="status" className={`inline-flex items-center text-xs font-mono px-2 py-0.5 rounded-full ${
              connectionStatus === 'CONNECTED' ? 'bg-emerald-500/10 text-emerald-400' :
              connectionStatus === 'CONNECTING' ? 'bg-cyan-500/10 text-cyan-400 animate-pulse' :
              'bg-red-500/10 text-red-400'
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full mr-1.5 ${
                connectionStatus === 'CONNECTED' ? 'bg-emerald-400' :
                connectionStatus === 'CONNECTING' ? 'bg-cyan-400' : 'bg-red-400'
              }`} />
              {{ CONNECTED: 'Đã kết nối', CONNECTING: 'Đang kết nối', DISCONNECTED: 'Đã đóng', ERROR: 'Lỗi kết nối' }[connectionStatus]}
            </span>

            {/* Nút phóng to / thu nhỏ */}
            <button
              onClick={() => setIsFullScreen(!isFullScreen)}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
              title={isFullScreen ? 'Thu nhỏ' : 'Toàn màn hình'}
              aria-label={isFullScreen ? 'Thu nhỏ Terminal' : 'Phóng to Terminal'}
            >
              {isFullScreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>

            {/* Nút đóng Modal */}
            <button
              ref={closeButtonRef}
              onClick={onClose}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl text-neutral-400 hover:bg-red-500/10 hover:text-red-400 transition-colors"
              title="Đóng Terminal"
              aria-label="Đóng Terminal"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Banner cảnh báo lỗi nếu có */}
        {errorMessage && (
          <div role="alert" className="bg-red-950/40 border-b border-red-500/30 px-4 py-2 text-xs font-mono text-red-300">
            {errorMessage}
          </div>
        )}

        {/* Khung Terminal Canvas */}
        <div className="relative min-h-0 flex-1 p-3 bg-[#090d16] overflow-hidden">
          <div ref={terminalRef} className="h-full w-full" />
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-neutral-800 px-4 py-2 text-xs text-neutral-400">
          <span>Shell của Worker · Alt + Esc để đóng</span>
          {(connectionStatus === 'DISCONNECTED' || connectionStatus === 'ERROR') && (
            <button className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-neutral-700 px-3 text-cyan-300 hover:bg-neutral-800"
              onClick={() => setAttempt((value) => value + 1)}>
              <RefreshCw size={14} /> Mở phiên mới
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
