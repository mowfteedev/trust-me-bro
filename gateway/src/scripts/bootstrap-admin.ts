import fs from 'node:fs';
import crypto from 'node:crypto';
import { query, closeDatabasePool } from '../services/db.js';
import { hashPassword } from '../utils/crypto.js';

/**
 * ==============================================================================
 * KỊCH BẢN KHỞI TẠO TÀI KHOẢN QUẢN TRỊ VIÊN BAN ĐẦU (bootstrap-admin.ts)
 * Dự án: ZT-ServerOps (B1 Remediation & P1 Hardening)
 * Phụ trách: security (chủ trì), backend
 * ==============================================================================
 *
 * Cho phép thiết lập tài khoản quản trị viên an toàn trong môi trường Production
 * mà không cần phụ thuộc vào thông tin xác thực mẫu (default seed credentials).
 * Bảo mật: Ưu tiên nhận mật khẩu qua biến môi trường hoặc tệp tin an toàn (chmod 600)
 * để tránh lộ mật khẩu trong danh sách tiến trình của hệ điều hành (`ps aux`).
 */

async function bootstrapAdmin() {
  const args = process.argv.slice(2);
  let username = process.env.BOOTSTRAP_ADMIN_USER || 'admin';
  let password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';

  // Đọc mật khẩu từ file bảo mật nếu được cấu hình
  if (!password && process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE && fs.existsSync(process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE)) {
    password = fs.readFileSync(process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE, 'utf-8').trim();
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--username' && args[i + 1]) {
      username = args[i + 1];
      i++;
    } else if (args[i] === '--password' && args[i + 1]) {
      console.warn('⚠️ [SECURITY WARNING] Truyền mật khẩu qua cờ dòng lệnh CLI có thể bị ghi vết trong danh sách tiến trình hệ thống (ps aux). Khuyến nghị dùng BOOTSTRAP_ADMIN_PASSWORD.');
      password = args[i + 1];
      i++;
    }
  }

  let generated = false;
  if (!password) {
    password = crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, 'x') + '!A1';
    generated = true;
  }

  const pwdHash = hashPassword(password);

  console.log(`🚀 [BOOTSTRAP ADMIN] Đang khởi tạo/cập nhật tài khoản quản trị: ${username}`);

  await query(
    `INSERT INTO users (username, password_hash, role, is_active, session_version)
     VALUES ($1, $2, 'ADMIN', TRUE, 1)
     ON CONFLICT (username) DO UPDATE
     SET password_hash = EXCLUDED.password_hash,
         role = 'ADMIN',
         is_active = TRUE,
         session_version = users.session_version + 1,
         updated_at = (now() AT TIME ZONE 'UTC');`,
    [username, pwdHash]
  );

  console.log(`✅ [BOOTSTRAP ADMIN] Khởi tạo tài khoản quản trị viên thành công!`);
  console.log(`👤 Username: ${username}`);
  if (generated) {
    console.log(`🔑 Generated Password: \x1b[32m${password}\x1b[0m`);
    console.log(`⚠️ Vui lòng lưu trữ mật khẩu an toàn và thay đổi ngay sau khi đăng nhập lần đầu!`);
  } else {
    console.log(`🔑 Password: (đã thiết lập thành công từ biến môi trường/nguồn an toàn)`);
  }

  await closeDatabasePool();
}

bootstrapAdmin().catch(async (err) => {
  console.error('❌ [BOOTSTRAP ADMIN ERROR]:', err);
  await closeDatabasePool();
  process.exit(1);
});
