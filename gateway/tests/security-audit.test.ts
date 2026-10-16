/** Real Fastify/JWT/rate-limit and ticket logic; PostgreSQL and SSH filesystem mocked. */
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  query: vi.fn(),
  config: {
    NODE_ENV: 'test', JWT_SECRET: 'isolated-security-test-secret-over-32-characters',
    JWT_EXPIRES_IN: '1d', TRUSTED_PROXY_IP: '172.30.88.2' as string | undefined,
    BASTION_SSH_KEY_PATH: '/isolated-test/missing-private-key',
    NODE_STALE_THRESHOLD_SECONDS: 15, NODE_OFFLINE_THRESHOLD_SECONDS: 30,
    SWEEPER_INTERVAL_MS: 5000, CPU_ALERT_THRESHOLD_PERCENT: 85,
  },
}));
vi.mock('../src/config/env.js', () => ({ config: mock.config }));
vi.mock('../src/services/db.js', () => ({
  query: mock.query, getClient: vi.fn(), checkDatabaseHealth: vi.fn(),
  closeDatabasePool: vi.fn(), ensureSeedData: vi.fn(),
}));
vi.mock('../src/services/telegram.js', () => ({
  telegramService: { sendAlert: vi.fn(), init: vi.fn(), stop: vi.fn() },
}));

import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/utils/crypto.js';
import { attachBastionSession, createBastionTicket, verifyAndConsumeTicket,
  shutdownAllBastionSessions } from '../src/services/bastion.js';

const user = { id: '956947db-c94f-453a-8798-908e6a197a3e', username: 'test-admin',
  role: 'ADMIN', is_active: true, session_version: 1, password_hash: hashPassword('test-only-password') };
let lookupUser: typeof user | null;
let app: FastifyInstance;
const failureQueries = () => mock.query.mock.calls.filter(([sql]) => sql.includes("'LOGIN_FAILED'"));

beforeEach(async () => {
  vi.clearAllMocks();
  lookupUser = { ...user };
  mock.config.TRUSTED_PROXY_IP = '172.30.88.2';
  mock.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('FROM users') ? lookupUser ? [lookupUser] : [] : [], rowCount: 1,
  }));
  app = await buildServer();
});
afterEach(async () => {
  shutdownAllBastionSessions();
  await app.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const login = (remoteAddress = '10.100.0.2', forwardedIp?: string, username = user.username,
  password = 'wrong-test-password') => app.inject({ method: 'POST', url: '/api/auth/login',
  remoteAddress, headers: forwardedIp ? { 'x-forwarded-for': forwardedIp } : {},
  payload: { username, password } });

describe('bounded failed-login audit and trusted proxy', () => {
  it('returns the same generic 401 for missing users and bad passwords without serializing secrets', async () => {
    const wrongPassword = await login();
    lookupUser = null;
    const unknownUser = await login('10.100.0.2', undefined, 'does-not-exist');
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(unknownUser.json()).toEqual(wrongPassword.json());
    const calls = failureQueries();
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual([user.id,
      JSON.stringify({ attempted_username: user.username, reason: 'invalid_credentials' }), '10.100.0.2']);
    expect(calls[1][1][0]).toBeNull();
    expect(JSON.stringify(calls)).not.toContain('wrong-test-password');
    expect(JSON.stringify(calls)).not.toContain('password_hash');
    expect(unknownUser.json()).not.toHaveProperty('token');
  });

  it('keeps the disabled-account response and audits it only after verifying the password', async () => {
    lookupUser!.is_active = false;
    expect((await login()).statusCode).toBe(401);
    expect(JSON.parse(failureQueries()[0][1][1]).reason).toBe('invalid_credentials');
    expect((await login('10.100.0.2', undefined, user.username, 'test-only-password')).statusCode).toBe(403);
    expect(JSON.parse(failureQueries()[1][1][1]).reason).toBe('account_disabled');
  });

  it('rejects malformed credentials before audit and strips control characters from the attempted username', async () => {
    lookupUser = null;
    expect((await login('10.100.0.2', undefined, 'x'.repeat(51))).statusCode).toBe(400);
    expect(failureQueries()).toHaveLength(0);
    expect((await login('10.100.0.2', undefined, 'bad\n\t\u0000name')).statusCode).toBe(401);
    expect(JSON.parse(failureQueries()[0][1][1]).attempted_username).toBe('badname');
  });

  it('never grants a login or leaks the database failure when failed-audit persistence fails', async () => {
    mock.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO audit_logs')) throw new Error('private-database-detail');
      return { rows: [] };
    });
    const result = await login();
    expect(result.statusCode).toBe(401);
    expect(result.body).not.toContain('private-database-detail');
    expect(result.json()).not.toHaveProperty('token');
  });

  it('ignores forged forwarded headers from direct VPN/transport connections', async () => {
    expect((await login('::ffff:10.100.0.2', '203.0.113.99')).statusCode).toBe(401);
    expect(failureQueries()[0][1][2]).toBe('10.100.0.2');
  });

  it('trusts only the configured Caddy IP, including mapped IPv4, and stops at the nearest untrusted hop', async () => {
    expect((await login('::ffff:172.30.88.2', '192.0.2.99, 203.0.113.5')).statusCode).toBe(401);
    expect(failureQueries()[0][1][2]).toBe('203.0.113.5');
    expect((await login('172.30.88.3', '192.0.2.99')).statusCode).toBe(401);
    expect(failureQueries()[1][1][2]).toBe('172.30.88.3');
  });

  it('uses only the socket address when no trusted proxy is configured', async () => {
    await app.close();
    mock.config.TRUSTED_PROXY_IP = undefined;
    app = await buildServer();
    expect((await login('172.30.88.2', '192.0.2.99')).statusCode).toBe(401);
    expect(failureQueries()[0][1][2]).toBe('172.30.88.2');
  });

  it('caps login at ten requests per IP/minute before password lookup or audit, despite forged XFF', async () => {
    lookupUser = null;
    for (let i = 0; i < 10; i++) {
      expect((await login('10.100.0.2', `192.0.2.${i + 1}`)).statusCode).toBe(401);
    }
    const callsBefore = mock.query.mock.calls.length;
    expect((await login('10.100.0.2', '198.51.100.9')).statusCode).toBe(429);
    expect(failureQueries()).toHaveLength(10);
    expect(mock.query).toHaveBeenCalledTimes(callsBefore);
    expect((await login('10.100.0.3', '198.51.100.9')).statusCode).toBe(401);
  });

  it('checks the current database role before issuing SSH tickets, ignoring an Admin JWT claim', async () => {
    lookupUser!.role = 'VIEWER';
    const token = app.jwt.sign({ id: user.id, username: user.username, role: 'ADMIN', session_version: 1 });
    const result = await app.inject({ method: 'POST', url: '/api/bastion/ticket',
      headers: { authorization: `Bearer ${token}` }, payload: { node_id: 'worker-test' } });
    expect(result.statusCode).toBe(403);
    expect(mock.query.mock.calls.some(([sql]) => sql.includes("'BASTION_TICKET_ISSUED'"))).toBe(false);
  });
});

