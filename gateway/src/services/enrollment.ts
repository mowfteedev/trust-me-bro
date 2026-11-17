import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client as SshClient } from 'ssh2';
import { config } from '../config/env.js';
import { query } from './db.js';
import { validateBastionKey } from './bastion/key.js';
import { digest, EnrollmentError, enrollmentPublicConfig, normalizeEnrollmentClaim } from './enrollment-contract.js';

type Registration = {
  node_id: string; node_name: string; node_ip: string; node_type: string;
  worker_os: string; ssh_username: string; wireguard_public_key: string;
  node_status: string; last_seen: Date | string | null; host_key_fingerprint: string;
};

function safeDirectory(directory: string, writable: boolean): void {
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== path.resolve(directory)) throw new Error('Invalid directory');
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o022) !== 0) throw new Error('Unsafe directory');
  if (writable && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw new Error('Unsafe request directory');
  if (!writable && config.NODE_ENV !== 'test' && stat.uid !== 0) throw new Error('Unsafe acknowledgement owner');
}

function readPeerFile(filename: string, acknowledgement: boolean): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 || (stat.mode & 0o022)
      || (acknowledgement && config.NODE_ENV !== 'test' && stat.uid !== 0)) throw new Error('Invalid peer file');
    return fs.readFileSync(fd, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function publishEnrollmentPeer(id: string, key: string, address: string): boolean {
  safeDirectory(config.ENROLLMENT_REQUEST_DIR, true);
  safeDirectory(config.ENROLLMENT_ACK_DIR, false);
  const content = `${key}\n${address}\n`;
  const target = path.join(config.ENROLLMENT_REQUEST_DIR, `${id}.peer`);
  const current = readPeerFile(target, false);
  if (current !== null && current !== content) throw new Error('Peer request conflicts');
  if (current === null) {
    const temporary = path.join(config.ENROLLMENT_REQUEST_DIR, `.${id}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, content); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, target);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* Already renamed or never created. */ }
    }
  }
  const error = readPeerFile(path.join(config.ENROLLMENT_ACK_DIR, `${id}.error`), true);
  if (error === 'PEER_CONFLICT\n') throw new EnrollmentError(409, 'ENROLLMENT_PEER_CONFLICT');
  if (error !== null) throw new EnrollmentError(503, 'ENROLLMENT_UNAVAILABLE');
  const ack = readPeerFile(path.join(config.ENROLLMENT_ACK_DIR, `${id}.ready`), true);
  return ack === content;
}

const sshChecks = new Map<string, { checkedAt: number; active?: Promise<boolean>; value: boolean }>();
async function verifySsh(record: Registration): Promise<boolean> {
  const key = `${record.node_id}:${record.host_key_fingerprint}:${record.ssh_username}`;
  const now = Date.now();
  const existing = sshChecks.get(key);
  if (existing?.active) return existing.active;
  if (existing && now - existing.checkedAt < 3000) return existing.value;
  if (sshChecks.size > 256) for (const [k, v] of sshChecks) if (!v.active && now - v.checkedAt > 30000) sshChecks.delete(k);
  if (sshChecks.size >= 512 && !existing) return false;
  const check = { checkedAt: now, value: false, active: undefined as Promise<boolean> | undefined };
  check.active = new Promise<boolean>((resolve) => {
    const connection = new SshClient();
    let finished = false;
    const done = (value: boolean) => {
      if (finished) return; finished = true; clearTimeout(timer);
      connection.end(); connection.destroy(); resolve(value);
    };
    const timer = setTimeout(() => done(false), 4000);
    connection.on('error', () => done(false));
    connection.on('close', () => done(false));
    // Authentication is portable across Linux and Windows default SSH shells.
    // Never execute installer-supplied commands or open a PTY during enrollment.
    connection.on('ready', () => done(true));
    try {
      validateBastionKey(config.BASTION_SSH_KEY_PATH);
      const fingerprint = Buffer.from(record.host_key_fingerprint.slice(7), 'base64').toString('hex');
      connection.connect({ host: record.node_ip, port: 22, username: record.ssh_username,
        privateKey: fs.readFileSync(config.BASTION_SSH_KEY_PATH), readyTimeout: 3000,
        hostHash: 'sha256', hostVerifier: (hash: string) => hash === fingerprint,
        algorithms: { serverHostKey: ['ssh-ed25519'] }, tryKeyboard: false });
    } catch { done(false); }
  });
  sshChecks.set(key, check);
  const value = await check.active;
  check.checkedAt = Date.now(); check.value = value; check.active = undefined;
  return value;
}

export async function claimEnrollment(raw: unknown, token: unknown) {
  if (!config.ENROLLMENT_ENABLED) throw new EnrollmentError(404, 'NOT_FOUND');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new EnrollmentError(401, 'ENROLLMENT_INVALID');
  const input = normalizeEnrollmentClaim(raw);
  input.invitation_id = input.invitation_id.toLowerCase();
  let metadata;
  try { metadata = enrollmentPublicConfig(config); }
  catch (error) {
    if (error instanceof EnrollmentError) throw error;
    throw new EnrollmentError(503, 'ENROLLMENT_UNAVAILABLE');
  }
  const hash = digest(JSON.stringify({ invitation_id: input.invitation_id,
    wireguard_public_key: input.wireguard_public_key, ssh_host_public_key: input.ssh_host_public_key,
    node_token_hash: digest(input.node_token) }));
  let record: Registration;
  try {
    const rows = await query<Registration>('SELECT * FROM public.claim_worker_enrollment($1,$2,$3,$4,$5,$6,$7,$8)',
      [input.invitation_id, digest(token), metadata.gateway_id, hash, digest(input.node_token),
        input.node_token.slice(0,8), input.host_key_fingerprint, input.wireguard_public_key]);
    record = rows.rows[0];
    if (!record) throw new Error('Registration missing');
  } catch (error) {
    const message = (error as Error).message;
    if (message === 'ENROLLMENT_INVALID') throw new EnrollmentError(401, message);
    if (message === 'ENROLLMENT_GONE') throw new EnrollmentError(410, message);
    if (message === 'ENROLLMENT_CONFLICT' || (error as { code?: string }).code === '23505') throw new EnrollmentError(409, 'ENROLLMENT_CONFLICT');
    if (message === 'ENROLLMENT_BAD_INPUT') throw new EnrollmentError(400, 'INVALID_ENROLLMENT_PAYLOAD');
    throw new EnrollmentError(503, 'ENROLLMENT_UNAVAILABLE');
  }
  let peerReady: boolean;
  try { peerReady = publishEnrollmentPeer(input.invitation_id, record.wireguard_public_key, record.node_ip); }
  catch (error) {
    if (error instanceof EnrollmentError) throw error;
    throw new EnrollmentError(503, 'ENROLLMENT_UNAVAILABLE');
  }
  const age = record.last_seen === null ? Number.POSITIVE_INFINITY : Date.now() - new Date(record.last_seen).getTime();
  const heartbeat = record.node_status === 'HEALTHY' && age >= -1000 && age < 15000;
  const ssh = peerReady && heartbeat ? await verifySsh(record) : false;
  return { version: 1, status: peerReady ? 'READY' : 'PENDING', ...metadata,
    invitation_id: input.invitation_id, node_id: record.node_id, node_name: record.node_name,
    node_ip: record.node_ip, node_type: record.node_type, worker_os: record.worker_os,
    ssh_username: record.ssh_username, peer_ready: peerReady,
    verification: { peer_applied: peerReady, heartbeat_recent: heartbeat, ssh_authenticated: ssh } };
}
