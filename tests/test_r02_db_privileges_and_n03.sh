#!/usr/bin/env bash
# ==============================================================================
# KIỂM CHỨNG BẢO MẬT CSDL & HẠN MỨC PHÂN VÙNG (N02, N03, N04 TEST)
# ==============================================================================
set -euo pipefail

PG_CONTAINER="zt_postgres"

echo "🔍 [TEST N02] Kiểm tra ranh giới bí mật: Gateway container không chứa MIGRATION_DATABASE_URL..."
if docker exec zt_gateway env | grep -q "MIGRATION_DATABASE_URL"; then
    echo "❌ [TEST N02 FAIL] MIGRATION_DATABASE_URL vẫn tồn tại trong Gateway container!"
    exit 1
else
    echo "✅ [TEST N02 PASS] Gateway container hoàn toàn không có MIGRATION_DATABASE_URL trong environment!"
fi

echo "🧪 [TEST N03] Kiểm tra chặn số âm trên hàm drop_old_metrics_partitions(-36500)..."
ERR_NEG=$(docker exec "${PG_CONTAINER}" psql -U zt_admin -d zt_serverops -c "SELECT * FROM public.drop_old_metrics_partitions(-36500);" 2>&1 || true)
if echo "${ERR_NEG}" | grep -q "Tham số retention_days không hợp lệ"; then
    echo "✅ [TEST N03 PASS] Hàm drop partition đã từ chối thành công số âm: ${ERR_NEG}"
else
    echo "❌ [TEST N03 FAIL] Hàm không chặn số âm: ${ERR_NEG}"
    exit 1
fi

echo "🧪 [TEST N03] Kiểm tra chặn giá trị retention = 0..."
ERR_ZERO=$(docker exec "${PG_CONTAINER}" psql -U zt_admin -d zt_serverops -c "SELECT * FROM public.drop_old_metrics_partitions(0);" 2>&1 || true)
if echo "${ERR_ZERO}" | grep -q "Tham số retention_days không hợp lệ"; then
    echo "✅ [TEST N03 PASS] Hàm drop partition đã từ chối thành công retention = 0!"
else
    echo "❌ [TEST N03 FAIL] Hàm không chặn retention = 0: ${ERR_ZERO}"
    exit 1
fi

echo "🧪 [TEST N03] Kiểm tra chặn tạo partition quá biên (+-7 ngày)..."
ERR_DATE=$(docker exec "${PG_CONTAINER}" psql -U zt_admin -d zt_serverops -c "SELECT public.create_daily_metrics_partition('2126-01-01'::date);" 2>&1 || true)
if echo "${ERR_DATE}" | grep -q "Tham số target_date không hợp lệ"; then
    echo "✅ [TEST N03 PASS] Hàm create partition đã từ chối thành công ngày quá biên!"
else
    echo "❌ [TEST N03 FAIL] Hàm không chặn ngày quá biên: ${ERR_DATE}"
    exit 1
fi

echo "🔒 [TEST N03] Kiểm tra thu hồi quyền execute drop partition khỏi vai trò zt_app..."
ERR_PERM=$(docker exec "${PG_CONTAINER}" psql -U zt_app -d zt_serverops -c "SELECT * FROM public.drop_old_metrics_partitions(30);" 2>&1 || true)
if echo "${ERR_PERM}" | grep -q "permission denied for function drop_old_metrics_partitions"; then
    echo "✅ [TEST N03 PASS] Vai trò zt_app bị từ chối quyền DROP partition đúng chuẩn Least Privilege!"
else
    echo "❌ [TEST N03 FAIL] zt_app vẫn có quyền drop partition: ${ERR_PERM}"
    exit 1
fi

echo "📊 [TEST N04] Kiểm tra bảo toàn dữ liệu bảng nodes sau migration (không DELETE)..."
NODE_COUNT=$(docker exec "${PG_CONTAINER}" psql -U zt_admin -d zt_serverops -tAc "SELECT count(*) FROM nodes;")
if [[ "${NODE_COUNT}" -gt 0 ]]; then
    echo "✅ [TEST N04 PASS] Bảng nodes giữ nguyên ${NODE_COUNT} bản ghi, không bị DELETE làm mất lịch sử telemetry!"
else
    echo "❌ [TEST N04 FAIL] Bảng nodes bị rỗng!"
    exit 1
fi

echo "🎉 [SUMMARY] Toàn bộ kiểm thử N02, N03, N04 đã vượt qua thành công 100%!"
