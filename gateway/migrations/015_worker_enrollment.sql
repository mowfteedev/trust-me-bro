-- Invitations are local administrative capabilities, never Dashboard passwords.
SET lock_timeout = '2s';
SET statement_timeout = '10s';

CREATE TABLE public.worker_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gateway_id TEXT NOT NULL CHECK (gateway_id ~ '^sha256:[0-9a-f]{64}$'),
    token_hash TEXT UNIQUE NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    node_name VARCHAR(64) NOT NULL CHECK (node_name ~ '^[A-Za-z0-9_-]{3,64}$'),
    node_ip INET NOT NULL CHECK (family(node_ip) = 4 AND masklen(node_ip) = 32
      AND node_ip >= '10.100.0.3'::inet AND node_ip <= '10.100.0.254'::inet),
    node_type TEXT NOT NULL CHECK (node_type IN ('VM', 'BARE_METAL')),
    worker_os TEXT NOT NULL CHECK (worker_os IN ('linux', 'windows')),
    ssh_username VARCHAR(20) NOT NULL CHECK (ssh_username ~ '^[a-z][a-z0-9_-]{0,19}$'
      AND ssh_username NOT IN ('root','admin','administrator')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at),
    revoked_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    claim_hash TEXT CHECK (claim_hash ~ '^[0-9a-f]{64}$'),
    wireguard_public_key TEXT CHECK (wireguard_public_key ~ '^[A-Za-z0-9+/]{43}=$'),
    node_id UUID REFERENCES public.nodes(id) ON DELETE RESTRICT,
    CHECK ((consumed_at IS NULL AND claim_hash IS NULL AND node_id IS NULL AND wireguard_public_key IS NULL)
      OR (consumed_at IS NOT NULL AND claim_hash IS NOT NULL AND node_id IS NOT NULL AND wireguard_public_key IS NOT NULL))
);
CREATE UNIQUE INDEX ix_worker_enrollments_reserved_name ON public.worker_enrollments(node_name)
 WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX ix_worker_enrollments_reserved_ip ON public.worker_enrollments(node_ip)
 WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX ix_worker_enrollments_public_key ON public.worker_enrollments(wireguard_public_key)
 WHERE wireguard_public_key IS NOT NULL;
REVOKE ALL ON public.worker_enrollments FROM PUBLIC, zt_app, zt_maintenance;

CREATE FUNCTION public.claim_worker_enrollment(
    p_id UUID, p_invite_hash TEXT, p_gateway_id TEXT, p_claim_hash TEXT,
    p_node_token_hash TEXT, p_token_prefix TEXT, p_host_fingerprint TEXT, p_wireguard_key TEXT
) RETURNS TABLE (
    node_id UUID, node_name TEXT, node_ip TEXT, node_type TEXT, worker_os TEXT,
    ssh_username TEXT, wireguard_public_key TEXT, node_status TEXT,
    last_seen TIMESTAMPTZ, host_key_fingerprint TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    invitation public.worker_enrollments%ROWTYPE;
    registered public.nodes%ROWTYPE;
BEGIN
    -- This is also the lock used by the existing local node-registration CLI.
    PERFORM pg_advisory_xact_lock(hashtext('zt-node-registration'));
    SELECT e.* INTO invitation FROM public.worker_enrollments e
      WHERE e.id = p_id AND e.token_hash = p_invite_hash AND e.gateway_id = p_gateway_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ENROLLMENT_INVALID'; END IF;
    IF invitation.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'ENROLLMENT_GONE'; END IF;
    IF p_claim_hash IS NULL OR p_claim_hash !~ '^[0-9a-f]{64}$'
      OR p_node_token_hash IS NULL OR p_node_token_hash !~ '^[0-9a-f]{64}$'
      OR p_token_prefix IS NULL OR p_token_prefix !~ '^[A-Za-z0-9_-]{8}$'
      OR p_host_fingerprint IS NULL OR p_host_fingerprint !~ '^SHA256:[A-Za-z0-9+/]{43}$'
      OR p_wireguard_key IS NULL OR p_wireguard_key !~ '^[A-Za-z0-9+/]{43}=$' THEN
      RAISE EXCEPTION 'ENROLLMENT_BAD_INPUT';
    END IF;
    IF invitation.consumed_at IS NOT NULL THEN
      SELECT n.* INTO registered FROM public.nodes n WHERE n.id = invitation.node_id FOR UPDATE;
      -- Exact retries survive a lost response/expiry, but cannot choose another identity.
      IF NOT FOUND OR registered.is_token_revoked OR registered.token_hash <> p_node_token_hash
        OR registered.host_key_fingerprint IS DISTINCT FROM p_host_fingerprint
        OR registered.name <> invitation.node_name OR registered.ip_address <> invitation.node_ip
        OR registered.node_type <> invitation.node_type OR registered.ssh_username IS DISTINCT FROM invitation.ssh_username
        OR invitation.claim_hash <> p_claim_hash OR invitation.wireguard_public_key <> p_wireguard_key THEN
        RAISE EXCEPTION 'ENROLLMENT_CONFLICT';
      END IF;
    ELSE
      IF invitation.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'ENROLLMENT_GONE'; END IF;
      IF EXISTS (SELECT 1 FROM public.nodes n WHERE n.name = invitation.node_name
          OR n.ip_address = invitation.node_ip OR n.token_hash = p_node_token_hash)
        OR EXISTS (SELECT 1 FROM public.worker_enrollments e WHERE e.wireguard_public_key = p_wireguard_key) THEN
        RAISE EXCEPTION 'ENROLLMENT_CONFLICT';
      END IF;
      INSERT INTO public.nodes(name, ip_address, node_type, token_hash, token_prefix,
          host_key_fingerprint, ssh_username, status)
        VALUES(invitation.node_name, invitation.node_ip, invitation.node_type, p_node_token_hash,
          p_token_prefix, p_host_fingerprint, invitation.ssh_username, 'OFFLINE')
        RETURNING * INTO registered;
      UPDATE public.worker_enrollments e SET consumed_at = clock_timestamp(), claim_hash = p_claim_hash,
        wireguard_public_key = p_wireguard_key, node_id = registered.id WHERE e.id = invitation.id;
      invitation.wireguard_public_key := p_wireguard_key;
      INSERT INTO public.audit_logs(node_id, action, target, details)
        VALUES(registered.id, 'WORKER_ENROLLED', registered.name,
          jsonb_build_object('node_type', invitation.node_type, 'worker_os', invitation.worker_os));
    END IF;
    RETURN QUERY SELECT registered.id, registered.name::text, host(registered.ip_address),
      registered.node_type::text, invitation.worker_os, registered.ssh_username::text,
      invitation.wireguard_public_key, registered.status::text, registered.last_seen,
      registered.host_key_fingerprint::text;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_worker_enrollment(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_worker_enrollment(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO zt_app;

RESET lock_timeout;
RESET statement_timeout;
