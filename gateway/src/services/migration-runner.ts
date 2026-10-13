import fs from 'fs';
import path from 'path';
import { pool } from './db.js';

/**
 * ==============================================================================
 * DỊCH VỤ TỰ ĐỘNG CHẠY MIGRATION VỚI KHÓA ĐỒNG BỘ ADVISORY LOCK (migration-runner.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: database (chủ trì), devops, backend
 * ==============================================================================
 */

const LOCK_ID = 84729103;

export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    // 1. Giữ khóa độc quyền toàn cục chống Race Condition khi nhiều Gateway khởi động cùng lúc
    await client.query('SELECT pg_advisory_lock($1);', [LOCK_ID]);

    // 2. Tạo bảng theo dõi các bản migration đã áp dụng
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 3. Xác định thư mục migrations
    const possibleDirs = [
      path.resolve(process.cwd(), 'migrations'),
      path.resolve(process.cwd(), '../gateway/migrations'),
      path.resolve(process.cwd(), 'dist/migrations'),
    ];

    let migrationsDir = possibleDirs.find(d => fs.existsSync(d));
    if (!migrationsDir) {
      console.warn('⚠️ [MIGRATION RUNNER] Không tìm thấy thư mục migrations. Bỏ qua chạy migration tự động.');
      return;
    }

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    // 4. Lấy danh sách migration đã chạy
    const appliedRes = await client.query('SELECT name FROM schema_migrations;');
    const appliedSet = new Set(appliedRes.rows.map(r => r.name));

    // 5. Áp dụng từng migration mới trong Transaction
    for (const file of files) {
      if (appliedSet.has(file)) {
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      console.log(`⏳ [MIGRATION RUNNER] Đang áp dụng migration: ${file}...`);
      await client.query('BEGIN;');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1);', [file]);
        await client.query('COMMIT;');
        console.log(`✅ [MIGRATION RUNNER] Đã áp dụng thành công: ${file}`);
      } catch (migErr: any) {
        await client.query('ROLLBACK;');
        console.error(`❌ [MIGRATION RUNNER ERROR] Lỗi khi chạy ${file}:`, migErr.message);
        throw migErr;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1);', [LOCK_ID]);
    } catch {}
    client.release();
  }
}
