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
 * Đóng kết nối an toàn trong quy trình Graceful Shutdown
 */
export async function closeDatabasePool(): Promise<void> {
  console.log('🔌 [DATABASE POOL] Đang đóng toàn bộ kết nối PostgreSQL an toàn...');
  await pool.end();
  console.log('✔ [DATABASE POOL] Đã đóng Connection Pool thành công.');
}
