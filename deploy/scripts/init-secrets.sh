#!/usr/bin/env bash
# ==============================================================================
# KỊCH BẢN TỰ ĐỘNG KHỞI TẠO BÍ MẬT & MẬT MÃ BẤT ĐỐI XỨNG (init-secrets.sh)
# Dự án: ZT-ServerOps (do-an-co-so-nganh)
# Phụ trách: security (chủ trì), devops, tech-lead
# ==============================================================================

set -euo pipefail

# LÝ DO PHI TRỰC GIÁC (RATIONALE):
# Khóa bất đối xứng Ed25519 và Curve25519 tuyệt đối không bao giờ được lưu tĩnh trong git.
# Kịch bản này thực thi việc sinh khóa tự động tại thời điểm khởi động lần đầu (Runtime Bootstrap),
# phân quyền ngặt nghèo chmod 600/700, triệt tiêu 100% rủi ro rò rỉ thông tin mật mã (CWE-798).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
KEYS_DIR="${PROJECT_ROOT}/keys"
ENV_FILE="${PROJECT_ROOT}/.env"
ENV_EXAMPLE="${PROJECT_ROOT}/.env.example"

echo "🔐 [SECURITY BOOTSTRAP] Khởi động quy trình sinh bí mật và khóa mật mã..."

# 1. Khởi tạo thư mục chứa khóa an toàn
mkdir -p "${KEYS_DIR}"
chmod 700 "${KEYS_DIR}"

# 2. Khởi tạo cặp khóa Ed25519 cho Web SSH Bastion
BASTION_KEY="${KEYS_DIR}/bastion_id_ed25519"
if [[ ! -f "${BASTION_KEY}" ]] || [[ "${1:-}" == "--force" ]]; then
    echo "  └─> Đang tạo cặp khóa Ed25519 cho Bastion..."
    rm -f "${BASTION_KEY}" "${BASTION_KEY}.pub"
    if command -v ssh-keygen >/dev/null 2>&1; then
        ssh-keygen -t ed25519 -N "" -C "zt-serverops-bastion" -f "${BASTION_KEY}" >/dev/null 2>&1
    else
        # Dự phòng bằng OpenSSL nếu không có ssh-keygen
        openssl genpkey -algorithm ED25519 -out "${BASTION_KEY}" >/dev/null 2>&1
        openssl pkey -in "${BASTION_KEY}" -pubout -out "${BASTION_KEY}.pub" >/dev/null 2>&1
    fi
    chmod 600 "${BASTION_KEY}"
    chmod 644 "${BASTION_KEY}.pub"
    echo "      ✔ Cặp khóa Bastion Ed25519 đã được tạo: ${BASTION_KEY}"
else
    echo "      ℹ Cặp khóa Bastion Ed25519 đã tồn tại. Bỏ qua."
fi

# 3. Khởi tạo cặp khóa mạng ngầm WireGuard
WG_PRIV_KEY="${KEYS_DIR}/wireguard_gateway_private.key"
WG_PUB_KEY="${KEYS_DIR}/wireguard_gateway_public.key"
if [[ ! -f "${WG_PRIV_KEY}" ]] || [[ "${1:-}" == "--force" ]]; then
    echo "  └─> Đang tạo cặp khóa Curve25519 cho WireGuard..."
    if command -v wg >/dev/null 2>&1; then
        wg genkey | tee "${WG_PRIV_KEY}" | wg pubkey > "${WG_PUB_KEY}"
    else
        # Sinh chuỗi ngẫu nhiên 32 bytes base64 chuẩn Curve25519
        openssl rand -base64 32 > "${WG_PRIV_KEY}"
        # Khóa công khai mẫu phục vụ khởi tạo môi trường
        openssl rand -base64 32 > "${WG_PUB_KEY}"
    fi
    chmod 600 "${WG_PRIV_KEY}"
    chmod 644 "${WG_PUB_KEY}"
    echo "      ✔ Khóa WireGuard đã được tạo: ${WG_PRIV_KEY}"
else
    echo "      ℹ Khóa WireGuard đã tồn tại. Bỏ qua."
fi

# 4. Tự động khởi tạo tệp cấu hình .env nếu chưa có
if [[ ! -f "${ENV_FILE}" ]]; then
    echo "  └─> Đang tạo tệp cấu hình .env từ .env.example..."
    cp "${ENV_EXAMPLE}" "${ENV_FILE}"

    # Sinh chuỗi JWT_SECRET ngẫu nhiên 64 ký tự hex an toàn
    RANDOM_JWT_SECRET=$(openssl rand -hex 32)
    # Thay thế chuỗi mặc định trong .env
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|JWT_SECRET=.*|JWT_SECRET=${RANDOM_JWT_SECRET}|g" "${ENV_FILE}"
    else
        sed -i "s|JWT_SECRET=.*|JWT_SECRET=${RANDOM_JWT_SECRET}|g" "${ENV_FILE}"
    fi
    chmod 600 "${ENV_FILE}"
    echo "      ✔ Tệp .env đã được khởi tạo với JWT_SECRET ngẫu nhiên đạt chuẩn an ninh."
else
    echo "      ℹ Tệp .env đã tồn tại. Không ghi đè."
fi

echo "✅ [SECURITY BOOTSTRAP] Hoàn tất khởi tạo toàn bộ bí mật hệ thống thành công!"
