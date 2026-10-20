#!/usr/bin/env bash
# ==============================================================================
# TẬP HỢP KIỂM THỬ TOÀN DIỆN ROUND 4 (EVIDENCE GENERATION SUITE)
# Dự án: ZT-ServerOps
# Phụ trách: tester (chủ trì), security, database, backend
# Tham chiếu: Toàn bộ phát hiện R3-01 đến R3-06 từ REVIEW_round3_bf12171.md
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PROJECT_ROOT}"

OUTPUT_DIR="/tmp/evidence_v4"
mkdir -p "${OUTPUT_DIR}"

echo "=============================================================================="
echo "🚀 [ROUND 4 TEST SUITE] Bắt đầu chạy toàn bộ các bài kiểm thử thực chiến..."
echo "🕒 Thời gian: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
echo "=============================================================================="

# 1. R3-03: Drain loop rearm, backpressure & slow peer timeout
echo -e "\n---> [1/6] Chạy Test R3-03 (Drain Loop & Backpressure)..."
docker exec -i zt_gateway node - < tests/test_r08_drain_loop_and_backpressure.cjs | tee "${OUTPUT_DIR}/r08_drain_loop.log"

# 2. R3-05: Telemetry Ingest Exact Hash (Loại bỏ prefix fallback)
echo -e "\n---> [2/6] Chạy Test R3-05 (Telemetry Ingest Exact Hash)..."
python3 tests/legacy/test_round4_ingest_and_auth.py | tee "${OUTPUT_DIR}/r05_telemetry_ingest.log"

# 3. R3-04: Audit Lifecycle, Shared Lease Fencing & Idempotency
echo -e "\n---> [3/6] Chạy Test R3-04 (Audit Lifecycle & Lease Reconciliation)..."
python3 tests/legacy/test_round4_audit_lease_reconciliation.py | tee "${OUTPUT_DIR}/r04_audit_lease_reconcile.log"

# 4. R3-06: SLA Benchmark 50 phiên lệch phase (Monotonic Clock)
echo -e "\n---> [4/6] Chạy Test R3-06 (SLA Watchdog 50 Phiên Phân Bố Phase)..."
docker exec -i zt_gateway node - < tests/test_r10_bastion_real_sla_benchmark.cjs | tee "${OUTPUT_DIR}/r06_sla_benchmark.log"

# 5. R3-01 & R3-05: Database Privileges, Partition Hardening & Maintenance
echo -e "\n---> [5/6] Chạy Test R3-01 & R3-05 (DB Privileges & Partition Retention)..."
bash tests/test_r02_db_privileges_and_n03.sh | tee "${OUTPUT_DIR}/r02_db_privileges.log"
bash tests/test_r05_maintenance_partition_retention.sh | tee "${OUTPUT_DIR}/r05_maintenance_retention.log"

# 6. P1: Bootstrap Admin Secret Chmod 600 & API Endpoints
echo -e "\n---> [6/6] Chạy Test P1 (Bootstrap Admin CLI Security & API Endpoints)..."
python3 tests/legacy/test_round3_api_and_admin.py | tee "${OUTPUT_DIR}/p1_admin_security.log"

echo -e "\n=============================================================================="
echo "🎉 [ROUND 4 COMPLETE] Toàn bộ 6 bài kiểm thử đã hoàn thành thành công 100%!"
echo "📁 Toàn bộ nhật ký kiểm thử thực tế được lưu tại: ${OUTPUT_DIR}/"
echo "=============================================================================="
