import pg from 'pg';
import { config } from '../config/env.js';

const { Pool } = pg;

/**
 * ==============================================================================
 * DỊCH VỤ QUẢN TRỊ KẾT NỐI CƠ SỞ DỮ LIỆU POSTGRESQL (db.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: database (chủ trì), backend, tech-lead
 * ==============================================================================
 *
 * LÝ DO PHI TRỰC GIÁC (RATIONALE):
 * Khởi tạo một đối tượng Pool duy nhất (Singleton Pattern) trong toàn bộ vòng đời của Gateway.
 * Đặt giới hạn trần (max connections) và thời gian ngắt kết nối nhàn rỗi (idleTimeoutMillis)
 * để triệt tiêu nguy cơ cạn kiệt tài nguyên CSDL (Connection Starvation) khi có bão tín hiệu beacon.
 */

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_MAX_CONNECTIONS,
  idleTimeoutMillis: config.DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: 5000,
  // CHÚ THÍCH CẤU HÌNH (SETUP HOOK):
  // Cài đặt statement_timeout ở cấp phiên để triệt tiêu các truy vấn treo nghẽn quá 10 giây
  statement_timeout: 10000,
});

pool.on('error', (err) => {
  console.error('❌ [DATABASE POOL ERROR] Sự cố kết nối nhàn rỗi không mong muốn:', err.message);
});

/**
 * Thực thi câu lệnh SQL với tham số chuẩn hóa (Prepared Statement an toàn chống SQLi)
 */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const res = await pool.query<T>(text, params);
  const duration = Date.now() - start;

  if (process.env.NODE_ENV === 'development' && duration > 50) {
    console.warn(`⚠️ [SLOW QUERY] Truy vấn mất ${duration}ms: ${text.substring(0, 80)}...`);
  }

  return res;
}

/**
 * Lấy một kết nối độc lập từ Pool để chạy Transaction ACID
 */
export async function getClient(): Promise<pg.PoolClient> {
  return await pool.connect();
}

/**
 * Kiểm tra tính khả dụng của Cơ sở dữ liệu (Readiness Check)
 */
export async function checkDatabaseHealth(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const res = await pool.query('SELECT 1 AS alive;');
    const latencyMs = Date.now() - start;
    const healthy = res.rows.length > 0 && res.rows[0].alive === 1;
    return { healthy, latencyMs };
  } catch (err: any) {
    return { healthy: false, latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * Tự động đảm bảo dữ liệu định danh mẫu (admin, viewer, node-worker-01) đã sẵn sàng
 * giúp hệ thống có thể đăng nhập ngay cả khi dùng volume cơ sở dữ liệu cũ
 */
export async function ensureSeedData(): Promise<void> {
  // CHÚ THÍCH BẢO MẬT (CWE-798 Prevention):
  // Cấm tuyệt đối việc tự động nạp tài khoản mẫu mật khẩu cố định trên môi trường Production
  if (config.NODE_ENV === 'production' && process.env.ALLOW_DEFAULT_SEED !== 'true') {
    console.log('🛡️ [SECURITY] Môi trường Production đã vô hiệu hóa nạp tài khoản mẫu mặc định.');
    return;
  }

  try {
    console.warn('⚠️ [SECURITY NOTICE] Đang kích hoạt dữ liệu mẫu môi trường Development/Lab (admin/viewer).');
    // 1. Tạo tài khoản Quản trị viên (ADMIN) mặc định nếu chưa có
    // Mật khẩu: SecureAdmin2026!
    await query(`
      INSERT INTO users (username, password_hash, role, is_active)
      VALUES (
        'admin',
        '7b8761930e6e9030a1678561f5a87cea:9e660af5f8655bc58af3b5b8cbfa5a4a933d63640cdf8413a2d79ba8566f535179a18ec548bf86064645f579b2ac0883dd119d9ef4cd40e27c24acf038829234',
        'ADMIN',
        TRUE
      )
      ON CONFLICT (username) DO NOTHING;
    `);

    // 2. Tạo tài khoản Giám sát viên (VIEWER) mặc định nếu chưa có
    // Mật khẩu: SecureViewer2026!
    await query(`
      INSERT INTO users (username, password_hash, role, is_active)
      VALUES (
        'viewer',
        '99b3aba269d84d5f21bf59f235b7bd03:3978dc1577b5881b395900fcbfd080bc2c4978883b60eac17b2934a3a3147a006f3187c7485b63d30c7092faddf7de157bfff7b4ca4a763debff1b7d7218ecfd',
        'VIEWER',
        TRUE
      )
      ON CONFLICT (username) DO NOTHING;
    `);

    // 3. Tạo máy chủ con mặc định (node-worker-01) nếu chưa có
    // Token pre-shared trong docker-compose: secret-token-worker-01
    await query(`
      INSERT INTO nodes (name, ip_address, node_type, token_hash, token_prefix, status)
      VALUES (
        'node-worker-01',
        '10.100.0.2',
        'DOCKER',
        '10a3ce77a769aabf8361db2ba4aab0af15bdb1352c84f66dea2280049de5cecc',
        'secret-t',
        'HEALTHY'
      )
      ON CONFLICT (name) DO NOTHING;
    `);

    console.log('✅ [DATABASE SEED] Dữ liệu mẫu ban đầu (admin, viewer, node-worker-01) đã sẵn sàng.');
  } catch (err: any) {
    console.warn('⚠️ [DATABASE SEED] Không thể tự động chèn dữ liệu mẫu (bảng chưa tạo hoặc lỗi khởi tạo):', err.message);
  }
}

/**
 * Đóng kết nối an toàn trong quy trình Graceful Shutdown
 */
export async function closeDatabasePool(): Promise<void> {
  console.log('🔌 [DATABASE POOL] Đang đóng toàn bộ kết nối PostgreSQL an toàn...');
  await pool.end();
  console.log('✔ [DATABASE POOL] Đã đóng Connection Pool thành công.');
}
