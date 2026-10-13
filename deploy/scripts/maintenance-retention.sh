#!/bin/bash
set -euo pipefail

# ==============================================================================
# SCRIPT CHẠY BẢO TRÌ ĐỊNH KỲ PHÂN VÙNG DỮ LIỆU METRICS (CRONJOB RUNBOOK)
# Sử dụng: Chạy qua cron hàng ngày (VD: 02:00 UTC) hoặc trigger thủ công
# Quyền hạn: Sử dụng vai trò chuyên trách zt_maintenance (N03 Remediation)
# ==============================================================================

MAINTENANCE_DB_URL="${MAINTENANCE_DATABASE_URL:-postgres://zt_maintenance:SecureMaintenance2026!@postgres:5432/zt_serverops}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
LOG_FILE="/app/logs/maintenance.log"

mkdir -p "$(dirname "$LOG_FILE")"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=========================================================="
echo "🕒 [$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Bắt đầu bảo trì phân vùng metrics"
echo "=========================================================="

# Chạy lệnh bảo trì qua script Node.js hoặc psql trực tiếp
if command -v node >/dev/null 2>&1 && [ -f "dist/scripts/run-maintenance.js" ]; then
  MAINTENANCE_DATABASE_URL="$MAINTENANCE_DB_URL" RETENTION_DAYS="$RETENTION_DAYS" node dist/scripts/run-maintenance.js
elif command -v psql >/dev/null 2>&1; then
  echo "Chạy trực tiếp qua psql với role zt_maintenance..."
  psql "$MAINTENANCE_DB_URL" -v ON_ERROR_STOP=1 -c "SELECT drop_old_metrics_partitions($RETENTION_DAYS);"
else
  echo "❌ [ERROR] Không tìm thấy Node.js hoặc psql để thực thi bảo trì!"
  exit 1
fi

echo "✔ [$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Hoàn tất bảo trì phân vùng thành công."
