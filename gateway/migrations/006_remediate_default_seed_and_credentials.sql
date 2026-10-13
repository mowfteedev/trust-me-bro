-- ==============================================================================
-- BẢN MIGRATION 006: THIẾT LẬP VAI TRÒ ZT_APP, BẢO VỆ PHÂN VÙNG VÀ THU HỒI CREDENTIALS MẪU
-- Dự án: ZT-ServerOps (do-an-co-so-nganh)
-- Phụ trách: database (chủ trì), security, tech-lead
-- Tham chiếu sửa đổi: N01, N02, N03, N04, P1
-- ==============================================================================

-- 1. TẠO VAI TRÒ ZT_APP NẾU CHƯA TỒN TẠI (P1 REMEDIATION - Không hardcode mật khẩu cố định)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zt_app') THEN
    CREATE ROLE zt_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  ELSE
    ALTER ROLE zt_app WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
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

-- 5. BẢO VỆ BẢNG SCHEMA_MIGRATIONS KHỎI VAI TRÒ RUNTIME (N01 & R02 REMEDIATION):
-- Đảm bảo bảng tồn tại trước khi REVOKE/GRANT để tránh lỗi crash khi chạy fresh database
CREATE TABLE IF NOT EXISTS schema_migrations (
  name VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE schema_migrations FROM zt_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE schema_migrations FROM PUBLIC;
GRANT SELECT ON TABLE schema_migrations TO zt_app;

-- 6. CẤP QUYỀN SỬ DỤNG SEQUENCE
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO zt_app;

-- 7. GIA CỐ HÀM TẠO VÀ XÓA PHÂN VÙNG METRICS THEO CHUẨN POSTGRESQL 16 (N03 REMEDIATION):
-- Hàm tự động tạo phân vùng an toàn với kiểm tra biên ngày (+-7 ngày)
CREATE OR REPLACE FUNCTION public.create_daily_metrics_partition(target_date DATE)
RETURNS TEXT
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    partition_name TEXT;
    start_date TEXT;
    end_date TEXT;
    today DATE;
BEGIN
    today := (now() AT TIME ZONE 'UTC')::date;
    -- RÀNG BUỘC BIÊN NGHIÊM NGẶT (N03 REMEDIATION):
    -- Chỉ cho phép tạo partition trong phạm vi +-7 ngày tính từ ngày hiện tại
    IF target_date IS NULL OR target_date < (today - 7) OR target_date > (today + 7) THEN
        RAISE EXCEPTION 'Tham số target_date không hợp lệ: chỉ cho phép tạo phân vùng trong phạm vi +-7 ngày từ hiện tại (giá trị: %)', target_date;
    END IF;

    partition_name := 'metrics_history_y' || to_char(target_date, 'YYYY_MM_DD');
    start_date := to_char(target_date, 'YYYY-MM-DD 00:00:00+00');
    end_date := to_char(target_date + 1, 'YYYY-MM-DD 00:00:00+00');

    -- Kiểm tra xem phân vùng đã tồn tại chưa bằng catalog schema-qualified
    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = partition_name
          AND n.nspname = 'public'
    ) THEN
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.metrics_history
             FOR VALUES FROM (%L) TO (%L);',
            partition_name, start_date, end_date
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON public.%I (node_id, recorded_at DESC);',
            'ix_' || partition_name || '_query', partition_name
        );
        RETURN 'Đã khởi tạo thành công phân vùng: ' || partition_name;
    END IF;

    RETURN 'Phân vùng đã tồn tại: ' || partition_name;
END;
$$ LANGUAGE plpgsql;

-- Hàm tự động xóa phân vùng cũ an toàn với kiểm tra biên retention nghiêm ngặt (7 đến 365 ngày)
CREATE OR REPLACE FUNCTION public.drop_old_metrics_partitions(retention_days INT)
RETURNS TABLE(dropped_partition TEXT)
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    part_record RECORD;
    cutoff_date DATE;
BEGIN
    -- RÀNG BUỘC BIÊN NGHIÊM NGẶT (N03 REMEDIATION):
    -- Triệt tiêu hoàn toàn lỗ hổng truyền số âm (-36500) xóa sạch toàn bộ partition
    IF retention_days IS NULL OR retention_days < 7 OR retention_days > 365 THEN
        RAISE EXCEPTION 'Tham số retention_days không hợp lệ: bắt buộc từ 7 đến 365 ngày (giá trị: %)', retention_days;
    END IF;

    cutoff_date := (now() AT TIME ZONE 'UTC')::date - retention_days;
    FOR part_record IN
        SELECT c.relname AS table_name
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
        WHERE i.inhparent = 'public.metrics_history'::regclass
          AND n.nspname = 'public'
          AND c.relname LIKE 'metrics_history_y%'
          AND c.relname != 'metrics_history_default'
    LOOP
        BEGIN
            IF to_date(substring(part_record.table_name from 'metrics_history_y(.*)'), 'YYYY_MM_DD') < cutoff_date THEN
                EXECUTE format('DROP TABLE IF EXISTS public.%I;', part_record.table_name);
                dropped_partition := part_record.table_name;
                RETURN NEXT;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            CONTINUE;
        END;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Thu hồi quyền mặc định từ PUBLIC trên cả hai hàm
REVOKE ALL ON FUNCTION public.create_daily_metrics_partition(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drop_old_metrics_partitions(integer) FROM PUBLIC;

-- zt_app chỉ có quyền tạo partition định kỳ, TUYỆT ĐỐI KHÔNG có quyền drop partition
GRANT EXECUTE ON FUNCTION public.create_daily_metrics_partition(date) TO zt_app;
REVOKE EXECUTE ON FUNCTION public.drop_old_metrics_partitions(integer) FROM zt_app;

-- 8. THU HỒI / VÔ HIỆU HÓA TOÀN BỘ TÀI KHOẢN VÀ TOKEN MẶC ĐỊNH CŨ (N04 & R01 REMEDIATION):
-- Vô hiệu hóa tài khoản admin và viewer nếu vẫn mang mật khẩu mặc định từ seed cũ, bump session_version
UPDATE public.users
SET is_active = FALSE,
    session_version = session_version + 1,
    updated_at = (now() AT TIME ZONE 'UTC')
WHERE username IN ('admin', 'viewer')
  AND (
    password_hash = '7b8761930e6e9030a1678561f5a87cea19a712f5a639d6ffcbe7a18816f1a8e1' -- Hash của SecureAdmin2026!
    OR password_hash = '99b3aba269d84d5f21bf59f235b7bd03eb555239a0665ba5c43d9943fe061555' -- Hash của SecureViewer2026!
    OR password_hash LIKE '7b8761930e6e9030a1678561f5a87cea%'
    OR password_hash LIKE '99b3aba269d84d5f21bf59f235b7bd03%'
  );

-- Vô hiệu hóa token worker mẫu mà KHÔNG DELETE NODE (N04 REMEDIATION - Bảo toàn lịch sử metrics/alerts/audit)
UPDATE public.nodes
SET token_hash = 'REVOKED_' || token_hash
WHERE token_prefix = 'secret-t'
  AND (
    token_hash = '10a3ce77a769aabf8361db2ba4aab0af15bdb1352c84f66dea2280049de5cecc'
    OR token_hash LIKE '10a3ce77a769%'
  );
