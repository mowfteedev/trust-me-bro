-- ==============================================================================
-- THIẾT LẬP VAI TRÒ ĐẶC QUYỀN TỐI THIỂU CHO ỨNG DỤNG GATEWAY (B1 / B3 REMEDIATION)
-- Dự án: ZT-ServerOps (do-an-co-so-nganh)
-- Phụ trách: security (chủ trì), database
-- ==============================================================================

-- 1. Tạo vai trò zt_app không có đặc quyền Superuser
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zt_app') THEN
    CREATE ROLE zt_app WITH LOGIN PASSWORD 'SecureAppRole2026!' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END $$;

-- 2. Cấp quyền truy cập database
GRANT CONNECT ON DATABASE zt_serverops TO zt_app;
GRANT USAGE ON SCHEMA public TO zt_app;

-- 3. Cấp quyền trên các bảng nghiệp vụ thông thường
GRANT SELECT, INSERT, UPDATE ON TABLE users TO zt_app;
GRANT SELECT, INSERT, UPDATE ON TABLE nodes TO zt_app;
GRANT SELECT, INSERT, UPDATE ON TABLE alerts TO zt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE system_settings TO zt_app;
GRANT SELECT, INSERT, UPDATE ON TABLE schema_migrations TO zt_app;

-- 4. Cấp quyền trên bảng phân vùng metrics_history
GRANT SELECT, INSERT ON TABLE metrics_history TO zt_app;

-- 5. BẢO MẬT BẤT BIẾN AUDIT LOG (B3 REMEDIATION):
-- zt_app chỉ có quyền SELECT và INSERT trên audit_logs.
-- Thu hồi toàn bộ quyền UPDATE, DELETE, TRUNCATE và sửa cấu trúc.
GRANT SELECT, INSERT ON TABLE audit_logs TO zt_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM zt_app;

-- 6. Quyền sử dụng sequence
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO zt_app;

-- 7. Quyền thực thi các stored procedure / function cần thiết
GRANT EXECUTE ON FUNCTION create_daily_metrics_partition(date) TO zt_app;
GRANT EXECUTE ON FUNCTION drop_old_metrics_partitions(integer) TO zt_app;
