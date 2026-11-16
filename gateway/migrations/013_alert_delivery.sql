-- Notification intent is committed with its incident; no external broker.
SET lock_timeout = '2s';
SET statement_timeout = '10s';
CREATE TABLE public.alert_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id UUID NOT NULL REFERENCES public.alerts(id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK (phase IN ('OPEN', 'RECOVERY')),
    text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4096),
    status TEXT NOT NULL DEFAULT 'PENDING'
      CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DRY_RUN', 'DISABLED')),
    attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_attempt_at TIMESTAMPTZ,
    last_error VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (alert_id, phase)
);
CREATE INDEX ix_alert_notifications_pending
 ON public.alert_notifications (next_attempt_at, created_at)
 WHERE status IN ('PENDING', 'PROCESSING');
REVOKE ALL ON public.alert_notifications FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.alert_notifications TO zt_app;
GRANT SELECT ON public.alert_notifications TO zt_maintenance;
RESET lock_timeout;
RESET statement_timeout;
