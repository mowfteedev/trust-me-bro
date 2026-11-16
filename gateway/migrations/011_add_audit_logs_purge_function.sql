-- ==============================================================================
-- BẢN MIGRATION 011: HÀM DỌN DẸP NHẬT KÝ KIỂM TOÁN CÓ KIỂM SOÁT (PURGE AUDIT LOGS)
-- Dự án: ZT-ServerOps
-- Phụ trách: database, security, backend
-- ==============================================================================

SET lock_timeout = '2s';
SET statement_timeout = '10s';

-- 1. CẬP NHẬT TRIGGER FUNCTION CHO PHÉP DELETE KHI CÓ CỜ PHIÊN NỘI BỘ
CREATE OR REPLACE FUNCTION prevent_audit_logs_tampering()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('audit.allow_purge', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'LỖI AN NINH: Bảng audit_logs là Append-Only, cấm mọi thao tác UPDATE hoặc DELETE!';
END;
$$ LANGUAGE plpgsql;

-- 2. TẠO HÀM DỌN DẸP BẢO MẬT CAO VỚI RANH GIỚI WHITELIST
CREATE OR REPLACE FUNCTION public.purge_audit_logs(
    retention_interval INTERVAL,
    admin_user_id UUID DEFAULT NULL,
    client_ip INET DEFAULT NULL
)
RETURNS INT
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    deleted_rows INT := 0;
    cutoff_time TIMESTAMPTZ;
BEGIN
    -- Chỉ cho phép các mốc thời gian quy chuẩn: 1 day, 7 days, 30 days
    IF retention_interval NOT IN (INTERVAL '1 day', INTERVAL '7 days', INTERVAL '30 days') THEN
        RAISE EXCEPTION 'Tham số retention_interval không hợp lệ. Chỉ chấp nhận 1 day, 7 days hoặc 30 days.';
    END IF;

    cutoff_time := (now() AT TIME ZONE 'UTC') - retention_interval;

    -- Bật cờ cho phép xóa trong transaction nội bộ
    PERFORM set_config('audit.allow_purge', 'on', true);

    DELETE FROM public.audit_logs
    WHERE created_at < cutoff_time;

    GET DIAGNOSTICS deleted_rows = ROW_COUNT;

    -- Tắt cờ
    PERFORM set_config('audit.allow_purge', 'off', true);

    -- Ghi nhận sự kiện kiểm toán cho thao tác dọn dẹp (Audit the audit purge)
    INSERT INTO public.audit_logs (
        action,
        user_id,
        ip_address,
        target,
        details
    ) VALUES (
        'AUDIT_PURGED',
        admin_user_id,
        client_ip,
        'audit_logs',
        jsonb_build_object(
            'deleted_count', deleted_rows,
            'cutoff_time', cutoff_time,
            'retention', retention_interval::text
        )
    );

    RETURN deleted_rows;
END;
$$ LANGUAGE plpgsql;

-- 3. PHÂN QUYỀN THỰC THI (LEAST PRIVILEGE)
REVOKE ALL ON FUNCTION public.purge_audit_logs(INTERVAL, UUID, INET) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_audit_logs(INTERVAL, UUID, INET) TO zt_app;
GRANT EXECUTE ON FUNCTION public.purge_audit_logs(INTERVAL, UUID, INET) TO zt_maintenance;

RESET lock_timeout;
RESET statement_timeout;
