import { config } from '../config/env.js';
import { generateNumericOtp } from '../utils/crypto.js';

/**
 * ==============================================================================
 * DỊCH VỤ CẢNH BÁO ON-CALL TELEGRAM BOT (telegram.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: backend (chủ trì), security
 * ==============================================================================
 *
 * LÝ DO PHI TRỰC GIÁC (RATIONALE):
 * BUG-005 Phòng ngừa: Tuyệt đối không tự động lấy chatId của tin nhắn đầu tiên trên internet.
 * Hệ thống sinh một mã One-Time Pairing Code (OTP) ngẫu nhiên 6 chữ số in ra màn hình console máy chủ.
 * Quản trị viên bắt buộc phải chat trực tiếp: /pair <MÃ_OTP> mới được kích hoạt quyền nhận cảnh báo.
 */

class TelegramService {
  private botToken: string;
  private pairOtp: string;
  private pairedChatId: string | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastUpdateId: number = 0;

  constructor() {
    this.botToken = config.TELEGRAM_BOT_TOKEN || '';
    // Sử dụng OTP từ biến môi trường hoặc tự động sinh ngẫu nhiên lúc khởi động
    this.pairOtp = config.TELEGRAM_PAIR_OTP || generateNumericOtp(6);

    if (this.botToken) {
      console.log('🤖 [TELEGRAM BOT] Đã kích hoạt dịch vụ thông báo On-Call.');
      console.log(`🔐 [TELEGRAM OTP] Mã ghép nối quản trị viên (Pairing OTP): \x1b[33m${this.pairOtp}\x1b[0m`);
      console.log(`💬 [TELEGRAM HƯỚNG DẪN] Gửi tin nhắn: /pair ${this.pairOtp} tới Bot để nhận cảnh báo.`);
      this.startPolling();
    } else {
      console.log('ℹ️ [TELEGRAM BOT] TELEGRAM_BOT_TOKEN chưa được thiết lập. Tính năng thông báo tạm tắt.');
    }
  }

  /**
   * Lấy mã OTP hiện tại (phục vụ kiểm thử và hiển thị)
   */
  public getPairOtp(): string {
    return this.pairOtp;
  }

  /**
   * Kiểm tra xem Bot đã được ghép nối với quản trị viên chưa
   */
  public isPaired(): boolean {
    return this.pairedChatId !== null;
  }

  /**
   * Ghép nối thủ công bằng mã OTP
   */
  public pairWithOtp(chatId: string, inputOtp: string): boolean {
    if (inputOtp.trim() === this.pairOtp) {
      this.pairedChatId = chatId;
      console.log(`✔ [TELEGRAM BOT] Ghép nối thành công với Chat ID: ${chatId}`);
      return true;
    }
    return false;
  }

  /**
   * Gửi thông điệp cảnh báo sự cố khẩn cấp tới quản trị viên
   */
  public async sendAlert(nodeName: string, severity: 'INFO' | 'WARNING' | 'CRITICAL', message: string): Promise<boolean> {
    if (!this.botToken || !this.pairedChatId) {
      return false;
    }

    const icons: Record<string, string> = {
      INFO: 'ℹ️',
      WARNING: '⚠️',
      CRITICAL: '🚨',
    };

    const text = `${icons[severity] || '🔔'} *[CẢNH BÁO HỆ THỐNG - ${severity}]*\n` +
                 `🖥️ *Máy chủ:* \`${nodeName}\`\n` +
                 `📝 *Nội dung:* ${message}\n` +
                 `⏱️ *Thời điểm:* \`${new Date().toISOString()}\``;

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.pairedChatId,
          text,
          parse_mode: 'Markdown',
        }),
      });

      return res.ok;
    } catch (err: any) {
      console.error('⚠️ [TELEGRAM WARNING] Gặp lỗi khi gửi thông báo tới Telegram:', err.message);
      return false;
    }
  }

  /**
   * Lắng nghe tin nhắn cập nhật từ Telegram để xử lý lệnh /pair <OTP>
   */
  private startPolling(): void {
    if (!this.botToken) return;

    this.pollInterval = setInterval(async () => {
      try {
        const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=2`;
        const res = await fetch(url);
        if (!res.ok) return;

        const data: any = await res.json();
        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            this.lastUpdateId = update.update_id;
            const msg = update.message;
            if (!msg || !msg.text) continue;

            const text: string = msg.text.trim();
            const chatId = String(msg.chat.id);

            if (text.startsWith('/pair')) {
              const parts = text.split(/\s+/);
              const providedOtp = parts[1] || '';

              if (this.pairWithOtp(chatId, providedOtp)) {
                await this.replyTelegram(chatId, `✔ Ghép nối thành công! Kênh này sẽ tiếp nhận cảnh báo On-Call của ZT-ServerOps.`);
              } else {
                await this.replyTelegram(chatId, `❌ Mã OTP không chính xác. Vui lòng kiểm tra lại trên màn hình console máy chủ.`);
              }
            } else if (text === '/status') {
              const statusMsg = this.pairedChatId === chatId
                ? '✔ Tài khoản của bạn ĐANG KẾT NỐI nhận cảnh báo hệ thống.'
                : '⚠️ Tài khoản của bạn CHƯA ĐƯỢC GHÉP NỐI. Sử dụng: /pair <MÃ_OTP>';
              await this.replyTelegram(chatId, statusMsg);
            }
          }
        }
      } catch {
        // Im lặng bỏ qua lỗi mạng định kỳ khi polling
      }
    }, 5000);
  }

  private async replyTelegram(chatId: string, text: string): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch {
      // Bỏ qua lỗi gửi phản hồi
    }
  }

  public stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}

export const telegramService = new TelegramService();
