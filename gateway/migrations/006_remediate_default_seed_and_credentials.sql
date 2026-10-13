-- ==============================================================================
-- BẢN MIGRATION 006: THIẾT LẬP VAI TRÒ ZT_APP VÀ VÔ HIỆU HÓA THÔNG TIN XÁC THỰC MẪU
-- Dự án: ZT-ServerOps (do-an-co-so-nganh)
-- Phụ trách: database (chủ trì), security, tech-lead
-- Tham chiếu: R01, R02, B1, B3
-- ==============================================================================

-- 1. TẠO VAI TRÒ ZT_APP NẾU CHƯA TỒN TẠI
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zt_app') THEN
    CREATE ROLE zt_app WITH LOGIN PASSWORD 'SecureAppRole2026!' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END $$;

-- 2. CẤP QUYỀN TRUY CẬP VÀ PHẠM VI LƯỢC ĐỒ (SCHEMA USAGE)
GRANT CONNECT ON DATABASE zt_serverops TO zt_app;
GRANT USAGE ON SCHEMA public TO zt_app;

-- 3. CẤP QUYỀN DML TỐI THIỂU TRÊN CÁC BẢNG DỮ LIỆU
GRANT SELECT, INSERT, UPDATE ON TABLE users TO zt_app;
GRANT SELECT, INSERT, UPDATE ON TABLE nodes TO zt_app;
GRANT SELECT, INSERT, UPDATE ON TABLE alerts TO zt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE system_settings TO zt_app;
GRANT SELECT, INSERT ON TABLE metrics_history TO zt_app;

-- 4. BẢO MẬT BẤT BIẾN AUDIT LOG (B3 FAIL-CLOSED ENFORCEMENT):
-- zt_app chỉ có quyền SELECT và INSERT trên audit_logs.
-- Thu hồi toàn bộ quyền UPDATE, DELETE, TRUNCATE từ zt_app và public.
GRANT SELECT, INSERT ON TABLE audit_logs TO zt_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM zt_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM PUBLIC;

-- 5. BẢO VỆ BẢNG SCHEMA_MIGRATIONS KHỎI VAI TRÒ RUNTIME (R02 REMEDIATION):
-- zt_app không được phép sửa đổi lịch sử migration
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE schema_migrations FROM zt_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE schema_migrations FROM PUBLIC;
GRANT SELECT ON TABLE schema_migrations TO zt_app;

-- 6. CẤP QUYỀN SỬ DỤNG SEQUENCE
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO zt_app;

-- 7. CẤP QUYỀN VÀ THIẾT LẬP SECURITY DEFINER CHO HÀM TẠO/XÓA PHÂN VÙNG (R02 REMEDIATION):
-- Giúp vai trò zt_app có thể tự động tạo partition hàng ngày mà không cần cấp quyền DDL trực tiếp trên bảng.
ALTER FUNCTION create_daily_metrics_partition(date) SECURITY DEFINER;
ALTER FUNCTION drop_old_metrics_partitions(integer) SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION create_daily_metrics_partition(date) TO zt_app;
GRANT EXECUTE ON FUNCTION drop_old_metrics_partitions(integer) TO zt_app;

-- 8. THU HỒI / VÔ HIỆU HÓA TOÀN BỘ TÀI KHOẢN VÀ TOKEN MẶC ĐỊNH CŨ (R01 & B1 REMEDIATION):
-- Vô hiệu hóa tài khoản admin và viewer nếu vẫn mang mật khẩu mặc định từ seed cũ
UPDATE users
SET is_active = FALSE,
    updated_at = (now() AT TIME ZONE 'UTC')
WHERE username IN ('admin', 'viewer')
  AND (
    password_hash LIKE '7b8761930e6e9030a1678561f5a87cea%' -- Hash của SecureAdmin2026!
    OR password_hash LIKE '99b3aba269d84d5f21bf59f235b7bd03%' -- Hash của SecureViewer2026!
  );

-- Thu hồi node-worker-01 nếu vẫn dùng pre-shared token mặc định 'secret-token-worker-01'
DELETE FROM nodes
WHERE token_prefix = 'secret-t'
  AND token_hash = '10a3ce77a769aabf8361db2ba4aab0af15bdb1352c84f66dea2280049de5cecc';