describe('one-time SSH ticket negative paths', () => {
  it('consumes a valid ticket once and rejects replay', () => {
    const ticket = createBastionTicket('worker-test', user.id, 1);
    expect(verifyAndConsumeTicket(ticket, 'worker-test').valid).toBe(true);
    expect(verifyAndConsumeTicket(ticket, 'worker-test').valid).toBe(false);
  });

  it('rejects a ticket for the wrong node and burns it rather than permitting another attempt', () => {
    const ticket = createBastionTicket('worker-test', user.id, 1);
    expect(verifyAndConsumeTicket(ticket, 'other-worker').valid).toBe(false);
    expect(verifyAndConsumeTicket(ticket, 'worker-test').valid).toBe(false);
  });

  it('rejects a ticket exactly at its deadline and when its JWT has already expired', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
    const ticket = createBastionTicket('worker-test', user.id, 1, 30);
    vi.setSystemTime(new Date('2026-10-16T00:00:30Z'));
    expect(verifyAndConsumeTicket(ticket, 'worker-test').valid).toBe(false);
    const expiredAuth = createBastionTicket('worker-test', user.id, 1, 30, Date.now());
    expect(verifyAndConsumeTicket(expiredAuth, 'worker-test').valid).toBe(false);
  });
});

class TestSocket extends EventEmitter {
  readyState = 1;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.emit('close'); });
}

describe('SSH request IP remains consistent through audit lifecycle (mock connection)', () => {
  const node = { id: 'ae34a547-cfea-4aa0-b171-538038091182', name: 'worker-test',
    ip_address: '10.100.0.2', host_key_fingerprint: 'test-fingerprint' };
  const auditQueries = () => mock.query.mock.calls.filter(([sql]) => sql.includes("'BASTION_SESSION_"));

  beforeEach(() => {
    // Stop after audit, before any network connection; this is not a real SSH test.
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('isolated-test-key-missing'); });
    mock.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM users') ? [user] : sql.includes('FROM nodes') ? [node] : [], rowCount: 1,
    }));
  });

  it('writes the actual request IP for START and ordinary END with the same session id', async () => {
    const socket = new TestSocket();
    await attachBastionSession(socket as unknown as WebSocket, node.id,
      createBastionTicket(node.id, user.id, 1), '::ffff:198.51.100.7');
    const audit = auditQueries();
    expect(audit).toHaveLength(2);
    expect(audit.every(([, params]) => params[2] === '198.51.100.7')).toBe(true);
    expect(JSON.parse(audit[0][1][1]).session_id).toBe(JSON.parse(audit[1][1][1]).session_id);
  });

  it('preserves the IP when the browser disconnects while START is still pending', async () => {
    let resolveStart!: (value: unknown) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const deferredStart = new Promise((resolve) => { resolveStart = resolve; });
    mock.query.mockImplementation(async (sql: string) => {
      if (sql.includes("'BASTION_SESSION_START'")) { signalStarted(); return deferredStart; }
      return { rows: sql.includes('FROM users') ? [user] : sql.includes('FROM nodes') ? [node] : [], rowCount: 1 };
    });
    const socket = new TestSocket();
    const attaching = attachBastionSession(socket as unknown as WebSocket, node.id,
      createBastionTicket(node.id, user.id, 1), '2001:db8::7');
    await started;
    socket.close();
    resolveStart({ rows: [], rowCount: 1 });
    await attaching;
    const audit = auditQueries();
    expect(audit).toHaveLength(2);
    expect(audit.every(([, params]) => params[2] === '2001:db8::7')).toBe(true);
    expect(JSON.parse(audit[1][1][1]).reason).toBe('Client Closed');
    expect(JSON.parse(audit[0][1][1]).session_id).toBe(JSON.parse(audit[1][1][1]).session_id);
  });
});
