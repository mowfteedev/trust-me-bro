-- Worker offboarding and lifecycle state management
SET lock_timeout = '2s';
SET statement_timeout = '10s';

-- 1. Bổ sung trạng thái vòng đời quản trị cho bảng nodes
ALTER TABLE public.nodes ADD COLUMN IF NOT EXISTS lifecycle_state VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
  CHECK (lifecycle_state IN ('ACTIVE', 'RETIRING', 'REVOKED', 'REMOVED'));
ALTER TABLE public.nodes ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

-- 2. Thay thế ràng buộc UNIQUE cứng trên name và ip_address bằng Partial Unique Index.
-- Token hash vẫn giữ UNIQUE toàn cục vĩnh viễn (ix_nodes_token_hash) trên toàn bộ lịch sử.
ALTER TABLE public.nodes DROP CONSTRAINT IF EXISTS nodes_name_key;
ALTER TABLE public.nodes DROP CONSTRAINT IF EXISTS nodes_ip_address_key;

CREATE UNIQUE INDEX IF NOT EXISTS ix_nodes_active_name ON public.nodes(name)
  WHERE lifecycle_state IN ('ACTIVE', 'RETIRING');
CREATE UNIQUE INDEX IF NOT EXISTS ix_nodes_active_ip ON public.nodes(ip_address)
  WHERE lifecycle_state IN ('ACTIVE', 'RETIRING');

-- Đảm bảo 1 node chỉ map với đúng 1 consumed enrollment
CREATE UNIQUE INDEX IF NOT EXISTS ix_worker_enrollments_consumed_node
  ON public.worker_enrollments(node_id)
  WHERE consumed_at IS NOT NULL;

-- 3. Bảng quản lý chiến dịch thu hồi worker_offboardings
CREATE TABLE IF NOT EXISTS public.worker_offboardings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gateway_id TEXT NOT NULL CHECK (gateway_id ~ '^sha256:[0-9a-f]{64}$'),
    node_id UUID NOT NULL UNIQUE REFERENCES public.nodes(id) ON DELETE RESTRICT,
    enrollment_id UUID NOT NULL REFERENCES public.worker_enrollments(id) ON DELETE RESTRICT,
    node_name VARCHAR(64) NOT NULL CHECK (node_name ~ '^[A-Za-z0-9_-]{3,64}$'),
    node_ip INET NOT NULL CHECK (family(node_ip) = 4 AND masklen(node_ip) = 32
      AND node_ip >= '10.100.0.3'::inet AND node_ip <= '10.100.0.254'::inet),
    wireguard_public_key TEXT NOT NULL CHECK (wireguard_public_key ~ '^[A-Za-z0-9+/]{43}=$'),
    state VARCHAR(32) NOT NULL DEFAULT 'PENDING_PEER_REMOVAL'
      CHECK (state IN ('PENDING_PEER_REMOVAL', 'PENDING_LOCAL_CLEANUP', 'NEEDS_REVIEW', 'COMPLETED')),
    cleanup_token_hash TEXT UNIQUE CHECK (cleanup_token_hash IS NULL OR cleanup_token_hash ~ '^[0-9a-f]{64}$') ,
    cleanup_issued_at TIMESTAMPTZ,
    receipt_hash TEXT CHECK (receipt_hash IS NULL OR receipt_hash ~ '^[0-9a-f]{64}$'),
    receipt_data JSONB,
    last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 64),
    actor_id UUID REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    peer_removed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON public.worker_offboardings FROM PUBLIC, zt_app, zt_maintenance;

