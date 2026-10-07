#!/usr/bin/env bash
# ==============================================================================
# KỊCH BẢN CÀI ĐẶT 1 DÒNG LỆNH CHO WORKER DAEMON LÊN LINUX HOST (install.sh)
# Dự án: ZT-ServerOps (do-an-co-so-nganh)
# Phụ trách: devops (chủ trì), agent, tester
# ==============================================================================

set -euo pipefail

# Kiểm tra quyền root
if [[ "${EUID}" -ne 0 ]]; then
    echo "❌ [LỖI QUYỀN HẠN] Kịch bản cài đặt bắt buộc phải chạy dưới quyền root (sudo)!"
    exit 1
fi

echo "🚀 [ZT-AGENT INSTALLER] Bắt đầu quy trình thiết lập Endpoint Worker Daemon..."

# Kiểm tra sự hiện diện của Python 3
if ! command -v python3 >/dev/null 2>&1; then
    echo "  └─> Đang cài đặt Python 3..."
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update && apt-get install -y python3
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache python3
    elif command -v pacman >/dev/null 2>&1; then
        pacman -Sy --noconfirm python
    fi
fi

INSTALL_DIR="/opt/zt-serverops/agent"
mkdir -p "${INSTALL_DIR}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "${SCRIPT_DIR}/src" ]]; then
    echo "  └─> Sao chép mã nguồn Daemon vào ${INSTALL_DIR}..."
    cp -r "${SCRIPT_DIR}/src"/* "${INSTALL_DIR}/"
fi

# Thiết lập tệp biến môi trường cho Daemon
# Kiểm tra biến NODE_TOKEN bắt buộc khi cài đặt mới
if [[ -z "${NODE_TOKEN:-}" ]] && [[ ! -f "${ENV_TARGET}" ]]; then
    echo "❌ [LỖI BẢO MẬT] Biến môi trường NODE_TOKEN bắt buộc phải được truyền vào (ví dụ: NODE_TOKEN=xxx ./install.sh)!"
    exit 1
fi

if [[ ! -f "${ENV_TARGET}" ]]; then
    echo "  └─> Khởi tạo tệp cấu hình ${ENV_TARGET}..."
    cat <<EOF > "${ENV_TARGET}"
GATEWAY_URL=${GATEWAY_URL:-http://10.100.0.1:3000}
NODE_ID=${NODE_ID:-$(hostname)}
NODE_TOKEN=${NODE_TOKEN}
BEACON_INTERVAL_SECONDS=3.0
MAX_BACKOFF_SECONDS=30.0
JITTER_RATIO=0.1
EOF
    chmod 600 "${ENV_TARGET}"
fi

# Tạo tài khoản hệ thống chuyên trách zt-agent (Non-root Least Privilege)
if ! id -u zt-agent >/dev/null 2>&1; then
    echo "  └─> Khởi tạo người dùng hệ thống không đặc quyền zt-agent..."
    useradd --system --no-create-home --shell /bin/false zt-agent 2>/dev/null || adduser -S -D -H zt-agent 2>/dev/null || true
fi
chown -R zt-agent:zt-agent "${INSTALL_DIR}" 2>/dev/null || true

# Khởi tạo dịch vụ Linux Systemd Unit gia cố bảo mật
SYSTEMD_SERVICE="/etc/systemd/system/zt-agent.service"
echo "  └─> Cấu hình dịch vụ Systemd gia cố tại ${SYSTEMD_SERVICE}..."
cat <<EOF > "${SYSTEMD_SERVICE}"
[Unit]
Description=ZT-ServerOps Endpoint Worker Daemon
After=network.target

[Service]
Type=simple
User=zt-agent
Group=zt-agent
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_TARGET}
ExecStart=/usr/bin/python3 ${INSTALL_DIR}/main.py
Restart=always
RestartSec=3s
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

if command -v systemctl >/dev/null 2>&1; then
    echo "  └─> Nạp lại tiến trình Systemd và kích hoạt dịch vụ..."
    systemctl daemon-reload
    systemctl enable zt-agent.service || true
    systemctl restart zt-agent.service || true
    echo "✔ Dịch vụ zt-agent đã được cài đặt và khởi chạy thành công!"
else
    echo "ℹ Hệ thống không sử dụng systemd (môi trường container). Bỏ qua bước nạp dịch vụ."
fi

echo "✅ [ZT-AGENT INSTALLER] Hoàn tất cài đặt thành công!"
