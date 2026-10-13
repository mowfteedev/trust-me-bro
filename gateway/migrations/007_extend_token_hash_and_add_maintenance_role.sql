-- ==============================================================================
-- BẢN MIGRATION 007: BỔ SUNG CỘT THU HỒI TOKEN, BẢNG LEASES VÀ PHÂN QUYỀN BẢO TRÌ
-- Dự án: ZT-ServerOps
-- Phụ trách: database, security, backend
-- Tham chiếu: R3-01, R3-02, R3-04, R3-05 (Review Round 3.1)
-- ==============================================================================

-- 1. MỞ RỘNG ĐỘ DÀI TOKEN_HASH VÀ BỔ SUNG CỘT IS_TOKEN_REVOKED (R3-02 REMEDIATION)
ALTER TABLE public.nodes ADD COLUMN IF NOT EXISTS is_token_revoked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.nodes ALTER COLUMN token_hash TYPE VARCHAR(128);

-- Cấp quyền DML tối thiểu cho vai trò runtime zt_app
GRANT SELECT, UPDATE ON TABLE public.nodes TO zt_app;

-- 2. THU HỒI TOKEN WORKER MẪU BẰNG EXACT FULL HASH (R3-05 REMEDIATION - BỎ LIKE PREFIX)
-- Exact SHA-256 hash của:
-- 'secret-token-worker-01' -> 10a3ce77a769aabf8361db2ba4aab0af15bdb1352c84f66dea2280049de5cecc
-- 'default_worker_secret_token_change_in_production' -> d745ca8cd1128b37239cc3f482f1281a162cea4515855e2d34fd6ccd7a890a02
UPDATE public.nodes
SET is_token_revoked = TRUE,
    updated_at = (now() AT TIME ZONE 'UTC')
WHERE token_hash IN (
  '10a3ce77a769aabf8361db2ba4aab0af15bdb1352c84f66dea2280049de5cecc',
  'd745ca8cd1128b37239cc3f482f1281a162cea4515855e2d34fd6ccd7a890a02'
);

-- 3. THIẾT LẬP VAI TRÒ BẢO TRÌ ĐỊNH KỲ ZT_MAINTENANCE (R3-05 REMEDIATION)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'zt_maintenance') THEN
    CREATE ROLE zt_maintenance WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END $$;

GRANT CONNECT ON DATABASE zt_serverops TO zt_maintenance;
GRANT USAGE ON SCHEMA public TO zt_maintenance;

-- 4. GIA CỐ HÀM DỌN DẸP PHÂN VÙNG METRICS - KHÔNG NUỐT LỖI DROP (R3-P1 REMEDIATION)
CREATE OR REPLACE FUNCTION public.drop_old_metrics_partitions(retention_days INT)
RETURNS TABLE(dropped_partition TEXT)
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    part_record RECORD;
    cutoff_date DATE;
BEGIN
    -- RÀNG BUỘC BIÊN NGHIÊM NGẶT (N03 & R3-P1 REMEDIATION):
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
        IF to_date(substring(part_record.table_name from 'metrics_history_y(.*)'), 'YYYY_MM_DD') < cutoff_date THEN
            EXECUTE format('DROP TABLE IF EXISTS public.%I;', part_record.table_name);
            dropped_partition := part_record.table_name;
            RETURN NEXT;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Thu hồi quyền từ PUBLIC và zt_app, chỉ cấp cho zt_maintenance
REVOKE ALL ON FUNCTION public.drop_old_metrics_partitions(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.drop_old_metrics_partitions(integer) FROM zt_app;
GRANT EXECUTE ON FUNCTION public.drop_old_metrics_partitions(integer) TO zt_maintenance;

-- 5. BẢNG BASTION_SESSION_LEASES PHỤC VỤ AUDIT LIFECYCLE VÀ HEARTBEAT FENCING (R3-04 REMEDIATION)
CREATE TABLE IF NOT EXISTS public.bastion_session_leases (
  session_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  node_id UUID NOT NULL REFERENCES public.nodes(id) ON DELETE CASCADE,
  instance_id VARCHAR(64) NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  closed_at TIMESTAMPTZ,
  close_reason VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_bastion_leases_active ON public.bastion_session_leases (lease_expires_at) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS ix_bastion_leases_reconcile ON public.bastion_session_leases (status, lease_expires_at);

-- zt_app có quyền quản lý lease phiên SSH đang mở
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bastion_session_leases TO zt_app;
