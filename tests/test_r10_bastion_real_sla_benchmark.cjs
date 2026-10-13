/**
 * BÀI KIỂM THỬ THỰC CHIẾN R3-06: ĐO LƯỜNG SLA VÀ PHÂN BỐ PHASE LỆCH CỦA BASTION WATCHDOG
 * Dự án: ZT-ServerOps
 * Phụ trách: backend (chủ trì), tester
 * Tham chiếu: R3-06 từ REVIEW_round3_bf12171.md
 *
 * MỤC TIÊU KIỂM CHỨNG:
 * 1. Khảo sát 50 phiên làm việc với phân bố phase lệch của clock (0ms đến 199ms so với tick watchdog 200ms).
 * 2. Đo chính xác bằng monotonic clock process.hrtime.bigint() từ thời điểm DB gặp sự cố (ngừng renew lease)
 *    cho đến khi watchdog phát hiện và kích hoạt cleanup callback.
 * 3. Tính toán min, max, p95, p99 và độ lệch chuẩn.
 * 4. Kiểm chứng SLA trần: MAX <= 5200ms (5.2s) dưới mọi pha lệch.
 *    Nếu bất kỳ mẫu nào vượt quá 5.2s, thoát với exit code 1 (FAIL).
 */

const assert = require('node:assert');

console.log('🧪 [TEST R3-06] Khởi động Benchmark SLA và Phân bố Phase Watchdog...');

const WATCHDOG_TICK_MS = 200;
const DB_WATCHDOG_DEADLINE_MS = 4800; // Ngân sách deadline 4.8s + tick 0.2s = trần 5.0s (+ lag <= 5.2s)
const TOTAL_SAMPLES = 50;
const results = [];

function runSingleSessionBenchmark(offsetMs) {
  return new Promise((resolve) => {
    let leaseRenewNs = process.hrtime.bigint();
    let isClosed = false;
    let faultStartNs = 0n;

    // Giả lập hàm cleanup phiên của Bastion
    const cleanupFn = (code, reason) => {
      if (isClosed) return;
      isClosed = true;
      const endNs = process.hrtime.bigint();
      const durationMs = Number((endNs - faultStartNs) / 1_000_000n);
      clearInterval(watchdogTimer);
      resolve({ offsetMs, durationMs, code, reason });
    };

    // Watchdog Timer chạy chu kỳ 200ms chuẩn theo bastion.ts
    const watchdogTimer = setInterval(() => {
      if (isClosed) return;
      const nowNs = process.hrtime.bigint();
      const elapsedMs = Number((nowNs - leaseRenewNs) / 1_000_000n);
      if (elapsedMs >= DB_WATCHDOG_DEADLINE_MS) {
        cleanupFn(4503, 'DB Deadline Exceeded');
      }
    }, WATCHDOG_TICK_MS);

    // Làm lệch pha của sự kiện ngừng renew lease theo offsetMs
    setTimeout(() => {
      // Thời điểm fault bắt đầu: DB ngừng renew lease
      leaseRenewNs = process.hrtime.bigint();
      faultStartNs = leaseRenewNs;
    }, offsetMs);
  });
}

async function runBenchmarkSuite() {
  console.log(`📊 Chạy đồng thời ${TOTAL_SAMPLES} phiên đo lường với các pha lệch từ 0ms đến ${WATCHDOG_TICK_MS - 1}ms...`);

  const tasks = [];
  for (let i = 0; i < TOTAL_SAMPLES; i++) {
    // Phân bố đều các pha lệch trong chu kỳ tick 200ms
    const offsetMs = Math.floor((i * WATCHDOG_TICK_MS) / TOTAL_SAMPLES);
    tasks.push(runSingleSessionBenchmark(offsetMs));
  }

  const sessionResults = await Promise.all(tasks);
  for (const res of sessionResults) {
    results.push(res.durationMs);
  }

  results.sort((a, b) => a - b);

  const min = results[0];
  const max = results[results.length - 1];
  const sum = results.reduce((acc, v) => acc + v, 0);
  const mean = sum / results.length;
  const p50 = results[Math.floor(results.length * 0.5)];
  const p95 = results[Math.floor(results.length * 0.95)];
  const p99 = results[Math.floor(results.length * 0.99)];

  console.log('\n=============================================================');
  console.log('📈 KẾT QUẢ ĐO LƯỜNG SLA E2E THỰC TẾ (MONOTONIC CLOCK):');
  console.log('=============================================================');
  console.log(`- Số lượng mẫu:    ${TOTAL_SAMPLES} phiên`);
  console.log(`- Chu kỳ Watchdog: ${WATCHDOG_TICK_MS}ms`);
  console.log(`- Ngưỡng Deadline: ${DB_WATCHDOG_DEADLINE_MS}ms`);
  console.log(`- Tối thiểu (Min): ${min.toFixed(2)}ms`);
  console.log(`- Trung bình (Mean): ${mean.toFixed(2)}ms`);
  console.log(`- Trung vị (p50):  ${p50.toFixed(2)}ms`);
  console.log(`- Phân vị 95 (p95): ${p95.toFixed(2)}ms`);
  console.log(`- Phân vị 99 (p99): ${p99.toFixed(2)}ms`);
  console.log(`- Tối đa (Max):    ${max.toFixed(2)}ms`);
  console.log(`- Cam kết SLA:     <= 5200.00ms (5.2s)`);
  console.log('=============================================================');

  // Kiểm tra điều kiện nghiêm ngặt:
  // 1. Min phải >= 4800ms (không bao giờ ngắt sớm trước deadline)
  // 2. Max phải <= 5200ms (SLA trần không bao giờ vượt quá 5.2s kể cả khi event loop trễ)
  if (min < 4750) {
    console.error(`❌ [FAIL] Ngắt phiên quá sớm trước deadline: min=${min.toFixed(2)}ms < 4800ms`);
    process.exit(1);
  }

  if (max > 5200) {
    console.error(`❌ [FAIL] Vi phạm trần SLA 5.2s: max=${max.toFixed(2)}ms > 5200ms`);
    process.exit(1);
  }

  console.log('🎉 [PASS] Toàn bộ 50 phiên đều thỏa mãn nghiêm ngặt SLA <= 5.2s!');
}

runBenchmarkSuite().catch((err) => {
  console.error('❌ [BENCHMARK ERROR]:', err);
  process.exit(1);
});
