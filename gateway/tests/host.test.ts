import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ query: vi.fn(), open: vi.fn(), role: 'ADMIN' }));
vi.mock('../src/services/db.js', () => ({ query: mock.query }));
vi.mock('node:fs/promises', () => ({ default: { open: mock.open } }));
import { hostRoutes } from '../src/routes/host.js';

const fixture = (at = new Date().toISOString()) => ({
  sampled_at: at, secret: 'never-return-fixture-secret',
  host: { hostname: 'ec2-fixture', cpu_percent: null,
    memory_used_bytes: 100, memory_total_bytes: 500, disk_used_bytes: 200, disk_total_bytes: 1000,
    uptime_seconds: 1000, network_rx_bytes: 123, network_tx_bytes: 456, network_interface: 'ens5',
    password: 'never-return-fixture-secret' },
  services: ['gateway', 'proxy', 'postgres', 'wireguard_gateway'].map(id => ({
    id, name: 'untrusted name', state: 'healthy', started_at: at, restarts: 0,
    observations: [{ at, state: 'healthy', token: 'never-return-fixture-secret' }],
    env: 'never-return-fixture-secret',
  })),
});
let app: ReturnType<typeof Fastify>;
let close: ReturnType<typeof vi.fn>;
function file(data: unknown, size?: number) {
  const raw = Buffer.from(JSON.stringify(data));
  mock.open.mockResolvedValue({
    stat: async () => ({ isFile: () => true, size: size ?? raw.length }),
    read: async (buffer: Buffer) => { raw.copy(buffer); return { bytesRead: raw.length }; },
    close,
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  mock.role = 'ADMIN'; close = vi.fn();
  mock.query.mockImplementation(async () => ({ rows: [{ id: 'fixture-user', username: 'fixture',
    role: mock.role, is_active: true, session_version: 1 }] }));
  app = Fastify();
  await app.register(jwt, { secret: 'isolated-host-test-secret-over-32-characters' });
  await app.register(hostRoutes, { prefix: '/api' });
  await app.ready();
  file(fixture());
});
afterEach(async () => { await app.close(); });
const request = () => app.inject({ url: '/api/host?path=/etc/passwd', headers: {
  authorization: 'Bearer ' + app.jwt.sign({ id: 'fixture-user', username: 'fixture', role: mock.role, session_version: 1 }, { expiresIn: '1h' }),
} });

describe('read-only host observations', () => {
  it('requires authentication before touching the host file', async () => {
    expect((await app.inject('/api/host')).statusCode).toBe(401);
    expect(mock.open).not.toHaveBeenCalled();
  });
  it.each(['ADMIN', 'VIEWER'])('allows %s and strips non-contract private fields', async role => {
    mock.role = role;
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().host.hostname).toBe('ec2-fixture');
    expect(response.json().host.cpu_percent).toBeNull();
    expect(response.json().services[1].name).toBe('Caddy');
    expect(response.body).not.toContain('never-return-fixture-secret');
    expect(mock.open.mock.calls[0][0]).toBe('/run/zt-host-monitor/host.json');
    expect(close).toHaveBeenCalledOnce();
  });
  it('labels old observations stale instead of healthy current data', async () => {
    file(fixture(new Date(Date.now() - 20000).toISOString()));
    expect((await request()).json().stale).toBe(true);
  });
  it('handles absent or oversized files without returning filesystem details', async () => {
    mock.open.mockRejectedValueOnce(new Error('private host path and fixture secret'));
    const missing = await request();
    expect(missing.statusCode).toBe(503);
    expect(missing.body).not.toContain('private');
    file(fixture(), 300000);
    expect((await request()).statusCode).toBe(503);
    expect(close).toHaveBeenCalledOnce();
  });
  it('rejects malformed snapshots and duplicate or extra service identities', async () => {
    const bad = fixture(); bad.services[1].id = 'gateway'; file(bad);
    expect((await request()).statusCode).toBe(503);
    const wrong = fixture(); wrong.host.memory_used_bytes = 999999; file(wrong);
    expect((await request()).statusCode).toBe(503);
    file(fixture(new Date(Date.now() + 60000).toISOString()));
    expect((await request()).statusCode).toBe(503);
  });
});
