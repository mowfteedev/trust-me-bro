-- ==============================================================================
-- THIẾT LẬP VAI TRÒ ĐẶC QUYỀN TỐI THIỂU CHO ỨNG DỤNG GATEWAY (B1 / B3 REMEDIATION)
-- Dự án: ZT-ServerOps (do-an-co-so-nganh)
-- Phụ trách: security (chủ trì), database
-- Tham chiếu: R02, N01, N02, N03, N04
-- ==============================================================================

-- 1. Tạo vai trò zt_app không có đặc quyền Superuser (P1 REMEDIATION)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zt_app') THEN
    CREATE ROLE zt_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  ELSE
    ALTER ROLE zt_app WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
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

-- 4. Cấp quyền trên bảng phân vùng metrics_history
GRANT SELECT, INSERT ON TABLE metrics_history TO zt_app;

-- 5. BẢO MẬT BẤT BIẾN AUDIT LOG (B3 REMEDIATION):
-- zt_app chỉ có quyền SELECT và INSERT trên audit_logs.
-- Thu hồi toàn bộ quyền UPDATE, DELETE, TRUNCATE trên audit_logs.
GRANT SELECT, INSERT ON TABLE audit_logs TO zt_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM zt_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM PUBLIC;

-- 6. THU HỒI QUYỀN SỬA ĐỔI SCHEMA_MIGRATIONS TỪ ZT_APP (R02 REMEDIATION):
CREATE TABLE IF NOT EXISTS schema_migrations (
  name VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE schema_migrations FROM zt_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE schema_migrations FROM PUBLIC;
GRANT SELECT ON TABLE schema_migrations TO zt_app;

-- 7. Quyền sử dụng sequence
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO zt_app;

-- 8. THIẾT LẬP SECURITY DEFINER VÀ CẤP QUYỀN FUNCTION AN TOÀN (N03 REMEDIATION):
REVOKE ALL ON FUNCTION public.create_daily_metrics_partition(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drop_old_metrics_partitions(integer) FROM PUBLIC;

-- zt_app chỉ có quyền tạo partition, không có quyền xóa partition
GRANT EXECUTE ON FUNCTION public.create_daily_metrics_partition(date) TO zt_app;
REVOKE EXECUTE ON FUNCTION public.drop_old_metrics_partitions(integer) FROM zt_app;

-- 9. THIẾT LẬP VAI TRÒ BẢO TRÌ ĐỊNH KỲ (MAINTENANCE PRINCIPAL):
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zt_maintenance') THEN
    CREATE ROLE zt_maintenance WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END $$;
GRANT CONNECT ON DATABASE zt_serverops TO zt_maintenance;
GRANT USAGE ON SCHEMA public TO zt_maintenance;
GRANT EXECUTE ON FUNCTION public.drop_old_metrics_partitions(integer) TO zt_maintenance;

