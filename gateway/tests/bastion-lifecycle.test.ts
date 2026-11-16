/** Shared maintenance uses fake time and deferred PostgreSQL responses; no network. */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ query: vi.fn(), sshClients: [] as any[] }));
vi.mock('../src/config/env.js', () => ({ config: {
  NODE_ENV: 'test', JWT_SECRET: 'isolated-factory-test-secret-over-32-characters',
  BASTION_SSH_KEY_PATH: '/isolated-lifecycle/key', BASTION_DEFAULT_USER: 'worker-check',
  BASTION_CONNECT_TIMEOUT_MS: 1000,
} }));
vi.mock('../src/services/db.js', () => ({
  query: mock.query, checkDatabaseHealth: vi.fn(), closeDatabasePool: vi.fn(), ensureSeedData: vi.fn(),
}));
vi.mock('../src/services/telegram.js', () => ({ telegramService: {
  init: vi.fn(), sendAlert: vi.fn(), stop: vi.fn(),
} }));
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');
  class Client extends EventEmitter {
    connect = vi.fn(); end = vi.fn(); destroy = vi.fn();
    shell = vi.fn((_options, callback) => callback(null, Object.assign(new EventEmitter(), {
      write: vi.fn(() => true), end: vi.fn(), destroy: vi.fn(), setWindow: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    })));
    constructor() { super(); mock.sshClients.push(this); }
  }
  return { Client };
});

