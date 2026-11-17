import crypto from 'node:crypto';
import type { Client } from 'pg';
import { z } from 'zod';
import { digest, EnrollmentError, type EnrollmentPublicConfig } from './enrollment-contract.js';

const IssueInput = z.object({
  node_name: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/),
  node_type: z.enum(['VM', 'BARE_METAL']).default('VM'),
  worker_os: z.enum(['linux', 'windows']),
  ssh_username: z.string().regex(/^[a-z][a-z0-9_-]{0,19}$/)
    .refine(value => !['root','admin','administrator'].includes(value)).default('ztuser'),
  ttl_seconds: z.number().int().min(60).max(86400).default(900),
  node_ip: z.string().ip({ version: 'v4' }).optional(),
}).strict();

function overlayAddress(address: string): boolean {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts[0] === 10 && parts[1] === 100 && parts[2] === 0 && parts[3] >= 3 && parts[3] <= 254;
}

export async function issueEnrollment(client: Client, input: unknown, metadata: EnrollmentPublicConfig) {
  const parsed = IssueInput.safeParse(input);
  if (!parsed.success || (parsed.data.node_ip && !overlayAddress(parsed.data.node_ip))) {
    throw new EnrollmentError(400, 'INVALID_INVITATION_INPUT');
  }
  const value = parsed.data;
  const token = crypto.randomBytes(32).toString('hex');
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('zt-node-registration'))");
    // Releasing expired reservations does not touch any already registered Worker.
    await client.query(`UPDATE public.worker_enrollments SET revoked_at = clock_timestamp()
      WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at <= clock_timestamp()`);
    const names = await client.query(`SELECT 1 FROM public.nodes WHERE name = $1
      UNION ALL SELECT 1 FROM public.worker_enrollments WHERE node_name = $1
        AND consumed_at IS NULL AND revoked_at IS NULL`, [value.node_name]);
    if (names.rowCount) throw new EnrollmentError(409, 'NODE_REGISTRATION_CONFLICT');
    const available = await client.query<{ ip: string }>(`SELECT host(('10.100.0.0'::inet + candidate)::inet) AS ip
      FROM generate_series(3,254) AS candidate
      WHERE ($1::inet IS NULL OR '10.100.0.0'::inet + candidate = $1::inet)
        AND NOT EXISTS (SELECT 1 FROM public.nodes n WHERE n.ip_address = '10.100.0.0'::inet + candidate)
        AND NOT EXISTS (SELECT 1 FROM public.worker_enrollments e
          WHERE e.node_ip = '10.100.0.0'::inet + candidate AND e.consumed_at IS NULL AND e.revoked_at IS NULL)
      ORDER BY candidate LIMIT 1`, [value.node_ip ?? null]);
    if (!available.rows[0]) throw new EnrollmentError(409, 'NO_AVAILABLE_WORKER_ADDRESS');
    const created = await client.query<{ id: string; expires_at: Date }>(`INSERT INTO public.worker_enrollments
      (gateway_id,token_hash,node_name,node_ip,node_type,worker_os,ssh_username,expires_at)
      VALUES($1,$2,$3,$4::inet,$5,$6,$7,clock_timestamp()+make_interval(secs=>$8)) RETURNING id,expires_at`,
    [metadata.gateway_id, digest(token), value.node_name, available.rows[0].ip,
      value.node_type, value.worker_os, value.ssh_username, value.ttl_seconds]);
    await client.query('COMMIT');
    const { gateway_api_url: _api, ...invitationMetadata } = metadata;
    return { version: 1, ...invitationMetadata, invitation_id: created.rows[0].id, join_token: token,
      expires_at: created.rows[0].expires_at.toISOString(), node_name: value.node_name,
      node_type: value.node_type, worker_os: value.worker_os, ssh_username: value.ssh_username };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

export async function revokeEnrollment(client: Client, input: unknown) {
  const value = z.object({ invitation_id: z.string().uuid() }).strict().safeParse(input);
  if (!value.success) throw new EnrollmentError(400, 'INVALID_INVITATION_INPUT');
  const updated = await client.query(`UPDATE public.worker_enrollments SET revoked_at = COALESCE(revoked_at,clock_timestamp())
    WHERE id=$1 RETURNING id`, [value.data.invitation_id]);
  if (!updated.rowCount) throw new EnrollmentError(404, 'INVITATION_NOT_FOUND');
  return { invitation_id: updated.rows[0].id as string, revoked: true };
}

export async function enrollmentStatus(client: Client, input: unknown) {
  const value = z.object({ invitation_id: z.string().uuid().optional(),
    node_name: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/).optional() }).strict().safeParse(input);
  if (!value.success) throw new EnrollmentError(400, 'INVALID_INVITATION_INPUT');
  const admins = await client.query("SELECT count(*)::int n FROM public.users WHERE role='ADMIN' AND is_active");
  const result: Record<string, unknown> = { active_admins: admins.rows[0].n };
  if (value.data.invitation_id) {
    const r = await client.query(`SELECT id,node_name,(consumed_at IS NOT NULL) consumed,
      (revoked_at IS NOT NULL) revoked,(expires_at<=clock_timestamp()) expired
      FROM public.worker_enrollments WHERE id=$1`, [value.data.invitation_id]);
    result.invitation = r.rows[0] ?? null;
  }
  if (value.data.node_name) {
    const r = await client.query('SELECT name,status,last_seen,ssh_username FROM public.nodes WHERE name=$1', [value.data.node_name]);
    result.node = r.rows[0] ?? null;
  }
  return result;
}
