/** Real validation/filesystem + mocked SQL/SSH transport; runtime SQL has a separate lab. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ query: vi.fn(), validateKey: vi.fn(), connections: [] as any[], ready: true,
  config: { NODE_ENV: 'test', ENROLLMENT_ENABLED: true, ENROLLMENT_GATEWAY_ID: '',
    ENROLLMENT_PUBLIC_URL: 'https://gateway.example.test', ENROLLMENT_ENDPOINT: '192.0.2.10:51820',
    ENROLLMENT_GATEWAY_PUBLIC_KEY: '', ENROLLMENT_BASTION_PUBLIC_KEY: '',
    ENROLLMENT_REQUEST_DIR: '', ENROLLMENT_ACK_DIR: '', BASTION_SSH_KEY_PATH: '' } }));
vi.mock('../src/services/db.js', () => ({ query: mock.query }));
vi.mock('../src/config/env.js', () => ({ config: mock.config }));
vi.mock('../src/services/bastion/key.js', () => ({ validateBastionKey: mock.validateKey }));
vi.mock('ssh2', () => ({ Client: class {
  handlers: Record<string, (...args: any[]) => void> = {};
  on(name: string, callback: (...args: any[]) => void) { this.handlers[name] = callback; return this; }
  connect(options: any) { mock.connections.push(options); queueMicrotask(() => this.handlers[mock.ready ? 'ready' : 'error']?.()); }
  end() {} destroy() {}
} }));

import { enrollmentRoutes } from '../src/routes/enrollment.js';
import { digest, enrollmentPublicConfig, normalizeEnrollmentClaim } from '../src/services/enrollment-contract.js';

let directory: string;
let app: FastifyInstance;
const id = 'bc1f2597-94c5-41bb-9079-9a2fbe01daff';
const token = '7'.repeat(64);
const publicKey = crypto.randomBytes(32).toString('base64');
const sshBlob = Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020','hex'),crypto.randomBytes(32)]).toString('base64');
const ssh = 'ssh-ed25519 ' + sshBlob;
const body = { invitation_id: id, wireguard_public_key: publicKey, ssh_host_public_key: ssh,
  node_token: '9'.repeat(64) };
const registration = () => ({ node_id: crypto.randomUUID(), node_name: 'worker-01', node_ip: '10.100.0.3',
  node_type: 'VM', worker_os: 'linux', ssh_username: 'ztuser', wireguard_public_key: publicKey,
  node_status: 'OFFLINE', last_seen: null as Date | null, host_key_fingerprint: normalizeEnrollmentClaim(body).host_key_fingerprint });
const request = (payload: unknown = body, code: string | undefined = token) => app.inject({ method: 'POST',
  url: '/api/enrollment/claim', headers: code ? { 'x-enrollment-token': code } : {}, payload });
const acknowledge = () => fs.writeFileSync(path.join(mock.config.ENROLLMENT_ACK_DIR, id + '.ready'), publicKey + '\n10.100.0.3\n', { mode: 0o644 });

beforeEach(async () => {
  vi.clearAllMocks(); mock.connections.length = 0; mock.ready = true;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-enrollment-unit-'));
  const requests = path.join(directory,'requests'), acks = path.join(directory,'acks');
  fs.mkdirSync(requests, { mode: 0o700 }); fs.mkdirSync(acks, { mode: 0o755 });
  mock.config.ENROLLMENT_ENABLED = true;
  mock.config.ENROLLMENT_GATEWAY_PUBLIC_KEY = crypto.randomBytes(32).toString('base64');
  mock.config.ENROLLMENT_BASTION_PUBLIC_KEY = ssh;
  mock.config.ENROLLMENT_GATEWAY_ID = '';
  mock.config.ENROLLMENT_REQUEST_DIR = requests; mock.config.ENROLLMENT_ACK_DIR = acks;
  mock.config.BASTION_SSH_KEY_PATH = path.join(directory,'bastion');
  fs.writeFileSync(mock.config.BASTION_SSH_KEY_PATH,'private-key-fixture',{mode:0o400});
  mock.query.mockResolvedValue({ rows: [registration()] });
  app = Fastify(); await app.register(enrollmentRoutes, { prefix: '/api/enrollment' });
});
afterEach(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('scoped enrollment API', () => {
  it('publishes only the configured public identity for HTTPS origin checks', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/enrollment/info' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ version: 1, ...enrollmentPublicConfig(mock.config) });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mock.query).not.toHaveBeenCalled();
    mock.config.ENROLLMENT_ENABLED = false;
    expect((await app.inject({ method: 'GET', url: '/api/enrollment/info' })).statusCode).toBe(404);
  });
  it('is closed by default configuration, before SQL or filesystem writes', async () => {
    mock.config.ENROLLMENT_ENABLED = false;
    expect((await request()).statusCode).toBe(404);
    expect(mock.query).not.toHaveBeenCalled();
    expect(fs.readdirSync(mock.config.ENROLLMENT_REQUEST_DIR)).toEqual([]);
  });
  it.each(['','short','secret with spaces'])('rejects invalid or absent join credentials', async credential => {
    expect((await request(body,credential)).statusCode).toBe(401); expect(mock.query).not.toHaveBeenCalled();
  });
  it.each([
    { ...body, invitation_id: '../escape' }, { ...body, node_token: 'short' },
    { ...body, wireguard_public_key: Buffer.alloc(32).toString('base64') },
    { ...body, ssh_host_public_key: '-----BEGIN OPENSSH PRIVATE KEY-----' },
    { ...body, ssh_host_public_key: ssh + '\nmalicious' },
    { ...body, node_ip: '192.0.2.1' }, { ...body, role: 'ADMIN' },
  ])('rejects malformed/private or assignment-changing input', async payload => {
    const response = await request(payload); expect(response.statusCode).toBe(400); expect(mock.query).not.toHaveBeenCalled();
  });
  it('publishes only public peer data, passes only token hashes to SQL, and returns202 before acknowledgement', async () => {
    const response = await request();
    expect(response.statusCode).toBe(202); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['retry-after']).toBe('3');
    expect(response.json()).toMatchObject({ status:'PENDING', node_name:'worker-01', peer_ready:false,
      verification:{peer_applied:false,heartbeat_recent:false,ssh_authenticated:false} });
    const params = mock.query.mock.calls[0][1];
    expect(params).toContain(digest(token)); expect(params).toContain(digest(body.node_token));
    expect(params).not.toContain(token); expect(params).not.toContain(body.node_token);
    const file = path.join(mock.config.ENROLLMENT_REQUEST_DIR,id+'.peer');
    expect(fs.readFileSync(file,'utf8')).toBe(publicKey+'\n10.100.0.3\n');
    expect(fs.statSync(file).mode&0o777).toBe(0o600);
    expect(JSON.stringify(response.json())).not.toContain(body.node_token);
    expect(mock.connections).toHaveLength(0);
  });
  it('requires an exact acknowledgement and preserves the request across retries', async () => {
    await request(); const file = path.join(mock.config.ENROLLMENT_REQUEST_DIR,id+'.peer');
    const before = fs.statSync(file).mtimeMs;
    fs.writeFileSync(path.join(mock.config.ENROLLMENT_ACK_DIR,id+'.ready'),publicKey+'\n10.100.0.4\n');
    expect((await request()).statusCode).toBe(202);
    acknowledge(); expect((await request()).statusCode).toBe(200);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });
  it.each([['PEER_CONFLICT\n',409],['PEER_APPLY_FAILED\n',503],['untrusted native detail',503]] as const)(
    'maps fixed helper error safely: %s', async(error,status) => {
      acknowledge(); fs.writeFileSync(path.join(mock.config.ENROLLMENT_ACK_DIR,id+'.error'),error);
      const r = await request(); expect(r.statusCode).toBe(status); expect(r.json().detail).not.toContain(error.trim());
    });
  it.each([['ENROLLMENT_INVALID',401],['ENROLLMENT_GONE',410],['ENROLLMENT_CONFLICT',409],['ENROLLMENT_BAD_INPUT',400],
    ['secret database connection error',503]] as const)('maps SQL outcome %s without echoing errors',async(message,status) => {
    mock.query.mockRejectedValue(new Error(message)); const r=await request();
    expect(r.statusCode).toBe(status); expect(r.body).not.toContain('secret database');
    expect(fs.readdirSync(mock.config.ENROLLMENT_REQUEST_DIR)).toHaveLength(0);
  });
  it('recovers a failed handoff without replacing a conflicting request',async()=>{
    fs.writeFileSync(path.join(mock.config.ENROLLMENT_REQUEST_DIR,id+'.peer'),'different\n');
    expect((await request()).statusCode).toBe(503);
    expect(fs.readFileSync(path.join(mock.config.ENROLLMENT_REQUEST_DIR,id+'.peer'),'utf8')).toBe('different\n');
    fs.unlinkSync(path.join(mock.config.ENROLLMENT_REQUEST_DIR,id+'.peer'));
    expect((await request()).statusCode).toBe(202);
  });
  it('rejects symlink requests/acknowledgements without reading or replacing targets',async()=>{
    const sensitive=path.join(directory,'sensitive');fs.writeFileSync(sensitive,'secret');
    fs.symlinkSync(sensitive,path.join(mock.config.ENROLLMENT_REQUEST_DIR,id+'.peer'));
    expect((await request()).statusCode).toBe(503);
    expect(fs.readFileSync(sensitive,'utf8')).toBe('secret');
    fs.unlinkSync(path.join(mock.config.ENROLLMENT_REQUEST_DIR,id+'.peer'));
    fs.symlinkSync(sensitive,path.join(mock.config.ENROLLMENT_ACK_DIR,id+'.ready'));
    expect((await request()).statusCode).toBe(503);
  });
  it('rejects writable public acknowledgement files',async()=>{
    acknowledge();fs.chmodSync(path.join(mock.config.ENROLLMENT_ACK_DIR,id+'.ready'),0o666);
    expect((await request()).statusCode).toBe(503);
  });
  it.each(['linux','windows'])('verifies SSH authentication with the pinned host and no shell command on %s',async worker_os=>{
    const row={...registration(),worker_os,node_status:'HEALTHY',last_seen:new Date()};
    mock.query.mockResolvedValue({rows:[row]});acknowledge();
    const r=await request();expect(r.statusCode).toBe(200);
    expect(r.json().verification).toEqual({peer_applied:true,heartbeat_recent:true,ssh_authenticated:true});
    expect(mock.connections).toHaveLength(1);
    const options=mock.connections[0];expect(options.host).toBe('10.100.0.3');expect(options.username).toBe('ztuser');
    expect(options.hostVerifier(Buffer.from(row.host_key_fingerprint.slice(7),'base64').toString('hex'))).toBe(true);
    expect(options.hostVerifier('0'.repeat(64))).toBe(false);
    expect(options.algorithms.serverHostKey).toEqual(['ssh-ed25519']);
  });
  it('does not claim SSH proof for stale or failed authentication',async()=>{
    acknowledge();const row={...registration(),node_status:'HEALTHY',last_seen:new Date(Date.now()-20000)};
    mock.query.mockResolvedValue({rows:[row]});expect((await request()).json().verification.ssh_authenticated).toBe(false);
    expect(mock.connections).toHaveLength(0);
    row.last_seen=new Date();mock.ready=false;
    expect((await request()).json().verification.ssh_authenticated).toBe(false);
  });
  it('validates public Gateway identity and rejects credential-bearing or insecure registration URLs',()=>{
    const c=enrollmentPublicConfig(mock.config);expect(c.gateway_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    for(const url of ['http://gateway.test','https://user:password@gateway.test','https://gateway.test/path','https://gateway.test/?secret=x']){
      expect(()=>enrollmentPublicConfig({...mock.config,ENROLLMENT_PUBLIC_URL:url})).toThrow();
    }
    expect(()=>enrollmentPublicConfig({...mock.config,ENROLLMENT_GATEWAY_ID:'sha256:'+'f'.repeat(64)})).toThrow();
  });
});
