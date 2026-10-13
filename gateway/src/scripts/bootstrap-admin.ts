import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
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
 *
 * BẢO MẬT (P1 REMEDIATION):
 * 1. TUYỆT ĐỐI CẤM truyền mật khẩu qua CLI argv (--password) để chống rò rỉ qua /proc và `ps aux`.
 * 2. Tiếp nhận mật khẩu an toàn qua:
 *    - Biến môi trường: BOOTSTRAP_ADMIN_PASSWORD
 *    - Tệp tin bí mật: --password-file <đường_dẫn> hoặc BOOTSTRAP_ADMIN_PASSWORD_FILE
 * 3. Tuyệt đối KHÔNG in mật khẩu thô ra stdout/stderr. Nếu tự sinh ngẫu nhiên, mật khẩu
 *    được lưu an toàn vào tệp riêng biệt phân quyền chặt chẽ (chmod 600).
 */

async function bootstrapAdmin() {
  const args = process.argv.slice(2);
  let username = process.env.BOOTSTRAP_ADMIN_USER || 'admin';
  let password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
  let passwordFile = process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE || '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--username' && args[i + 1]) {
      username = args[i + 1];
      i++;
    } else if (args[i] === '--password-file' && args[i + 1]) {
      passwordFile = args[i + 1];
      i++;
    } else if (args[i] === '--password') {
      console.error('❌ [SECURITY VIOLATION] CẤM truyền mật khẩu trực tiếp qua đối số dòng lệnh CLI (--password).');
      console.error('👉 Vui lòng sử dụng cờ --password-file <đường_dẫn> hoặc biến môi trường BOOTSTRAP_ADMIN_PASSWORD.');
      process.exit(1);
    }
  }

  // Đọc mật khẩu từ tệp bảo mật nếu có
  if (!password && passwordFile) {
    if (!fs.existsSync(passwordFile)) {
      console.error(`❌ [ERROR] Không tìm thấy tệp mật khẩu: ${passwordFile}`);
      process.exit(1);
    }
    password = fs.readFileSync(passwordFile, 'utf-8').trim();
  }

  let generated = false;
  let secretSavePath = '';
  if (!password) {
    password = crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, 'x') + '!A1';
    generated = true;

    // Lưu mật khẩu tự sinh vào tệp phân quyền an toàn 0600
    const keysDir = path.resolve(process.cwd(), 'keys');
    if (!fs.existsSync(keysDir)) {
      fs.mkdirSync(keysDir, { mode: 0o700, recursive: true });
    }
    secretSavePath = path.join(keysDir, 'bootstrap_admin.secret');
    fs.writeFileSync(secretSavePath, password + '\n', { mode: 0o600 });
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
    console.log(`🔒 Mật khẩu tự sinh đã được lưu an toàn tại: ${secretSavePath} (phân quyền chmod 600)`);
    console.log(`⚠️ Tuyệt đối không để lộ tệp bí mật này và vui lòng đổi mật khẩu sau khi đăng nhập.`);
  } else {
    console.log(`🔒 Password: (Đã thiết lập thành công từ biến môi trường/tệp bí mật bảo vệ)`);
  }

  await closeDatabasePool();
}

bootstrapAdmin().catch(async (err) => {
  console.error('❌ [BOOTSTRAP ADMIN ERROR]:', err);
  await closeDatabasePool();
  process.exit(1);
});
