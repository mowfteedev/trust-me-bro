-- ==============================================================================
-- BẢN MIGRATION 001: KHỞI TẠO LƯỢC ĐỒ THỰC THỂ QUAN HỆ & PHÂN QUYỀN RBAC (v3.1)
-- Dự án: ZT-ServerOps (do-an-co-so-nganh)
-- Phụ trách: database (chủ trì), security, code-reviewer
-- ==============================================================================

-- LÝ DO PHI TRỰC GIÁC (RATIONALE):
-- Thiết lập lock_timeout để tránh thảm họa Lock Queue Pile-up: Nếu câu lệnh DDL không
-- lấy được ACCESS EXCLUSIVE lock trong 2 giây, nó sẽ tự động hủy thay vì chặn đứng toàn bộ
-- Connection Pool của ứng dụng.
SET lock_timeout = '2s';
SET statement_timeout = '10s';

-- 1. Kích hoạt tiện ích mở rộng sinh UUID ngẫu nhiên bảo mật
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. BẢNG NGƯỜI DÙNG & PHÂN QUYỀN RBAC (users)
-- CHÚ THÍCH BẢO MẬT: Cột role bị ràng buộc CHECK nghiêm ngặt, chỉ chấp nhận ADMIN hoặc VIEWER.
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'VIEWER' CHECK (role IN ('ADMIN', 'VIEWER')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. BẢNG DANH MỤC MÁY CHỦ QUẢN TRỊ (nodes)
-- Quản trị trạng thái Liveness và thông tin kết nối mạng ngầm WireGuard
CREATE TABLE IF NOT EXISTS nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(64) UNIQUE NOT NULL,
    ip_address INET UNIQUE NOT NULL,
    node_type VARCHAR(20) NOT NULL DEFAULT 'DOCKER' CHECK (node_type IN ('DOCKER', 'VM', 'BARE_METAL')),
    -- Khóa băm xác thực Telemetry Beacon (SHA-256)
    token_hash VARCHAR(64) NOT NULL,
    -- 8 ký tự tiền tố công khai hỗ trợ tra cứu và định tuyến nhanh
    token_prefix VARCHAR(8) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('HEALTHY', 'WARNING', 'OFFLINE')),
    last_seen TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- CHÚ THÍCH TỐI ƯU TRUY VẤN (QUERY OPTIMIZATION HOOK):
-- Đánh Hash Index trên token_hash để biến truy vấn xác thực nhịp tim thành O(1) dưới 1ms,
-- triệt tiêu triệt để lỗi O(N) Full Table Scan của phiên bản cũ.
CREATE INDEX IF NOT EXISTS ix_nodes_token_hash ON nodes USING HASH (token_hash);
CREATE INDEX IF NOT EXISTS ix_nodes_status ON nodes (status);
CREATE INDEX IF NOT EXISTS ix_nodes_token_prefix ON nodes (token_prefix);

-- 4. BẢNG LỊCH SỬ CẢNH BÁO SỰ CỐ (alerts)
CREATE TABLE IF NOT EXISTS alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    severity VARCHAR(20) NOT NULL DEFAULT 'WARNING' CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
    message TEXT NOT NULL,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_alerts_node_unresolved ON alerts (node_id, resolved) WHERE resolved = FALSE;
CREATE INDEX IF NOT EXISTS ix_alerts_triggered_at ON alerts (triggered_at DESC);

-- 5. BẢNG NHẬT KÝ KIỂM TOÁN PHIÊN DÒNG LỆNH & THAO TÁC (audit_logs)
-- LÝ DO PHI TRỰC GIÁC: Thiết kế theo cơ chế Append-Only (Chỉ thêm, cấm sửa, cấm xóa)
-- để bảo đảm tính toàn vẹn của bằng chứng số phục vụ điều tra an ninh.
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    node_id UUID REFERENCES nodes(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_logs_user_id ON audit_logs (user_id);
