import { runMigrations } from '../services/migration-runner.js';

/**
 * ==============================================================================
 * TIẾN TRÌNH THỰC THI SCHEMA MIGRATIONS ĐỘC LẬP (run-migrations.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: database (chủ trì), devops, security
 * ==============================================================================
 *
 * LÝ DO PHI TRỰC GIÁC (RATIONALE - N01 & N02 REMEDIATION):
 * Tách biệt hoàn toàn tiến trình Migration khỏi Control Plane Gateway:
 * 1. Chạy trong container độc lập zt_migrator trước khi Gateway khởi động.
 * 2. Tiến trình này là nơi DUY NHẤT giữ thông tin xác thực quản trị viên CSDL (zt_admin).
 * 3. Sau khi hoàn thành, tiến trình thoát (exit 0) và giải phóng toàn bộ tài nguyên.
 */

runMigrations()
  .then(() => {
    console.log('✅ [MIGRATION COMPLETE] Toàn bộ bản migration CSDL đã được áp dụng thành công.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ [MIGRATION FAILED] Quá trình migration thất bại nghiêm trọng:', err);
    process.exit(1);
  });
