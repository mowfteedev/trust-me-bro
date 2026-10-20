import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// Nạp các biến môi trường từ tệp .env ở thư mục gốc của dự án
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config(); // Nạp dự phòng tệp .env tại thư mục gateway/ nếu có

// Validate required settings before startup, including the JWT secret, rather than
// allowing the Gateway to run with an incomplete security configuration.
const envSchema = z.object({
  // Cấu hình mạng dịch vụ Fastify
  GATEWAY_PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  GATEWAY_HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Only the known Caddy socket may supply forwarded client addresses.
  // Omit for direct access; arbitrary peers on VPN/transport remain untrusted.
  TRUSTED_PROXY_IP: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().ip().optional(),
  ),

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

  // Kết nối cơ sở dữ liệu PostgreSQL (vai trò ít quyền zt_app)
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
  SWEEPER_INTERVAL_MS: z.coerce.number().int().min(1000).max(10000).default(5000),
  NODE_STALE_THRESHOLD_SECONDS: z.coerce.number().int().min(3).default(15),
  NODE_OFFLINE_THRESHOLD_SECONDS: z.coerce.number().int().min(15).max(45).default(30),
  CPU_ALERT_THRESHOLD_PERCENT: z.coerce.number().min(1).max(100).default(85),
  CPU_RECOVERY_THRESHOLD_PERCENT: z.coerce.number().positive().max(100).default(75),

  // Dịch vụ thông báo khẩn cấp On-Call qua Telegram (OTP sinh động, không dùng mặc định cố định)
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_PAIR_OTP: z.string().min(6).optional(),
  TELEGRAM_MODE: z.enum(['disabled', 'dry-run', 'live']).default('dry-run'),
  TELEGRAM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(10000).default(5000),

  // Mạng ngầm WireGuard
  WG_GATEWAY_IP: z.string().ip({ version: 'v4' }).default('10.100.0.1'),
  WG_LISTEN_PORT: z.coerce.number().int().min(1).max(65535).default(51820),
}).refine((env) => env.NODE_STALE_THRESHOLD_SECONDS < env.NODE_OFFLINE_THRESHOLD_SECONDS, {
  message: 'NODE_STALE_THRESHOLD_SECONDS phải nhỏ hơn ngưỡng OFFLINE',
  path: ['NODE_STALE_THRESHOLD_SECONDS'],
}).refine((env) => env.NODE_OFFLINE_THRESHOLD_SECONDS + env.SWEEPER_INTERVAL_MS / 1000 <= 45, {
  message: 'Ngưỡng OFFLINE cộng chu kỳ quét phải <= 45 giây theo phiếu giao',
  path: ['NODE_OFFLINE_THRESHOLD_SECONDS'],
}).refine((env) => env.CPU_RECOVERY_THRESHOLD_PERCENT < env.CPU_ALERT_THRESHOLD_PERCENT, {
  message: 'CPU_RECOVERY_THRESHOLD_PERCENT phải nhỏ hơn ngưỡng cảnh báo CPU',
  path: ['CPU_RECOVERY_THRESHOLD_PERCENT'],
});

const parseResult = envSchema.safeParse(process.env);

if (!parseResult.success) {
  console.error('❌ [CONFIG ERROR] Sai lệch cấu hình biến môi trường:');
  console.error(JSON.stringify(parseResult.error.format(), null, 2));
  process.exit(1);
}

export const config = parseResult.data;
export type Config = z.infer<typeof envSchema>;
