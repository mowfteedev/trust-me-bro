import pg from 'pg';

/**
 * TÁC VỤ BẢO TRÌ ĐỊNH KỲ PHÂN VÙNG DỮ LIỆU (PARTITION RETENTION JANITOR)
 * Dự án: ZT-ServerOps
 *
 * PHÂN QUYỀN & NGUYÊN TẮC BẢO MẬT (LEAST PRIVILEGE - N03 REMEDIATION):
 * - Gateway Runtime (zt_app): Bị REVOKE quyền DROP TABLE / drop_old_metrics_partitions.
 * - Tác vụ này chạy độc lập dưới vai trò bảo trì chuyên trách (zt_maintenance)
 *   hoặc container lịch trình định kỳ (Cron / Maintenance Job).
 * - Kiểm tra tham số retention_days từ 7 đến 365 ngày trước khi thực thi.
 * - Thoát với exit code 1 khi gặp lỗi để kích hoạt cảnh báo Orchestrator / CI-CD.
 */

const { Pool } = pg;

async function runMaintenance() {
  const dbUrl =
    process.env.MAINTENANCE_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgres://zt_maintenance:SecureMaintenance2026!@postgres:5432/zt_serverops';

  const retentionDays = parseInt(process.env.RETENTION_DAYS || '7', 10);

  if (isNaN(retentionDays) || retentionDays < 7 || retentionDays > 365) {
    console.error(`❌ [MAINTENANCE ERROR] Tham số RETENTION_DAYS không hợp lệ: ${retentionDays} (bắt buộc từ 7 đến 365 ngày).`);
    process.exit(1);
  }

  console.log(`🧹 [MAINTENANCE] Bắt đầu tác vụ dọn dẹp phân vùng cũ (Retention: ${retentionDays} ngày)...`);
  console.log(`👤 Principal: zt_maintenance | Target DB: zt_serverops`);

  const pool = new Pool({
    connectionString: dbUrl,
    connectionTimeoutMillis: 5000,
  });

  try {
    const client = await pool.connect();
    try {
      const res = await client.query('SELECT drop_old_metrics_partitions($1);', [retentionDays]);
      const droppedPartitions = res.rows.map((r: any) => r.drop_old_metrics_partitions).filter(Boolean);

      console.log(`✅ [MAINTENANCE COMPLETE] Dọn dẹp thành công ${droppedPartitions.length} phân vùng cũ:`);
      if (droppedPartitions.length > 0) {
        droppedPartitions.forEach((p: string) => console.log(`   - Đã thu hồi: ${p}`));
      } else {
        console.log(`   - Không có phân vùng nào vượt quá ngưỡng ${retentionDays} ngày.`);
      }
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error(`❌ [MAINTENANCE FATAL] Lỗi khi thực thi dọn dẹp phân vùng:`, err.message);
    await pool.end();
    process.exit(1);
  }

  await pool.end();
  console.log(`🎉 [MAINTENANCE] Hoàn tất tác vụ bảo trì định kỳ.`);
}

runMaintenance();
