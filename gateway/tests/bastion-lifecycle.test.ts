/** Shared maintenance uses fake time and deferred PostgreSQL responses; no network. */
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/config/env.js', () => ({ config: {
  NODE_ENV: 'test', JWT_SECRET: 'isolated-factory-test-secret-over-32-characters',
} }));
vi.mock('../src/services/db.js', () => ({
  query: mock.query, checkDatabaseHealth: vi.fn(), closeDatabasePool: vi.fn(), ensureSeedData: vi.fn(),
}));
vi.mock('../src/services/telegram.js', () => ({ telegramService: {
  init: vi.fn(), sendAlert: vi.fn(), stop: vi.fn(),
} }));

let bastion: typeof import('../src/services/bastion.js');
class TestSocket extends EventEmitter {
  readyState = 1;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.emit('close'); });
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(process.hrtime, 'bigint').mockReturnValue(0n);
  mock.query.mockResolvedValue({ rows: [], rowCount: 1 });
  bastion = await import('../src/services/bastion.js');
});
afterEach(() => {
  bastion.stopTicketCleaner();
  bastion.stopSessionMaintenance();
  bastion.shutdownAllBastionSessions();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('imports without starting maintenance and starts/stops exactly three owned intervals', () => {
  expect(vi.getTimerCount()).toBe(0);
  bastion.startTicketCleaner();
  bastion.startTicketCleaner();
  bastion.startSessionMaintenance();
  bastion.startSessionMaintenance();
  expect(vi.getTimerCount()).toBe(3);
  bastion.stopTicketCleaner();
  bastion.stopTicketCleaner();
  bastion.stopSessionMaintenance();
  bastion.stopSessionMaintenance();
  expect(vi.getTimerCount()).toBe(0);
  bastion.startTicketCleaner();
  bastion.startSessionMaintenance();
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
  const attaching = bastion.attachBastionSession(socket as unknown as WebSocket, 'worker-test',
    bastion.createBastionTicket('worker-test', 'test-admin', 1));
  bastion.startSessionMaintenance();
  await vi.advanceTimersByTimeAsync(2000);
  bastion.stopSessionMaintenance();
  bastion.startSessionMaintenance();
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
  const firstAttaching = bastion.attachBastionSession(first as unknown as WebSocket, 'worker-test',
    bastion.createBastionTicket('worker-test', 'first-admin', 1));
  bastion.startSessionMaintenance();
  await vi.advanceTimersByTimeAsync(2000);
  const second = new TestSocket();
  const secondAttaching = bastion.attachBastionSession(second as unknown as WebSocket, 'worker-test',
    bastion.createBastionTicket('worker-test', 'second-admin', 1));
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
  const attaching = bastion.attachBastionSession(socket as unknown as WebSocket, 'worker-test',
    bastion.createBastionTicket('worker-test', 'test-admin', 1));
  bastion.startSessionMaintenance();
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
