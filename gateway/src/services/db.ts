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
  connectionTimeoutMillis: 3000,
  // CHÚ THÍCH BẢO MẬT (FAIL-CLOSED TIMEOUT - B2/R03):
  // query_timeout ở cấp client Node.js đảm bảo ngắt ngay sau 3s kể cả khi DB server bị đóng băng/treo mạng
  query_timeout: 3000,
  statement_timeout: 5000,
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
 * Tự động đảm bảo dữ liệu định danh mẫu (chỉ phục vụ chạy Unit/Integration Test cô lập)
 * Triệt tiêu hoàn toàn CWE-798: Không tự động chèn mật khẩu mẫu trong môi trường Development/Production.
 */
export async function ensureSeedData(): Promise<void> {
  // CHÚ THÍCH BẢO MẬT (CWE-798 Prevention - R01):
  // Tuyệt đối không tự động nạp tài khoản mẫu với mật khẩu cứng ngoài môi trường Test có kiểm soát.
  if (config.NODE_ENV !== 'test' || process.env.ALLOW_DEFAULT_SEED !== 'true') {
    return;
  }

  try {
    // 1. Tạo tài khoản Quản trị viên (ADMIN) cho test
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

    // 2. Tạo tài khoản Giám sát viên (VIEWER) cho test
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

    console.log('✅ [DATABASE TEST SEED] Đã nạp tài khoản mẫu cho môi trường TEST.');
  } catch (err: any) {
    console.warn('⚠️ [DATABASE TEST SEED] Lỗi khi nạp dữ liệu test:', err.message);
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
