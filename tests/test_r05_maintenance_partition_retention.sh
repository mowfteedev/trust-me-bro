#!/bin/bash
set -euo pipefail

# ==============================================================================
# BÀI TEST KIỂM CHỨNG TÁC VỤ BẢO TRÌ VÀ PHÂN QUYỀN PARTITION RETENTION (N03 & MAINTENANCE)
# ==============================================================================

echo "======================================================================"
echo "🧪 [TEST MAINTENANCE] Kiểm thử tác vụ dọn dẹp phân vùng định kỳ"
echo "======================================================================"

# 1. Đảm bảo vai trò zt_maintenance tồn tại và có quyền phù hợp
docker exec zt_postgres psql -U zt_admin -d zt_serverops -v ON_ERROR_STOP=1 -c "
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'zt_maintenance') THEN
    CREATE ROLE zt_maintenance WITH LOGIN PASSWORD 'SecureMaintenance2026!';
  END IF;
END
\$\$;
GRANT CONNECT ON DATABASE zt_serverops TO zt_maintenance;
GRANT USAGE ON SCHEMA public TO zt_maintenance;
GRANT EXECUTE ON FUNCTION public.drop_old_metrics_partitions(integer) TO zt_maintenance;
"

# 2. Tạo một phân vùng cũ (15 ngày trước) và một phân vùng mới (hôm nay)
OLD_DATE=$(date -u -d "15 days ago" +%Y_%m_%d)
OLD_PART_NAME="metrics_history_y${OLD_DATE}"
TODAY_DATE=$(date -u +%Y_%m_%d)
TODAY_PART_NAME="metrics_history_y${TODAY_DATE}"

echo "1. Chuẩn bị phân vùng test: Cũ ($OLD_PART_NAME) và Hôm nay ($TODAY_PART_NAME)..."
docker exec zt_postgres psql -U zt_admin -d zt_serverops -v ON_ERROR_STOP=1 -c "
CREATE TABLE IF NOT EXISTS public.${OLD_PART_NAME} PARTITION OF metrics_history
    FOR VALUES FROM ('$(date -u -d "15 days ago" +%Y-%m-%d)') TO ('$(date -u -d "14 days ago" +%Y-%m-%d)');

CREATE TABLE IF NOT EXISTS public.${TODAY_PART_NAME} PARTITION OF metrics_history
    FOR VALUES FROM ('$(date -u +%Y-%m-%d)') TO ('$(date -u -d "tomorrow" +%Y-%m-%d)');
"

echo "✔ Đã tạo thành công 2 phân vùng kiểm thử."

# 3. Chứng minh vai trò zt_app (Gateway Runtime) KHÔNG THỂ gọi drop partition (Least Privilege)
echo "2. Kiểm tra vai trò zt_app bị từ chối quyền gọi drop_old_metrics_partitions..."
set +e
docker exec zt_postgres psql -U zt_app -d zt_serverops -c "SELECT drop_old_metrics_partitions(7);" >/dev/null 2>&1
APP_CALL_EXIT=$?
set -e
if [ $APP_CALL_EXIT -ne 0 ]; then
  echo "✅ [LEAST PRIVILEGE PASS] Vai trò zt_app bị PostgreSQL từ chối quyền DDL DROP thành công!"
else
  echo "❌ [FAIL] zt_app vẫn gọi được drop partition!"
  exit 1
fi

# 4. Thực thi dọn dẹp phân vùng dưới vai trò chuyên trách zt_maintenance
echo "3. Thực thi dọn dẹp phân vùng dưới vai trò bảo trì zt_maintenance (Retention: 7 ngày)..."
docker exec zt_postgres psql -U zt_maintenance -d zt_serverops -v ON_ERROR_STOP=1 -c "
SELECT drop_old_metrics_partitions(7);
"

# 5. Kiểm tra kết quả: phân vùng cũ phải biến mất, phân vùng mới phải còn nguyên
echo "4. Kiểm tra sự tồn tại của các phân vùng sau khi dọn dẹp..."
CHECK_OLD=$(docker exec zt_postgres psql -U zt_admin -d zt_serverops -t -c "
SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = '${OLD_PART_NAME}';
" | tr -d ' ')

CHECK_TODAY=$(docker exec zt_postgres psql -U zt_admin -d zt_serverops -t -c "
SELECT COUNT(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = '${TODAY_PART_NAME}';
" | tr -d ' ')

if [ "$CHECK_OLD" -eq 0 ] && [ "$CHECK_TODAY" -ge 1 ]; then
  echo "✅ [RETENTION PASS] Phân vùng cũ (>7 ngày) đã được DROP hoàn toàn!"
  echo "✅ [RETENTION PASS] Phân vùng hôm nay được bảo toàn nguyên vẹn 100%!"
else
  echo "❌ [FAIL] Kết quả retention không đúng: Old Partitions=$CHECK_OLD (kỳ vọng 0), Today Partitions=$CHECK_TODAY (kỳ vọng 1)"
  exit 1
fi

# 6. Kiểm tra chặn tham số bất hợp lệ trên script bảo trì
echo "5. Kiểm tra script bảo trì chặn tham số retention bất hợp lệ (retention = 0)..."
set +e
docker exec -e RETENTION_DAYS=0 -e MAINTENANCE_DATABASE_URL="postgres://zt_maintenance:SecureMaintenance2026!@postgres:5432/zt_serverops" zt_gateway node dist/scripts/run-maintenance.js >/dev/null 2>&1
INVALID_EXIT=$?
set -e
if [ $INVALID_EXIT -ne 0 ]; then
  echo "✅ [VALIDATION PASS] Script bảo trì từ chối thành công tham số retention không hợp lệ!"
else
  echo "❌ [FAIL] Script bảo trì chấp nhận tham số không hợp lệ!"
  exit 1
fi

echo "🎉 [TEST MAINTENANCE COMPLETE] Tác vụ bảo trì và phân quyền đã kiểm chứng thành công 100%!"
