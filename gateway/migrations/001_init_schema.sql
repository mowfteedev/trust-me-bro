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
-- Đánh B-Tree UNIQUE Index trên token_hash để vừa đạt tốc độ tra cứu tức thì < 0.1ms,
-- vừa triệt tiêu 100% rủi ro trùng lặp khóa token giữa các node.
CREATE UNIQUE INDEX IF NOT EXISTS ix_nodes_token_hash ON nodes (token_hash);
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
-- LÝ DO PHI TRỰC GIÁC: Thiết kế theo cơ chế Append-Only (Chỉ thêm, cấm sửa, cấm xóa).
-- Sử dụng ON DELETE RESTRICT để không vi phạm tính bất biến của bản ghi lịch sử.
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    node_id UUID REFERENCES nodes(id) ON DELETE RESTRICT,
    action VARCHAR(50) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_audit_logs_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_logs_user_id ON audit_logs (user_id);

-- Trigger ép buộc tính chất Append-Only: Chặn đứng mọi câu lệnh UPDATE hoặc DELETE
CREATE OR REPLACE FUNCTION prevent_audit_logs_tampering()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'LỖI AN NINH: Bảng audit_logs là Append-Only, cấm mọi thao tác UPDATE hoặc DELETE!';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_logs_tampering();