let tickets: typeof import('../src/services/bastion/tickets.js');
let registry: typeof import('../src/services/bastion/registry.js');
let session: typeof import('../src/services/bastion/session.js');
class TestSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.emit('close'); });
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.clearAllMocks();
  mock.sshClients.length = 0;
  vi.spyOn(process.hrtime, 'bigint').mockReturnValue(0n);
  mock.query.mockResolvedValue({ rows: [], rowCount: 1 });
  tickets = await import('../src/services/bastion/tickets.js');
  registry = await import('../src/services/bastion/registry.js');
  session = await import('../src/services/bastion/session.js');
});
afterEach(() => {
  tickets.stopTicketCleaner();
  registry.stopSessionMaintenance();
  registry.shutdownAllBastionSessions();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('imports without starting maintenance and starts/stops exactly three owned intervals', () => {
  expect(vi.getTimerCount()).toBe(0);
  tickets.startTicketCleaner();
  tickets.startTicketCleaner();
  registry.startSessionMaintenance();
  registry.startSessionMaintenance();
  expect(vi.getTimerCount()).toBe(3);
  tickets.stopTicketCleaner();
  tickets.stopTicketCleaner();
  registry.stopSessionMaintenance();
  registry.stopSessionMaintenance();
  expect(vi.getTimerCount()).toBe(0);
  tickets.startTicketCleaner();
  registry.startSessionMaintenance();
  expect(vi.getTimerCount()).toBe(3);
});

it('imports the compatible server entry point and builds apps without starting runtime work', async () => {
  const events = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;
  const counts = events.map((event) => process.listenerCount(event));
  const { buildServer } = await import('../src/server.js');
  const first = await buildServer();
  const second = await buildServer();
  try {
    expect(events.map((event) => process.listenerCount(event))).toEqual(counts);
    expect(vi.getTimerCount()).toBe(0);
    expect(mock.query).not.toHaveBeenCalled();
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

it('keeps a pending checker exclusive across stop/restart and ignores its stale result', async () => {
  let releaseAuth!: (value: unknown) => void;
  let releaseCheck!: (value: unknown) => void;
  const auth = new Promise((resolve) => { releaseAuth = resolve; });
  const check = new Promise((resolve) => { releaseCheck = resolve; });
  mock.query.mockImplementation((sql: string) => sql.includes('WHERE id = ANY') ? check
    : sql.includes('FROM users') ? auth : Promise.resolve({ rows: [], rowCount: 1 }));
  const socket = new TestSocket();
  const attaching = session.attachBastionSession(socket as unknown as WebSocket, 'worker-test',
    tickets.createBastionTicket('worker-test', 'test-admin', 1));
  registry.startSessionMaintenance();
  await vi.advanceTimersByTimeAsync(2000);
  registry.stopSessionMaintenance();
  registry.startSessionMaintenance();
  await vi.advanceTimersByTimeAsync(2000);
  expect(mock.query.mock.calls.filter(([sql]) => sql.includes('WHERE id = ANY'))).toHaveLength(1);
  releaseCheck({ rows: [], rowCount: 0 });
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.close).not.toHaveBeenCalled();
  expect(mock.query.mock.calls.filter(([sql]) => sql.includes('SET lease_expires_at'))).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(mock.query.mock.calls.filter(([sql]) => sql.includes('WHERE id = ANY'))).toHaveLength(2);
  expect(socket.close).toHaveBeenCalledWith(4403, 'Session Revoked');
  releaseAuth({ rows: [], rowCount: 0 });
  await attaching;
});

it('checks only the captured sessions when a new session arrives during a pending batch', async () => {
  let releaseAuth!: (value: unknown) => void;
  let releaseCheck!: (value: unknown) => void;
  const auth = new Promise((resolve) => { releaseAuth = resolve; });
  const check = new Promise((resolve) => { releaseCheck = resolve; });
  mock.query.mockImplementation((sql: string) => sql.includes('WHERE id = ANY') ? check
    : sql.includes('FROM users') ? auth : Promise.resolve({ rows: [], rowCount: 1 }));
  const first = new TestSocket();
  const firstAttaching = session.attachBastionSession(first as unknown as WebSocket, 'worker-test',
    tickets.createBastionTicket('worker-test', 'first-admin', 1));
  registry.startSessionMaintenance();
  await vi.advanceTimersByTimeAsync(2000);
  const second = new TestSocket();
  const secondAttaching = session.attachBastionSession(second as unknown as WebSocket, 'worker-test',
    tickets.createBastionTicket('worker-test', 'second-admin', 1));
  const revoked = new Promise<void>((resolve) => first.once('close', resolve));
  releaseCheck({ rows: [], rowCount: 0 });
  await revoked;
  expect(first.close).toHaveBeenCalledWith(4403, 'Session Revoked');
  expect(second.close).not.toHaveBeenCalled();
  releaseAuth({ rows: [], rowCount: 0 });
  await Promise.all([firstAttaching, secondAttaching]);
});

it('uses the monotonic watchdog even when wall time moves backwards and database checks hang', async () => {
  let releaseAuth!: (value: unknown) => void;
  let releaseCheck!: (value: unknown) => void;
  const auth = new Promise((resolve) => { releaseAuth = resolve; });
  const check = new Promise((resolve) => { releaseCheck = resolve; });
  mock.query.mockImplementation((sql: string) => sql.includes('WHERE id = ANY') ? check
    : sql.includes('FROM users') ? auth : Promise.resolve({ rows: [], rowCount: 1 }));
  const socket = new TestSocket();
  const attaching = session.attachBastionSession(socket as unknown as WebSocket, 'worker-test',
    tickets.createBastionTicket('worker-test', 'test-admin', 1));
  registry.startSessionMaintenance();
  await vi.advanceTimersByTimeAsync(2000);
  vi.setSystemTime(Date.now() - 3600000);
  vi.mocked(process.hrtime.bigint).mockReturnValue(4_800_000_000n);
  await vi.advanceTimersByTimeAsync(200);
  expect(socket.close).toHaveBeenCalledWith(4503, 'DB Deadline Exceeded');
  releaseCheck({ rows: [{ id: 'test-admin', is_active: true, role: 'ADMIN', session_version: 1 }], rowCount: 1 });
  releaseAuth({ rows: [], rowCount: 0 });
  await attaching;
  await Promise.resolve();
  expect(mock.query.mock.calls.filter(([sql]) => sql.includes('SET lease_expires_at'))).toHaveLength(0);
  expect(socket.close).toHaveBeenCalledTimes(1);
});

const account = { id: '956947db-c94f-453a-8798-908e6a197a3e', username: 'lifecycle-admin',
  is_active: true, role: 'ADMIN', session_version: 1 };
const firstJti = '56c6be7c-35c7-4753-a1b3-2327fe7df764';
const secondJti = 'a8205e21-431a-46b3-9741-bbe0481dfd23';
function authFixture() {
  const revoked = new Set<string>();
  const originalRead = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, options: any) =>
    String(file) === '/isolated-lifecycle/key' ? Buffer.from('lifecycle-test-key')
      : originalRead(file, options)) as typeof fs.readFileSync);
  mock.query.mockImplementation(async (sql: string, params: any[] = []) => {
    if (sql.includes('INSERT INTO revoked_auth_sessions')) revoked.add(params[0]);
    if (sql.includes('FROM users')) return { rows: [{ ...account, session_revoked: revoked.has(params[1]) }], rowCount: 1 };
    if (sql.includes('FROM revoked_auth_sessions')) {
      const ids: string[] = Array.isArray(params[0]) ? params[0] : [params[0]];
      return { rows: ids.filter(id => revoked.has(id)).map(jti => ({ jti })), rowCount: 1 };
    }
    if (sql.includes('FROM nodes')) return { rows: [{ id: 'node-fixture', name: 'worker-test',
      ip_address: '10.100.0.2', host_key_fingerprint: 'trusted-fixture-pin' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  return revoked;
}
async function readySession(authSessionId: string) {
  const socket = new TestSocket();
  const ticket = tickets.createBastionTicket('worker-test', account.id, 1, 30, Date.now() + 60000, authSessionId);
  await session.attachBastionSession(socket as unknown as WebSocket, 'worker-test', ticket);
  mock.sshClients.at(-1).emit('ready');
  expect(socket.send.mock.calls.map(([frame]) => JSON.parse(frame).type)).toContain('READY');
  return socket;
}

it('actual current-session logout closes only that JWT\'s READY Web SSH, keeping the other device open', async () => {
  vi.useRealTimers();
  const { buildServer } = await import('../src/app.js');
  const app = await buildServer();
  const revoked = authFixture();
  try {
    const first = await readySession(firstJti);
    const second = await readySession(secondJti);
    const token = app.jwt.sign({ ...account, jti: firstJti }, { expiresIn: '1m' });
    const result = await app.inject({ method: 'POST', url: '/api/auth/logout',
      headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(result.statusCode).toBe(200); expect(result.json().scope).toBe('current');
    expect(revoked.has(firstJti)).toBe(true);
    expect(first.close).toHaveBeenCalledExactlyOnceWith(4403, 'Session Revoked');
    expect(second.close).not.toHaveBeenCalled();
    expect(Array.from(registry.activeSessions.values()).map(value => value.authSessionId)).toEqual([secondJti]);
  } finally { await app.close(); }
});

it('rejects a ticket issued before its JWT logged out and burns it before any node lookup or SSH connection', async () => {
  vi.useRealTimers();
  const { buildServer } = await import('../src/app.js');
  const app = await buildServer();
  authFixture();
  try {
    const token = app.jwt.sign({ ...account, jti: firstJti }, { expiresIn: '1m' });
    const response = await app.inject({ method: 'POST', url: '/api/bastion/ticket',
      headers: { authorization: `Bearer ${token}` }, payload: { node_id: 'worker-test' } });
    expect(response.statusCode).toBe(200);
    const ticket = response.json().ticket;
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout',
      headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode).toBe(200);
    const socket = new TestSocket();
    await session.attachBastionSession(socket as unknown as WebSocket, 'worker-test', ticket);
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(4401, 'Session Revoked');
    expect(mock.query.mock.calls.some(([sql]) => sql.includes('FROM nodes'))).toBe(false);
    expect(mock.sshClients).toHaveLength(0);
    expect(tickets.verifyAndConsumeTicket(ticket, 'worker-test').valid).toBe(false);
  } finally { await app.close(); }
});

it('the periodic checker applies persistent JWT revocations to only the matching READY device', async () => {
  const revoked = authFixture();
  const first = await readySession(firstJti);
  const second = await readySession(secondJti);
  revoked.add(firstJti);
  registry.startSessionMaintenance();
  await vi.advanceTimersByTimeAsync(2000);
  expect(first.close).toHaveBeenCalledExactlyOnceWith(4403, 'Session Revoked');
  expect(second.close).not.toHaveBeenCalled();
  expect(mock.query.mock.calls.some(([sql, params]) => sql.includes('jti = ANY')
    && params[0].includes(firstJti) && params[0].includes(secondJti))).toBe(true);
});

it('fails closed before SSH when persistent ticket revocation lookup is unavailable', async () => {
  authFixture();
  const previous = mock.query.getMockImplementation()!;
  mock.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM revoked_auth_sessions')) throw new Error('isolated unavailable revocation store');
    return previous(sql, params);
  });
  const socket = new TestSocket();
  await session.attachBastionSession(socket as unknown as WebSocket, 'worker-test',
    tickets.createBastionTicket('worker-test', account.id, 1, 30, Date.now() + 60000, firstJti));
  expect(socket.close).toHaveBeenCalledExactlyOnceWith(4503, 'Database Unavailable');
  expect(mock.sshClients).toHaveLength(0);
  expect(registry.activeSessions.size).toBe(0);
});
