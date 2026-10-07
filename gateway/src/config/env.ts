import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// Nạp các biến môi trường từ tệp .env ở thư mục gốc của dự án
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config(); // Nạp dự phòng tệp .env tại thư mục gateway/ nếu có

/**
 * LÝ DO PHI TRỰC GIÁC (RATIONALE):
 * Không sử dụng trực tiếp process.env trong toàn bộ dự án. Mọi biến cấu hình bắt buộc phải đi qua
 * bộ lọc Zod Schema ngay lúc khởi động. Nếu thiếu bất kỳ biến trọng yếu nào (hoặc JWT_SECRET quá ngắn),
 * tiến trình sẽ dừng ngay lập tức (Fail-Fast), ngăn chặn việc hệ thống chạy ở trạng thái bảo mật yếu.
 */
const envSchema = z.object({
  // Cấu hình mạng dịch vụ Fastify
  GATEWAY_PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  GATEWAY_HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Ràng buộc bảo mật danh tính (HMAC-SHA256)
  // CHÚ THÍCH BẢO MẬT: Độ dài tối thiểu 32 ký tự để triệt tiêu nguy cơ brute-force chữ ký JWT
  JWT_SECRET: z.string().min(32, {
    message: 'LỖI BẢO MẬT: JWT_SECRET bắt buộc phải có độ dài tối thiểu 32 ký tự!',
  }).refine((val) => {
    if (process.env.NODE_ENV === 'production' && val.includes('ThayDoi')) {
      return false;
    }
    return true;
  }, {
    message: 'LỖI BẢO MẬT: Không được sử dụng JWT_SECRET mẫu trên môi trường Production!',
  }),
  JWT_EXPIRES_IN: z.string().default('1d'),

  // Kết nối cơ sở dữ liệu PostgreSQL
  DATABASE_URL: z.string().url({
    message: 'LỖI CẤU HÌNH: DATABASE_URL không đúng định dạng connection string!',
  }),
  DB_MAX_CONNECTIONS: z.coerce.number().int().min(5).max(100).default(20),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),

  // Cấu hình dịch vụ Web SSH Bastion
  BASTION_SSH_KEY_PATH: z.string().default('./keys/bastion_id_ed25519'),
  BASTION_DEFAULT_USER: z.string().default('root'),
  BASTION_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),

  // Cấu hình dịch vụ giám sát trạng thái Liveness
  SWEEPER_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  NODE_OFFLINE_THRESHOLD_SECONDS: z.coerce.number().int().min(10).default(30),

  // Dịch vụ thông báo khẩn cấp On-Call qua Telegram (OTP sinh động, không dùng mặc định cố định)
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_PAIR_OTP: z.string().min(6).optional(),

  // Mạng ngầm WireGuard
  WG_GATEWAY_IP: z.string().ip({ version: 'v4' }).default('10.100.0.1'),
  WG_LISTEN_PORT: z.coerce.number().int().min(1).max(65535).default(51820),
});

const parseResult = envSchema.safeParse(process.env);

if (!parseResult.success) {
  console.error('❌ [CONFIG ERROR] Sai lệch cấu hình biến môi trường:');
  console.error(JSON.stringify(parseResult.error.format(), null, 2));
  process.exit(1);
}

/**
 * CHỈ DẪN THIẾT LẬP (SETUP HOOK):
 * Đối tượng config đã được ép kiểu tĩnh an toàn (Type-safe).
 * Sử dụng import { config } from '@/config/env' trong toàn bộ mã nguồn của Gateway.
 */
export const config = parseResult.data;
export type Config = z.infer<typeof envSchema>;
