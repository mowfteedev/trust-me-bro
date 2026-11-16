-- Retire the purge capability without deleting any audit records.
SET lock_timeout = '2s';
SET statement_timeout = '10s';

DROP FUNCTION IF EXISTS public.purge_audit_logs(INTERVAL, UUID, INET);

CREATE OR REPLACE FUNCTION public.prevent_audit_logs_tampering()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit logs are append-only; UPDATE and DELETE are prohibited.';
END;
$$ LANGUAGE plpgsql;

REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM zt_app;
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM zt_maintenance;
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM PUBLIC;

RESET lock_timeout;
RESET statement_timeout;
