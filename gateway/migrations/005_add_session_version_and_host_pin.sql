-- ==============================================================================
-- BẢN MIGRATION 005: THÊM SESSION_VERSION, HOST_KEY_PINNING & SYSTEM_SETTINGS
-- Dự án: ZT-ServerOps (do-an-co-so-nganh)
-- Phụ trách: security (chủ trì), database, backend
-- ==============================================================================

SET lock_timeout = '2s';
SET statement_timeout = '10s';

-- 1. Bổ sung session_version vào bảng users để quản lý thu hồi phiên và đăng xuất
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INT NOT NULL DEFAULT 1;

-- 2. Bổ sung host_key_fingerprint vào bảng nodes để ghim danh tính máy chủ SSH (Zero Trust Host Pinning)
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS host_key_fingerprint VARCHAR(128);

-- 3. Cập nhật host key fingerprint cho node-worker-01 lab
UPDATE nodes
SET host_key_fingerprint = '1cd868ec4d2db07f3a02c0725c84b0978f8611ab39274cdab42d10f3acf36cf2'
WHERE name = 'node-worker-01' AND (host_key_fingerprint IS NULL OR host_key_fingerprint = '');

-- 4. Bảng lưu trữ cấu hình bền vững cho hệ thống (Telegram Chat ID, System State)
CREATE TABLE IF NOT EXISTS system_settings (
    key VARCHAR(64) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

RESET lock_timeout;
RESET statement_timeout;
