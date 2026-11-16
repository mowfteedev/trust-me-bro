import { config } from '../config/env.js';
import { generateNumericOtp } from '../utils/crypto.js';
import { query } from './db.js';
import { formatTelegramAlert, formatTelegramRecovery, formatTelegramTest } from './telegram-message.js';

/**
 * ==============================================================================
 * DỊCH VỤ CẢNH BÁO ON-CALL TELEGRAM BOT (telegram.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: backend (chủ trì), security
 * ==============================================================================
 *
 * LÝ DO PHI TRỰC GIÁC (RATIONALE):
 * BUG-005 Phòng ngừa: Tuyệt đối không tự động lấy chatId của tin nhắn đầu tiên trên internet.
 * Mã ghép nối chỉ đọc qua chức năng quản trị được bảo vệ; không ghi vào log thường.
 * Quản trị viên bắt buộc phải chat trực tiếp: /pair <MÃ_OTP> mới được kích hoạt quyền nhận cảnh báo.
 * Lưu trữ trạng thái ghép nối trong bảng system_settings để duy trì tính liên tục sau khi khởi động lại.
 */

export class TelegramService {
  private readonly mode = config.TELEGRAM_MODE;
  private stopped = false;
  private isPolling = false;
  private botToken: string;
  private pairOtp: string;
  private pairedChatId: string | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastUpdateId: number = 0;

  constructor() {
    this.botToken = config.TELEGRAM_BOT_TOKEN || '';
    // Sử dụng OTP từ biến môi trường (nếu không phải giá trị mẫu 889900) hoặc tự động sinh ngẫu nhiên lúc khởi động
    const configuredOtp = config.TELEGRAM_PAIR_OTP;
    this.pairOtp = (configuredOtp && configuredOtp !== '889900') ? configuredOtp : generateNumericOtp(6);

    if (this.mode === 'live' && this.botToken) {
      console.log('🤖 [TELEGRAM BOT] Đã kích hoạt dịch vụ thông báo On-Call.');
      console.log('[TELEGRAM] Ghép nối bằng mã trong cấu hình quản trị được bảo vệ.');

    } else {
      console.log(`[TELEGRAM] Chế độ ${this.mode}; dry-run chỉ ghi log giả lập, không gửi ra ngoài.`);
    }
  }

