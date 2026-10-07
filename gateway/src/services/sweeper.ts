import { query } from './db.js';
import { config } from '../config/env.js';
import { telegramService } from './telegram.js';

/**
 * ==============================================================================
 * DỊCH VỤ QUÉT DỌN PHÂN VÙNG & GIÁM SÁT LIVENESS (sweeper.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: backend (chủ trì), devops, security
 * ==============================================================================
 *
 * LÝ DO PHI TRỰC GIÁC (RATIONALE):
 * 1. Proactive Partition Creation: Nếu không chủ động tạo bảng partition cho ngày mai,
 *    dữ liệu của thời điểm chuyển giao ngày sẽ rơi vào bảng mặc định (metrics_history_default).
 *    Một khi default partition đã có dữ liệu ngày X, PostgreSQL sẽ cấm lệnh CREATE TABLE ... PARTITION OF
 *    cho ngày X sau này, gây sập luồng ingestion!
 * 2. Triệt tiêu Dead Tuples (BUG-003): Thay vì chạy DELETE hàng phút, Sweeper định kỳ gọi
 *    hàm drop_old_metrics_partitions(7) để DROP toàn bộ bảng partition hết hạn dưới 5ms.
 * 3. Phát hiện sự cố máy con: Nếu node không gửi tín hiệu quá 30 giây, chuyển trạng thái sang
 *    OFFLINE và kích hoạt cảnh báo On-Call tức thì qua Bot Telegram.
 */

let sweeperTimer: NodeJS.Timeout | null = null;
let isSweeping = false;

/**
 * Thực thi một chu kỳ quét dọn và kiểm tra trạng thái máy chủ
 */
export async function runSweeperCycle(): Promise<{
  proactivePartitionCreated: boolean;
  droppedPartitions: string[];
  offlineNodesDetected: string[];
}> {
  if (isSweeping) {
    return { proactivePartitionCreated: false, droppedPartitions: [], offlineNodesDetected: [] };
  }

  isSweeping = true;
  let proactivePartitionCreated = false;
  let droppedPartitions: string[] = [];
  const offlineNodesDetected: string[] = [];

  try {
    // 1. Chủ động tạo phân vùng đón đầu cho ngày mai (và hôm nay nếu chưa có)
    try {
      await query(`SELECT create_daily_metrics_partition((now() AT TIME ZONE 'UTC')::date);`);
      await query(`SELECT create_daily_metrics_partition(((now() AT TIME ZONE 'UTC')::date + 1));`);
      proactivePartitionCreated = true;
    } catch (partErr: any) {
      console.warn('⚠️ [SWEEPER] Không thể tạo trước phân vùng ngày mới:', partErr.message);
    }

    // 2. Thu hồi các phân vùng cũ quá 7 ngày bằng DROP TABLE giải phóng đĩa cứng tức thì
    try {
      const dropRes = await query(`SELECT drop_old_metrics_partitions(7);`);
      if (dropRes.rows.length > 0) {
        droppedPartitions = dropRes.rows.map((r: any) => r.drop_old_metrics_partitions);
      }
    } catch (dropErr: any) {
      console.warn('⚠️ [SWEEPER] Không thể dọn dẹp phân vùng cũ:', dropErr.message);
    }

    // 3. Quét phát hiện các Endpoint Hosts bị mất kết nối (Liveness Check)
    const thresholdSec = config.NODE_OFFLINE_THRESHOLD_SECONDS;
    const offlineNodesRes = await query(
      `SELECT id, name, ip_address, last_seen
       FROM nodes
       WHERE (last_seen IS NULL OR last_seen < (now() AT TIME ZONE 'UTC') - make_interval(secs => $1))
         AND status != 'OFFLINE';`,
      [thresholdSec]
    );

    for (const node of offlineNodesRes.rows) {
      offlineNodesDetected.push(node.name);

      // Cập nhật trạng thái Node thành OFFLINE
      await query(
        `UPDATE nodes
         SET status = 'OFFLINE', updated_at = (now() AT TIME ZONE 'UTC')
         WHERE id = $1;`,
        [node.id]
      );

      // Ghi nhận sự cố vào bảng alerts
      const alertMsg = `Máy chủ con ${node.name} (${node.ip_address}) không phản hồi quá ${thresholdSec}s. Chuyển trạng thái sang OFFLINE!`;
      await query(
        `INSERT INTO alerts (node_id, severity, message, triggered_at)
         VALUES ($1, 'CRITICAL', $2, (now() AT TIME ZONE 'UTC'));`,
        [node.id, alertMsg]
      ).catch(() => {});

      // Ghi log kiểm toán bất biến
      await query(
        `INSERT INTO audit_logs (action, target, details)
         VALUES ('NODE_OFFLINE', $1, $2);`,
        [node.name, JSON.stringify({ ip: node.ip_address, last_seen: node.last_seen })]
      ).catch(() => {});

      // Bắn cảnh báo khẩn cấp On-Call qua Telegram Bot
      await telegramService.sendAlert(node.name, 'CRITICAL', alertMsg);
      console.warn(`🚨 [LIVENESS ALERT] Đã chuyển máy chủ ${node.name} sang trạng thái OFFLINE.`);
    }
  } catch (err: any) {
    console.error('❌ [SWEEPER ERROR] Sự cố trong vòng lặp Sweeper:', err.message);
  } finally {
    isSweeping = false;
  }

  return { proactivePartitionCreated, droppedPartitions, offlineNodesDetected };
}

/**
 * Khởi động vòng lặp kiểm tra định kỳ của Sweeper
 */
export function startSweeper(): void {
  if (sweeperTimer) return;

  const intervalMs = config.SWEEPER_INTERVAL_MS;
  console.log(`🧹 [SWEEPER] Khởi động dịch vụ quét dọn chu kỳ ${intervalMs}ms...`);

  // Chạy ngay một chu kỳ đầu tiên lúc khởi động
  runSweeperCycle().catch(() => {});

  // Thiết lập hẹn giờ lặp lại định kỳ
  sweeperTimer = setInterval(() => {
    runSweeperCycle().catch(() => {});
  }, intervalMs);
}

/**
 * Dừng dịch vụ Sweeper phục vụ Graceful Shutdown
 */
export function stopSweeper(): void {
  if (sweeperTimer) {
    clearInterval(sweeperTimer);
    sweeperTimer = null;
    console.log('✔ [SWEEPER] Đã dừng dịch vụ Sweeper.');
  }
}
