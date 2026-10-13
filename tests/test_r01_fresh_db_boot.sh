#!/usr/bin/env bash
# ==============================================================================
# KIỂM CHỨNG KHỞI TẠO CƠ SỞ DỮ LIỆU TRÊN VOLUME SẠCH (N01 REMEDIATION TEST)
# ==============================================================================
set -euo pipefail

TEST_VOL="zt_test_fresh_volume_$(date +%s)"
TEST_PG="zt_test_fresh_postgres_$(date +%s)"
TEST_NET="zt_internal_net"

echo "🧪 [TEST N01] Khởi tạo volume trắng: ${TEST_VOL}..."
docker volume create "${TEST_VOL}" >/dev/null

cleanup() {
    echo "🧹 [CLEANUP] Đang giải phóng container và volume test..."
    docker rm -f "${TEST_PG}" >/dev/null 2>&1 || true
    docker volume rm -f "${TEST_VOL}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "🚀 [TEST N01] Khởi chạy PostgreSQL trên volume trắng (không mount migrations vào initdb)..."
docker run -d --name "${TEST_PG}" \
    --network "${TEST_NET}" \
    -v "${TEST_VOL}:/var/lib/postgresql/data" \
    -e POSTGRES_USER=zt_admin \
    -e POSTGRES_PASSWORD=SecurePassword123! \
    -e POSTGRES_DB=zt_serverops \
    postgres:16-alpine >/dev/null

echo "⏳ [TEST N01] Đang chờ PostgreSQL sẵn sàng..."
for i in {1..30}; do
    if docker exec "${TEST_PG}" pg_isready -U zt_admin -d zt_serverops >/dev/null 2>&1; then
        echo "✔ PostgreSQL đã sẵn sàng sau ${i}s."
        break
    fi
    sleep 1
done

echo "🚀 [TEST N01] Khởi chạy zt_migrator độc lập thực thi migrations 001 -> 006..."
docker run --rm \
    --network "${TEST_NET}" \
    -e DATABASE_URL="postgres://zt_admin:SecurePassword123!@${TEST_PG}:5432/zt_serverops" \
    -e NODE_ENV=production \
    test-gateway-build node dist/scripts/run-migrations.js

echo "🔍 [TEST N01] Kiểm tra lịch sử bảng schema_migrations trong CSDL mới..."
MIG_COUNT=$(docker exec "${TEST_PG}" psql -U zt_admin -d zt_serverops -tAc "SELECT count(*) FROM schema_migrations;")

echo "📊 Số lượng bản migration đã áp dụng: ${MIG_COUNT}"
if [[ "${MIG_COUNT}" -ge 6 ]]; then
    echo "✅ [TEST N01 PASS] Khởi tạo thành công 100% trên Volume mới tinh mà không gặp lỗi 'relation schema_migrations does not exist'!"
    exit 0
else
    echo "❌ [TEST N01 FAIL] Số lượng bản migration không đủ (${MIG_COUNT}/6)!"
    exit 1
fi