  /**
   * Khởi tạo và nạp chatId đã ghép nối từ bảng system_settings
   */
  public async init(): Promise<void> {
    if (this.mode !== 'live' || !this.botToken) return;
    try {
      const res = await query(
        "SELECT value FROM system_settings WHERE key = 'telegram_paired_chat_id' LIMIT 1;"
      );
      if (res.rows.length > 0 && res.rows[0].value) {
        this.pairedChatId = res.rows[0].value;
        console.log('[TELEGRAM BOT] Đã nạp kênh nhận cảnh báo.');
      }
    } catch (err: any) {
      console.warn('[TELEGRAM] Không thể nạp cấu hình kênh nhận cảnh báo.');
    }
    this.startPolling();
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
   * Ghép nối thủ công bằng mã OTP và lưu vào CSDL (Bắt buộc hoàn thành lưu trữ trước khi báo thành công - P1)
   */
  public async pairWithOtp(chatId: string, inputOtp: string): Promise<boolean> {
    if (this.mode !== 'live' || this.stopped) return false;
    // Khóa chống chiếm quyền (Anti-Hijack Guard): Không cho phép ghi đè khi đã ghép nối thành công
    if (this.pairedChatId !== null && this.pairedChatId !== chatId) {
      console.warn('[TELEGRAM SECURITY] Từ chối thay kênh nhận cảnh báo đã ghép.');
      return false;
    }

    if (inputOtp.trim() === this.pairOtp) {
      try {
        // Lưu vào CSDL với DB Atomic Compare-And-Set (Chống race condition giữa nhiều instances)
        const res = await query(
          `INSERT INTO system_settings (key, value, updated_at)
           VALUES ('telegram_paired_chat_id', $1, (now() AT TIME ZONE 'UTC'))
           ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
           WHERE system_settings.value = $1 OR system_settings.value IS NULL OR system_settings.value = '';`,
          [chatId]
        );

        if (res.rowCount === 0) {
          console.warn(`⚠️ [TELEGRAM DB] Từ chối ghép nối do CSDL đã được gán Chat ID khác bởi instance đồng thời.`);
          return false;
        }

        this.pairedChatId = chatId;
        console.log('[TELEGRAM BOT] Đã lưu ghép nối kênh nhận cảnh báo.');
        return true;
      } catch (err: any) {
        console.error('[TELEGRAM] Không thể lưu cấu hình ghép nối.');
        return false;
      }
    }
    return false;
  }

  /**
   * Gửi thông điệp cảnh báo sự cố khẩn cấp tới quản trị viên
   */
  public async sendAlert(nodeName: string, severity: 'INFO' | 'WARNING' | 'CRITICAL', message: string): Promise<boolean> {
    return this.deliver(nodeName, severity, formatTelegramAlert(nodeName, severity, message));
  }

  public async sendRecovery(nodeName: string, ipAddress: string, downtimeSeconds: number | null, recoveredAt: Date): Promise<boolean> {
    return this.deliver(nodeName, 'INFO', formatTelegramRecovery(nodeName, ipAddress, downtimeSeconds, recoveredAt));
  }

  /**
   * Gửi cảnh báo thử nghiệm tới kênh quản trị viên đã ghép nối
   */
  public async sendTestAlert(username: string, role: string): Promise<{ success: boolean; dryRun: boolean; reason?: string }> {
    if (this.stopped || this.mode === 'disabled') {
      return { success: false, dryRun: false, reason: 'Dịch vụ cảnh báo Telegram đang bị vô hiệu hóa trên hệ thống.' };
    }

    const text = formatTelegramTest(username, role);

    if (this.mode === 'dry-run') {
      console.log('[TELEGRAM TEST / DRY-RUN — GIẢ LẬP]', text);
      return {
        success: true,
        dryRun: true,
        reason: 'Hệ thống đang ở chế độ giả lập (dry-run). Cảnh báo thử nghiệm đã được mô phỏng thành công, chưa gửi ra ngoài Telegram.',
      };
    }

    if (!this.botToken || !this.pairedChatId) {
      console.warn('[TELEGRAM TEST] Chưa cấu hình botToken hoặc chưa ghép nối pairedChatId.');
      return {
        success: false,
        dryRun: false,
        reason: 'Kênh Telegram chưa được ghép nối với quản trị viên. Vui lòng gửi lệnh /pair <MÃ_OTP> tới bot trước khi gửi cảnh báo.',
      };
    }

    const delivered = await this.deliver('ZT-Gateway', 'INFO', text);
    if (delivered) {
      return { success: true, dryRun: false };
    }
    return {
      success: false,
      dryRun: false,
      reason: 'Không thể kết nối hoặc gửi tin nhắn tới máy chủ Telegram API sau 3 lần thử.',
    };
  }

  /** A single bounded transport attempt; persistent retry budget belongs to the DB queue. */
  public async deliverQueued(text: string): Promise<{
    status: 'SENT' | 'DRY_RUN' | 'DISABLED' | 'RETRY' | 'FAILED'; error?: string;
  }> {
    if (this.stopped) return { status: 'RETRY', error: 'GATEWAY_STOPPING' };
    if (this.mode === 'disabled') return { status: 'DISABLED' };
    if (this.mode === 'dry-run') return { status: 'DRY_RUN' };
    if (!this.botToken || !this.pairedChatId) return { status: 'RETRY', error: 'CHANNEL_NOT_READY' };
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.pairedChatId, text }),
        signal: AbortSignal.timeout(config.TELEGRAM_REQUEST_TIMEOUT_MS),
      });
      const data: any = await response.json();
      if (response.ok && data.ok === true) return { status: 'SENT' };
      const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
      return { status: permanent ? 'FAILED' : 'RETRY', error: `TELEGRAM_HTTP_${response.status}` };
    } catch {
      return { status: 'RETRY', error: 'TRANSPORT_ERROR' };
    }
  }

  private async deliver(nodeName: string, severity: 'INFO' | 'WARNING' | 'CRITICAL', text: string): Promise<boolean> {
    if (this.stopped || this.mode === 'disabled') return false;
    if (this.mode === 'dry-run') {
      console.log('[TELEGRAM DRY-RUN / GIẢ LẬP — KHÔNG GỬI]', text);
      return true;
    }
    if (!this.botToken || !this.pairedChatId) {
      console.warn('[TELEGRAM] Chưa có token/ghép nối; cảnh báo chỉ lưu DB.');
      return false;
    }

    // Three bounded attempts; caller runs this after DB commit without blocking ingestion.
    for (let attempt = 1; attempt <= 3 && !this.stopped; attempt++) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: this.pairedChatId, text }),
          signal: AbortSignal.timeout(config.TELEGRAM_REQUEST_TIMEOUT_MS),
        });
        const data: any = await res.json();
        if (res.ok && data.ok === true) {
          console.info('[TELEGRAM SENT]', JSON.stringify({
            node: nodeName, severity, message_id: data.result?.message_id ?? null,
          }));
          return true;
        }
        // Invalid configuration/recipient is permanent; retry only rate limits and server errors.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } catch {
        // Never log the request URL/error text, which can contain the bot token.
      }
      if (attempt < 3 && !this.stopped) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
    console.warn('[TELEGRAM] Gửi thất bại sau retry giới hạn; cảnh báo vẫn được lưu trong DB.');
    return false;
  }

  /**
   * Lắng nghe tin nhắn cập nhật từ Telegram để xử lý lệnh /pair <OTP>
   */
  private startPolling(): void {
    if (this.mode !== 'live' || !this.botToken || this.pollInterval || this.stopped) return;

    this.pollInterval = setInterval(async () => {
      if (this.isPolling || this.stopped) return;
      this.isPolling = true;
      try {
        const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=2`;
        const res = await fetch(url, { signal: AbortSignal.timeout(config.TELEGRAM_REQUEST_TIMEOUT_MS) });
        if (!res.ok) return;

        const data: any = await res.json();
        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            this.lastUpdateId = update.update_id;
            const msg = update.message;
            if (!msg || !msg.text) continue;

            const text: string = msg.text.trim();
            const chatId = String(msg.chat.id);

            if (/^\/pair(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text)) {
              const parts = text.split(/\s+/);
              const providedOtp = parts[1] || '';

              if (await this.pairWithOtp(chatId, providedOtp)) {
                await this.replyTelegram(chatId, `✔ Ghép nối thành công! Kênh này sẽ tiếp nhận cảnh báo On-Call của ZT-ServerOps.`);
              } else {
                await this.replyTelegram(chatId, `❌ Mã OTP không chính xác. Vui lòng lấy mã từ quản trị viên hệ thống.`);
              }
            } else if (/^\/status(?:@[A-Za-z0-9_]+)?$/.test(text)) {
              const statusMsg = this.pairedChatId === chatId
                ? '✔ Tài khoản của bạn ĐANG KẾT NỐI nhận cảnh báo hệ thống.'
                : '⚠️ Tài khoản của bạn CHƯA ĐƯỢC GHÉP NỐI. Sử dụng: /pair <MÃ_OTP>';
              await this.replyTelegram(chatId, statusMsg);
            }
          }
        }
      } catch {
        // Im lặng bỏ qua lỗi mạng định kỳ khi polling
      } finally {
        this.isPolling = false;
      }
    }, 5000);
  }

  private async replyTelegram(chatId: string, text: string): Promise<void> {
    if (this.mode !== 'live' || this.stopped) return;
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(config.TELEGRAM_REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Bỏ qua lỗi gửi phản hồi
    }
  }

  public stop(): void {
    this.stopped = true;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}

export const telegramService = new TelegramService();
