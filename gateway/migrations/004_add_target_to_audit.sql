-- Migration 004: Bổ sung cột target cho bảng audit_logs nếu chưa có
-- Đảm bảo tương thích ngược với các CSDL đã khởi tạo trước đó

SET lock_timeout = '2s';
SET statement_timeout = '10s';

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target VARCHAR(100);

RESET lock_timeout;
RESET statement_timeout;
