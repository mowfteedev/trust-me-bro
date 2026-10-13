import crypto from 'node:crypto';
import { query, closeDatabasePool } from '../services/db.js';
import { hashPassword } from '../utils/crypto.js';

/**
 * ==============================================================================
 * KỊCH BẢN KHỞI TẠO TÀI KHOẢN QUẢN TRỊ VIÊN BAN ĐẦU (bootstrap-admin.ts)
 * Dự án: ZT-ServerOps (B1 Remediation)
 * Phụ trách: security (chủ trì), backend
 * ==============================================================================
 *
 * Cho phép thiết lập tài khoản quản trị viên an toàn trong môi trường Production
 * mà không cần phụ thuộc vào thông tin xác thực mẫu (default seed credentials).
 */

async function bootstrapAdmin() {
  const args = process.argv.slice(2);
  let username = process.env.BOOTSTRAP_ADMIN_USER || 'admin';
  let password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--username' && args[i + 1]) {
      username = args[i + 1];
      i++;
    } else if (args[i] === '--password' && args[i + 1]) {
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
    console.log(`🔑 Password (tự sinh ngẫu nhiên): ${password}`);
    console.log(`⚠️ Vui lòng lưu trữ mật khẩu an toàn và thay đổi sau khi đăng nhập lần đầu!`);
  } else {
    console.log(`🔑 Password: (đã thiết lập theo yêu cầu)`);
  }

  await closeDatabasePool();
}

bootstrapAdmin().catch(async (err) => {
  console.error('❌ [BOOTSTRAP ADMIN ERROR]:', err);
  await closeDatabasePool();
  process.exit(1);
});
