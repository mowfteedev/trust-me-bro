-- Ratios are derived from the measured byte counts, not independent facts.
-- Keep sample keys, raw measurements, partitions and foreign keys unchanged.
SET lock_timeout = '2s';
SET statement_timeout = '10s';

ALTER TABLE public.metrics_history
    DROP COLUMN IF EXISTS ram_percent,
    DROP COLUMN IF EXISTS disk_percent;

RESET lock_timeout;
RESET statement_timeout;
