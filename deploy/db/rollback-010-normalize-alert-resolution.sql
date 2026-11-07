-- Stop the new Gateway first. Run with psql -v ON_ERROR_STOP=1 as the DB owner.
-- Restore old-column compatibility from the authoritative timestamps, including
-- alerts created after migration 010. This does not restore unrelated app data.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
LOCK TABLE public.alerts IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.alerts ADD COLUMN IF NOT EXISTS resolved BOOLEAN;
UPDATE public.alerts SET resolved = (resolved_at IS NOT NULL);
ALTER TABLE public.alerts ALTER COLUMN resolved SET DEFAULT FALSE;
ALTER TABLE public.alerts ALTER COLUMN resolved SET NOT NULL;

DROP INDEX IF EXISTS public.ix_alerts_node_unresolved;
CREATE INDEX ix_alerts_node_unresolved ON public.alerts (node_id, resolved)
    WHERE resolved = FALSE;
DELETE FROM public.schema_migrations WHERE name = '010_normalize_alert_resolution.sql';
COMMIT;
