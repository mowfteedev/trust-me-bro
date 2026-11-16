-- Per-device logout. Existing session_version continues to revoke all devices.
SET lock_timeout = '2s';
SET statement_timeout = '10s';

CREATE TABLE public.revoked_auth_sessions (
    jti UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_revoked_auth_sessions_expiry ON public.revoked_auth_sessions (expires_at);
GRANT SELECT, INSERT, DELETE ON public.revoked_auth_sessions TO zt_app;
GRANT SELECT, DELETE ON public.revoked_auth_sessions TO zt_maintenance;

RESET lock_timeout;
RESET statement_timeout;
