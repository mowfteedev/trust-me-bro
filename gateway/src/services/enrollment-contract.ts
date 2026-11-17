import crypto from 'node:crypto';
import { z } from 'zod';

export class EnrollmentError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}

export function publicWireGuardKey(value: string): string {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value || decoded.equals(Buffer.alloc(32))) {
    throw new EnrollmentError(400, 'INVALID_PUBLIC_KEY');
  }
  return value;
}

export function publicSshKey(value: string): { key: string; fingerprint: string } {
  const parts = value.trim().split(/\s+/);
  if (/[\r\n]/.test(value) || value.length > 512 || parts[0] !== 'ssh-ed25519' || !parts[1]) {
    throw new EnrollmentError(400, 'INVALID_SSH_PUBLIC_KEY');
  }
  const bytes = Buffer.from(parts[1], 'base64');
  const prefix = Buffer.from('0000000b7373682d6564323535313900000020', 'hex');
  if (bytes.length !== prefix.length + 32 || !bytes.subarray(0, prefix.length).equals(prefix)
    || bytes.toString('base64') !== parts[1]) throw new EnrollmentError(400, 'INVALID_SSH_PUBLIC_KEY');
  return { key: `ssh-ed25519 ${parts[1]}`,
    fingerprint: 'SHA256:' + crypto.createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '') };
}

const ClaimInput = z.object({
  invitation_id: z.string().uuid(),
  wireguard_public_key: z.string().length(44),
  ssh_host_public_key: z.string().min(60).max(512),
  node_token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
}).strict();

export function normalizeEnrollmentClaim(raw: unknown) {
  const parsed = ClaimInput.safeParse(raw);
  if (!parsed.success) throw new EnrollmentError(400, 'INVALID_ENROLLMENT_PAYLOAD');
  const value = parsed.data;
  const ssh = publicSshKey(value.ssh_host_public_key);
  return { ...value, wireguard_public_key: publicWireGuardKey(value.wireguard_public_key),
    ssh_host_public_key: ssh.key, host_key_fingerprint: ssh.fingerprint };
}

export function digest(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }

export function enrollmentPublicConfig(env: {
  ENROLLMENT_GATEWAY_PUBLIC_KEY?: string; ENROLLMENT_GATEWAY_ID?: string;
  ENROLLMENT_PUBLIC_URL?: string; ENROLLMENT_ENDPOINT?: string; ENROLLMENT_BASTION_PUBLIC_KEY?: string;
}) {
  const wireguard_public_key = publicWireGuardKey(env.ENROLLMENT_GATEWAY_PUBLIC_KEY || '');
  const gateway_id = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(wireguard_public_key, 'base64')).digest('hex');
  if (env.ENROLLMENT_GATEWAY_ID && env.ENROLLMENT_GATEWAY_ID !== gateway_id) throw new Error('Invalid enrollment Gateway ID');
  const url = new URL(env.ENROLLMENT_PUBLIC_URL || '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !['', '/'].includes(url.pathname)) throw new Error('Enrollment URL requires HTTPS origin');
  const endpoint = env.ENROLLMENT_ENDPOINT || '';
  const [host, port, extra] = endpoint.split(':');
  if (extra !== undefined || !z.string().ip({ version: 'v4' }).safeParse(host).success
    || !/^\d{1,5}$/.test(port || '') || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid WireGuard endpoint');
  return { gateway_id, registration_url: url.origin + '/api/enrollment/claim',
    wireguard_endpoint: `${host}:${Number(port)}`, wireguard_public_key,
    gateway_vpn_ip: '10.100.0.1', gateway_api_url: 'http://10.100.0.1:3000',
    bastion_public_key: publicSshKey(env.ENROLLMENT_BASTION_PUBLIC_KEY || '').key };
}

export type EnrollmentPublicConfig = ReturnType<typeof enrollmentPublicConfig>;
