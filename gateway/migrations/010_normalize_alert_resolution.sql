-- Stop the old Gateway before applying this contract migration.
-- A resolution timestamp is authoritative; never guess how to repair old conflicts.
SET lock_timeout = '2s';
SET statement_timeout = '10s';

LOCK TABLE public.alerts IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.alerts'::regclass
          AND attname = 'resolved' AND NOT attisdropped
    ) THEN
        IF EXISTS (
            SELECT 1 FROM public.alerts
            WHERE resolved IS DISTINCT FROM (resolved_at IS NOT NULL)
        ) THEN
            RAISE EXCEPTION 'Alert resolution is inconsistent; preserve the backup and reconcile before migration 010'
                USING ERRCODE = '23514';
        END IF;
    END IF;
END;
$$;

DROP INDEX IF EXISTS public.ix_alerts_node_unresolved;
ALTER TABLE public.alerts DROP COLUMN IF EXISTS resolved;
CREATE INDEX ix_alerts_node_unresolved ON public.alerts (node_id)
    WHERE resolved_at IS NULL;

RESET lock_timeout;
RESET statement_timeout;