-- 4. Cập nhật hàm claim_worker_enrollment với bộ lọc lifecycle_state
CREATE OR REPLACE FUNCTION public.claim_worker_enrollment(
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
      IF NOT FOUND OR registered.is_token_revoked OR registered.token_hash <> p_node_token_hash
        OR registered.host_key_fingerprint IS DISTINCT FROM p_host_fingerprint
        OR registered.name <> invitation.node_name OR registered.ip_address <> invitation.node_ip
        OR registered.node_type <> invitation.node_type OR registered.ssh_username IS DISTINCT FROM invitation.ssh_username
        OR invitation.claim_hash <> p_claim_hash OR invitation.wireguard_public_key <> p_wireguard_key THEN
        RAISE EXCEPTION 'ENROLLMENT_CONFLICT';
      END IF;
    ELSE
      IF invitation.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'ENROLLMENT_GONE'; END IF;
      -- Chỉ xung đột tên hoặc IP với các node còn ACTIVE hoặc RETIRING;
      -- token_hash và wireguard_public_key luôn xung đột vĩnh viễn với toàn bộ lịch sử.
      IF EXISTS (SELECT 1 FROM public.nodes n WHERE (n.name = invitation.node_name OR n.ip_address = invitation.node_ip)
          AND n.lifecycle_state IN ('ACTIVE', 'RETIRING'))
        OR EXISTS (SELECT 1 FROM public.nodes n WHERE n.token_hash = p_node_token_hash)
        OR EXISTS (SELECT 1 FROM public.worker_enrollments e WHERE e.wireguard_public_key = p_wireguard_key) THEN
        RAISE EXCEPTION 'ENROLLMENT_CONFLICT';
      END IF;
      INSERT INTO public.nodes(name, ip_address, node_type, token_hash, token_prefix,
          host_key_fingerprint, ssh_username, status, lifecycle_state)
        VALUES(invitation.node_name, invitation.node_ip, invitation.node_type, p_node_token_hash,
          p_token_prefix, p_host_fingerprint, invitation.ssh_username, 'OFFLINE', 'ACTIVE')
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
REVOKE ALL ON FUNCTION public.claim_worker_enrollment(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, zt_maintenance;
GRANT EXECUTE ON FUNCTION public.claim_worker_enrollment(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO zt_app;

-- 5. Hàm khởi tạo quy trình thu hồi (begin_worker_offboarding)
CREATE OR REPLACE FUNCTION public.begin_worker_offboarding(
    p_node_id UUID, p_confirm_node_name TEXT, p_gateway_id TEXT, p_actor_id UUID
) RETURNS TABLE (
    operation_id UUID, node_id UUID, node_name TEXT, node_ip TEXT, node_type TEXT,
    worker_os TEXT, wireguard_public_key TEXT, state TEXT, created_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    actor public.users%ROWTYPE;
    target_node public.nodes%ROWTYPE;
    existing_op public.worker_offboardings%ROWTYPE;
    enrollment public.worker_enrollments%ROWTYPE;
    v_worker_os TEXT;
    v_count INT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('zt-node-registration'));
    IF p_node_id IS NULL OR p_confirm_node_name IS NULL OR p_gateway_id IS NULL OR p_actor_id IS NULL THEN
      RAISE EXCEPTION 'OFFBOARD_BAD_INPUT';
    END IF;

    SELECT u.* INTO actor FROM public.users u WHERE u.id = p_actor_id FOR UPDATE;
    IF NOT FOUND OR actor.role <> 'ADMIN' OR NOT actor.is_active THEN
      RAISE EXCEPTION 'OFFBOARD_UNAUTHORIZED';
    END IF;

    SELECT n.* INTO target_node FROM public.nodes n WHERE n.id = p_node_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OFFBOARD_NODE_NOT_FOUND';
    END IF;
    IF target_node.name IS DISTINCT FROM p_confirm_node_name THEN
      RAISE EXCEPTION 'OFFBOARD_NAME_MISMATCH';
    END IF;

    SELECT o.* INTO existing_op FROM public.worker_offboardings o WHERE o.node_id = p_node_id FOR UPDATE;
    IF FOUND THEN
      IF existing_op.gateway_id IS DISTINCT FROM p_gateway_id THEN
        RAISE EXCEPTION 'OFFBOARD_GATEWAY_MISMATCH';
      END IF;
      SELECT e.worker_os INTO v_worker_os FROM public.worker_enrollments e WHERE e.id = existing_op.enrollment_id;
      RETURN QUERY SELECT existing_op.id, existing_op.node_id, existing_op.node_name::text,
        host(existing_op.node_ip), target_node.node_type::text, v_worker_os,
        existing_op.wireguard_public_key, existing_op.state::text, existing_op.created_at;
      RETURN;
    END IF;

    SELECT count(*) INTO v_count FROM public.worker_enrollments e
      WHERE e.node_id = p_node_id AND e.gateway_id = p_gateway_id AND e.consumed_at IS NOT NULL;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'OFFBOARD_IDENTITY_UNAVAILABLE';
    END IF;

    SELECT e.* INTO enrollment FROM public.worker_enrollments e
      WHERE e.node_id = p_node_id AND e.gateway_id = p_gateway_id AND e.consumed_at IS NOT NULL
      FOR UPDATE;
    IF NOT FOUND OR enrollment.wireguard_public_key IS NULL THEN
      RAISE EXCEPTION 'OFFBOARD_IDENTITY_UNAVAILABLE';
    END IF;

    UPDATE public.nodes
       SET lifecycle_state = 'RETIRING', is_token_revoked = TRUE, updated_at = clock_timestamp()
     WHERE id = p_node_id;
    UPDATE public.worker_enrollments
       SET revoked_at = COALESCE(revoked_at, clock_timestamp())
     WHERE id = enrollment.id;

    INSERT INTO public.worker_offboardings (
      gateway_id, node_id, enrollment_id, node_name, node_ip,
      wireguard_public_key, state, actor_id
    ) VALUES (
      p_gateway_id, target_node.id, enrollment.id, target_node.name, target_node.ip_address,
      enrollment.wireguard_public_key, 'PENDING_PEER_REMOVAL', p_actor_id
    ) RETURNING * INTO existing_op;

    INSERT INTO public.audit_logs(node_id, action, target, details)
    VALUES (target_node.id, 'WORKER_OFFBOARD_STARTED', target_node.name,
      jsonb_build_object('operation_id', existing_op.id, 'gateway_id', p_gateway_id, 'actor_id', p_actor_id));

    RETURN QUERY SELECT existing_op.id, existing_op.node_id, existing_op.node_name::text,
      host(existing_op.node_ip), target_node.node_type::text, enrollment.worker_os,
      existing_op.wireguard_public_key, existing_op.state::text, existing_op.created_at;
END;
$$;
REVOKE ALL ON FUNCTION public.begin_worker_offboarding(UUID,TEXT,TEXT,UUID) FROM PUBLIC, zt_maintenance;
GRANT EXECUTE ON FUNCTION public.begin_worker_offboarding(UUID,TEXT,TEXT,UUID) TO zt_app;

-- 6. Xác nhận helper đã gỡ WireGuard peer an toàn (ack_worker_peer_removal)
CREATE OR REPLACE FUNCTION public.ack_worker_peer_removal(
    p_operation_id UUID, p_node_id UUID, p_gateway_id TEXT, p_wireguard_public_key TEXT, p_node_ip INET
) RETURNS TABLE (
    operation_id UUID, node_id UUID, lifecycle_state TEXT, state TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    op public.worker_offboardings%ROWTYPE;
    target_node public.nodes%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('zt-node-registration'));
    IF p_operation_id IS NULL OR p_node_id IS NULL OR p_gateway_id IS NULL
       OR p_wireguard_public_key IS NULL OR p_node_ip IS NULL THEN
      RAISE EXCEPTION 'OFFBOARD_BAD_INPUT';
    END IF;

    SELECT o.* INTO op FROM public.worker_offboardings o WHERE o.id = p_operation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'OFFBOARD_OPERATION_NOT_FOUND'; END IF;

    IF op.node_id IS DISTINCT FROM p_node_id
       OR op.gateway_id IS DISTINCT FROM p_gateway_id
       OR op.wireguard_public_key IS DISTINCT FROM p_wireguard_public_key
       OR op.node_ip IS DISTINCT FROM p_node_ip THEN
      RAISE EXCEPTION 'OFFBOARD_TUPLE_MISMATCH';
    END IF;

    SELECT n.* INTO target_node FROM public.nodes n WHERE n.id = p_node_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'OFFBOARD_NODE_NOT_FOUND'; END IF;

    IF target_node.lifecycle_state IN ('REVOKED', 'REMOVED') THEN
      RETURN QUERY SELECT op.id, op.node_id, target_node.lifecycle_state::text, op.state::text;
      RETURN;
    END IF;

    IF target_node.lifecycle_state <> 'RETIRING' THEN
      RAISE EXCEPTION 'OFFBOARD_INVALID_LIFECYCLE';
    END IF;

    UPDATE public.nodes
       SET lifecycle_state = 'REVOKED', retired_at = COALESCE(retired_at, clock_timestamp()), updated_at = clock_timestamp()
     WHERE id = p_node_id;
    UPDATE public.worker_offboardings
       SET state = 'PENDING_LOCAL_CLEANUP', peer_removed_at = COALESCE(peer_removed_at, clock_timestamp()),
           last_error = NULL, updated_at = clock_timestamp()
     WHERE id = p_operation_id;

    INSERT INTO public.audit_logs(node_id, action, target, details)
    VALUES (p_node_id, 'WORKER_PEER_REVOKED', op.node_name,
      jsonb_build_object('operation_id', p_operation_id, 'wireguard_public_key', p_wireguard_public_key));

    RETURN QUERY SELECT op.id, op.node_id, 'REVOKED'::text, 'PENDING_LOCAL_CLEANUP'::text;
END;
$$;
REVOKE ALL ON FUNCTION public.ack_worker_peer_removal(UUID,UUID,TEXT,TEXT,INET) FROM PUBLIC, zt_maintenance;
GRANT EXECUTE ON FUNCTION public.ack_worker_peer_removal(UUID,UUID,TEXT,TEXT,INET) TO zt_app;

-- 7. Cấp token dọn dẹp riêng biệt (issue_worker_cleanup_token)
CREATE OR REPLACE FUNCTION public.issue_worker_cleanup_token(
    p_operation_id UUID, p_node_id UUID, p_gateway_id TEXT, p_actor_id UUID, p_token_hash TEXT
) RETURNS TABLE (
    operation_id UUID, node_id UUID, node_name TEXT, node_ip TEXT, invitation_id UUID,
    wireguard_public_key TEXT, state TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    actor public.users%ROWTYPE;
    op public.worker_offboardings%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('zt-node-registration'));
    IF p_operation_id IS NULL OR p_node_id IS NULL OR p_gateway_id IS NULL
       OR p_actor_id IS NULL OR p_token_hash IS NULL THEN
      RAISE EXCEPTION 'OFFBOARD_BAD_INPUT';
    END IF;

    SELECT u.* INTO actor FROM public.users u WHERE u.id = p_actor_id FOR UPDATE;
    IF NOT FOUND OR actor.role <> 'ADMIN' OR NOT actor.is_active THEN
      RAISE EXCEPTION 'OFFBOARD_UNAUTHORIZED';
    END IF;
    IF p_token_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'OFFBOARD_BAD_INPUT';
    END IF;

    SELECT o.* INTO op FROM public.worker_offboardings o WHERE o.id = p_operation_id FOR UPDATE;
    IF NOT FOUND OR op.node_id IS DISTINCT FROM p_node_id OR op.gateway_id IS DISTINCT FROM p_gateway_id THEN
      RAISE EXCEPTION 'OFFBOARD_OPERATION_NOT_FOUND';
    END IF;
    IF op.state = 'COMPLETED' THEN
      RAISE EXCEPTION 'OFFBOARD_ALREADY_COMPLETED';
    END IF;

    UPDATE public.worker_offboardings
       SET cleanup_token_hash = p_token_hash, cleanup_issued_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE id = p_operation_id;

    RETURN QUERY SELECT op.id, op.node_id, op.node_name::text, host(op.node_ip),
      op.enrollment_id, op.wireguard_public_key, op.state::text;
END;
$$;
REVOKE ALL ON FUNCTION public.issue_worker_cleanup_token(UUID,UUID,TEXT,UUID,TEXT) FROM PUBLIC, zt_maintenance;
GRANT EXECUTE ON FUNCTION public.issue_worker_cleanup_token(UUID,UUID,TEXT,UUID,TEXT) TO zt_app;

-- 8. Xác thực capability dọn dẹp trước khi máy con thực thi (verify_worker_cleanup_capability)
CREATE OR REPLACE FUNCTION public.verify_worker_cleanup_capability(
    p_operation_id UUID, p_token_hash TEXT, p_gateway_id TEXT
) RETURNS TABLE (
    operation_id UUID, node_id UUID, node_name TEXT, node_ip TEXT, invitation_id UUID,
    wireguard_public_key TEXT, state TEXT, lifecycle_state TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    v_row RECORD;
BEGIN
    IF p_operation_id IS NULL OR p_token_hash IS NULL OR p_gateway_id IS NULL THEN
      RAISE EXCEPTION 'OFFBOARD_BAD_INPUT';
    END IF;

    SELECT o.id AS operation_id, o.node_id, o.node_name::text, host(o.node_ip) AS node_ip,
           o.enrollment_id AS invitation_id, o.wireguard_public_key, o.state::text, n.lifecycle_state::text
      INTO v_row
      FROM public.worker_offboardings o
      JOIN public.nodes n ON n.id = o.node_id
     WHERE o.id = p_operation_id AND o.cleanup_token_hash = p_token_hash AND o.gateway_id = p_gateway_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OFFBOARD_CAPABILITY_INVALID';
    END IF;
    RETURN QUERY SELECT v_row.operation_id, v_row.node_id, v_row.node_name, v_row.node_ip,
      v_row.invitation_id, v_row.wireguard_public_key, v_row.state, v_row.lifecycle_state;
END;
$$;
REVOKE ALL ON FUNCTION public.verify_worker_cleanup_capability(UUID,TEXT,TEXT) FROM PUBLIC, zt_maintenance;
GRANT EXECUTE ON FUNCTION public.verify_worker_cleanup_capability(UUID,TEXT,TEXT) TO zt_app;

-- 9. Hoàn tất hoặc ghi nhận NEEDS_REVIEW cho dọn dẹp cục bộ (complete_worker_offboarding)
CREATE OR REPLACE FUNCTION public.complete_worker_offboarding(
    p_operation_id UUID, p_token_hash TEXT, p_gateway_id TEXT,
    p_receipt_status TEXT, p_receipt_hash TEXT, p_receipt_data JSONB
) RETURNS TABLE (
    operation_id UUID, node_id UUID, state TEXT, lifecycle_state TEXT, replayed BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    op public.worker_offboardings%ROWTYPE;
    target_node public.nodes%ROWTYPE;
    v_receipt JSONB;
    v_steps JSONB;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('zt-node-registration'));
    IF p_operation_id IS NULL OR p_token_hash IS NULL OR p_gateway_id IS NULL
       OR p_receipt_status IS NULL OR p_receipt_hash IS NULL OR p_receipt_data IS NULL THEN
      RAISE EXCEPTION 'OFFBOARD_BAD_INPUT';
    END IF;
    IF p_receipt_status NOT IN ('COMPLETE', 'NEEDS_REVIEW') THEN
      RAISE EXCEPTION 'OFFBOARD_BAD_INPUT';
    END IF;
    IF p_receipt_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'OFFBOARD_BAD_INPUT';
    END IF;
    IF jsonb_typeof(p_receipt_data) <> 'object' OR octet_length(p_receipt_data::text) > 8192 THEN
      RAISE EXCEPTION 'OFFBOARD_BAD_INPUT';
    END IF;

    SELECT o.* INTO op FROM public.worker_offboardings o
     WHERE o.id = p_operation_id AND o.cleanup_token_hash = p_token_hash AND o.gateway_id = p_gateway_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OFFBOARD_CAPABILITY_INVALID';
    END IF;

    SELECT n.* INTO target_node FROM public.nodes n WHERE n.id = op.node_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OFFBOARD_NODE_NOT_FOUND';
    END IF;

    -- Kiểm tra đối chiếu tất cả trường định danh bất biến trong receipt payload
    IF (p_receipt_data->>'version') IS DISTINCT FROM '1'
       OR (p_receipt_data->>'operation_id')::uuid IS DISTINCT FROM op.id
       OR (p_receipt_data->>'node_id')::uuid IS DISTINCT FROM op.node_id
       OR (p_receipt_data->>'gateway_id') IS DISTINCT FROM op.gateway_id
       OR (p_receipt_data->>'invitation_id')::uuid IS DISTINCT FROM op.enrollment_id
       OR (p_receipt_data->>'wireguard_public_key') IS DISTINCT FROM op.wireguard_public_key
       OR (p_receipt_data->>'node_ip')::inet IS DISTINCT FROM op.node_ip
       OR (p_receipt_data->>'status') IS DISTINCT FROM p_receipt_status THEN
      RAISE EXCEPTION 'OFFBOARD_RECEIPT_IDENTITY_MISMATCH';
    END IF;

    -- Kiểm tra cấu trúc receipt nội bộ
    v_receipt := p_receipt_data->'receipt';
    IF v_receipt IS NULL OR jsonb_typeof(v_receipt) <> 'object' THEN
      RAISE EXCEPTION 'OFFBOARD_BAD_INPUT';
    END IF;
    IF v_receipt->>'platform' IS NULL OR v_receipt->>'platform' NOT IN ('linux', 'windows') THEN
      RAISE EXCEPTION 'OFFBOARD_BAD_INPUT';
    END IF;
    IF v_receipt->>'evidence_digest' IS NULL OR v_receipt->>'evidence_digest' !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'OFFBOARD_BAD_INPUT';
    END IF;

    v_steps := v_receipt->'steps';
    IF v_steps IS NULL OR jsonb_typeof(v_steps) <> 'object' THEN
      RAISE EXCEPTION 'OFFBOARD_BAD_INPUT';
    END IF;
    IF v_steps->>'agent' IS NULL OR v_steps->>'agent' NOT IN ('DONE', 'REVIEW')
       OR v_steps->>'tunnel' IS NULL OR v_steps->>'tunnel' NOT IN ('DONE', 'REVIEW')
       OR v_steps->>'firewall' IS NULL OR v_steps->>'firewall' NOT IN ('DONE', 'REVIEW')
       OR v_steps->>'ssh' IS NULL OR v_steps->>'ssh' NOT IN ('DONE', 'REVIEW')
       OR v_steps->>'secrets' IS NULL OR v_steps->>'secrets' NOT IN ('DONE', 'REVIEW') THEN
      RAISE EXCEPTION 'OFFBOARD_BAD_INPUT';
    END IF;

    IF p_receipt_status = 'COMPLETE' THEN
      IF (v_steps->>'agent') IS DISTINCT FROM 'DONE'
         OR (v_steps->>'tunnel') IS DISTINCT FROM 'DONE'
         OR (v_steps->>'firewall') IS DISTINCT FROM 'DONE'
         OR (v_steps->>'ssh') IS DISTINCT FROM 'DONE'
         OR (v_steps->>'secrets') IS DISTINCT FROM 'DONE' THEN
        RAISE EXCEPTION 'OFFBOARD_STEPS_INCOMPLETE';
      END IF;
    END IF;

    IF target_node.lifecycle_state NOT IN ('REVOKED', 'REMOVED') THEN
      RAISE EXCEPTION 'OFFBOARD_PEER_NOT_REVOKED';
    END IF;

    IF op.state = 'COMPLETED' THEN
      -- Replay bắt buộc so khớp cả hash lẫn toàn bộ payload jsonb
      IF op.receipt_hash = p_receipt_hash AND op.receipt_data = p_receipt_data THEN
        RETURN QUERY SELECT op.id, op.node_id, op.state::text, target_node.lifecycle_state::text, TRUE;
        RETURN;
      ELSE
        RAISE EXCEPTION 'OFFBOARD_RECEIPT_CONFLICT';
      END IF;
    END IF;

    IF p_receipt_status = 'NEEDS_REVIEW' THEN
      UPDATE public.worker_offboardings
         SET state = 'NEEDS_REVIEW', receipt_hash = p_receipt_hash, receipt_data = p_receipt_data,
             last_error = 'OPERATOR_NEEDS_REVIEW', updated_at = clock_timestamp()
       WHERE id = op.id;
      RETURN QUERY SELECT op.id, op.node_id, 'NEEDS_REVIEW'::text, target_node.lifecycle_state::text, FALSE;
      RETURN;
    END IF;

    -- p_receipt_status = 'COMPLETE'
    UPDATE public.nodes
       SET lifecycle_state = 'REMOVED', updated_at = clock_timestamp()
     WHERE id = op.node_id;
    UPDATE public.worker_offboardings
       SET state = 'COMPLETED', receipt_hash = p_receipt_hash, receipt_data = p_receipt_data,
           completed_at = clock_timestamp(), last_error = NULL, updated_at = clock_timestamp()
     WHERE id = op.id;

    INSERT INTO public.audit_logs(node_id, action, target, details)
    VALUES (op.node_id, 'WORKER_OFFBOARDED', op.node_name,
      jsonb_build_object('operation_id', op.id, 'receipt_hash', p_receipt_hash, 'reported_status', 'COMPLETE'));

    RETURN QUERY SELECT op.id, op.node_id, 'COMPLETED'::text, 'REMOVED'::text, FALSE;
END;
$$;
REVOKE ALL ON FUNCTION public.complete_worker_offboarding(UUID,TEXT,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC, zt_maintenance;
GRANT EXECUTE ON FUNCTION public.complete_worker_offboarding(UUID,TEXT,TEXT,TEXT,TEXT,JSONB) TO zt_app;

-- 10. Tra cứu trạng thái offboarding không để lộ cleanup token (get_worker_offboarding_status)
CREATE OR REPLACE FUNCTION public.get_worker_offboarding_status(
    p_node_id UUID, p_gateway_id TEXT
) RETURNS TABLE (
    operation_id UUID, node_id UUID, node_name TEXT, node_ip TEXT, wireguard_public_key TEXT,
    state TEXT, lifecycle_state TEXT, created_at TIMESTAMPTZ, peer_removed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ, last_error TEXT, has_cleanup_token BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    RETURN QUERY
    SELECT o.id, o.node_id, o.node_name::text, host(o.node_ip), o.wireguard_public_key,
           o.state::text, n.lifecycle_state::text, o.created_at, o.peer_removed_at,
           o.completed_at, o.last_error, (o.cleanup_token_hash IS NOT NULL)
      FROM public.worker_offboardings o
      JOIN public.nodes n ON n.id = o.node_id
     WHERE o.node_id = p_node_id AND o.gateway_id = p_gateway_id;
END;
$$;
REVOKE ALL ON FUNCTION public.get_worker_offboarding_status(UUID,TEXT) FROM PUBLIC, zt_maintenance;
GRANT EXECUTE ON FUNCTION public.get_worker_offboarding_status(UUID,TEXT) TO zt_app;

-- 11. Liệt kê các yêu cầu offboarding đang chờ gỡ peer WireGuard (list_pending_worker_offboardings)
CREATE OR REPLACE FUNCTION public.list_pending_worker_offboardings(
    p_gateway_id TEXT
) RETURNS TABLE (
    operation_id UUID, node_id UUID, invitation_id UUID, node_name TEXT, node_ip TEXT,
    wireguard_public_key TEXT, state TEXT, created_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    RETURN QUERY
    SELECT o.id, o.node_id, o.enrollment_id, o.node_name::text, host(o.node_ip),
           o.wireguard_public_key, o.state::text, o.created_at
      FROM public.worker_offboardings o
     WHERE o.state = 'PENDING_PEER_REMOVAL' AND o.gateway_id = p_gateway_id
     ORDER BY o.created_at ASC
     LIMIT 128;
END;
$$;
REVOKE ALL ON FUNCTION public.list_pending_worker_offboardings(TEXT) FROM PUBLIC, zt_maintenance;
GRANT EXECUTE ON FUNCTION public.list_pending_worker_offboardings(TEXT) TO zt_app;

-- 12. Kiểm tra tư cách đăng ký của node một cách an toàn không cần cấp quyền raw table (is_node_enrolled)
CREATE OR REPLACE FUNCTION public.is_node_enrolled(p_node_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.worker_enrollments e
     WHERE e.node_id = p_node_id AND e.consumed_at IS NOT NULL
  );
$$;
REVOKE ALL ON FUNCTION public.is_node_enrolled(UUID) FROM PUBLIC, zt_maintenance;
GRANT EXECUTE ON FUNCTION public.is_node_enrolled(UUID) TO zt_app;

-- 13. Ghi nhận mã lỗi an toàn cho quy trình thu hồi peer WireGuard (record_worker_offboarding_error)
CREATE OR REPLACE FUNCTION public.record_worker_offboarding_error(
    p_operation_id UUID, p_gateway_id TEXT, p_error_code TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    v_safe_code TEXT;
BEGIN
    IF p_operation_id IS NULL OR p_gateway_id IS NULL OR p_error_code IS NULL THEN
      RETURN;
    END IF;
    -- Ràng buộc mã lỗi hữu hạn và an toàn (tối đa 64 ký tự, chỉ gồm ký tự A-Z0-9_)
    IF p_error_code ~ '^[A-Z0-9_]{3,64}$' THEN
      v_safe_code := p_error_code;
    ELSE
      v_safe_code := 'PEER_REMOVE_FAILED';
    END IF;

    UPDATE public.worker_offboardings
       SET last_error = v_safe_code, updated_at = clock_timestamp()
     WHERE id = p_operation_id AND gateway_id = p_gateway_id AND state = 'PENDING_PEER_REMOVAL';
END;
$$;
REVOKE ALL ON FUNCTION public.record_worker_offboarding_error(UUID,TEXT,TEXT) FROM PUBLIC, zt_maintenance;
GRANT EXECUTE ON FUNCTION public.record_worker_offboarding_error(UUID,TEXT,TEXT) TO zt_app;

RESET lock_timeout;
RESET statement_timeout;
