/** Unit tests with a mocked database and Telegram transport; no external messages. */
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  query: vi.fn(), tx: vi.fn(), release: vi.fn(), sendAlert: vi.fn(),
  config: {
    NODE_STALE_THRESHOLD_SECONDS: 15, NODE_OFFLINE_THRESHOLD_SECONDS: 30,
    CPU_ALERT_THRESHOLD_PERCENT: 85, SWEEPER_INTERVAL_MS: 5000,
    TELEGRAM_MODE: 'dry-run', TELEGRAM_BOT_TOKEN: 'fake-test-token',
    TELEGRAM_PAIR_OTP: '123456', TELEGRAM_REQUEST_TIMEOUT_MS: 1000,
  },
}));
vi.mock('../src/config/env.js', () => ({ config: mock.config }));
vi.mock('../src/services/db.js', () => ({
  query: mock.query,
  getClient: async () => ({ query: mock.tx, release: mock.release }),
}));
vi.mock('../src/middlewares/auth.middleware.js', () => ({ authenticate: async () => {} }));
// Keep real TelegramService available for transport tests, replace its singleton for routes.
vi.mock('../src/services/telegram.js', async (original) => ({
  ...await original<typeof import('../src/services/telegram.js')>(),
  telegramService: { sendAlert: mock.sendAlert },
}));

import { hashToken } from '../src/utils/crypto.js';
import { telemetryRoutes } from '../src/routes/telemetry.js';
import { runSweeperCycle } from '../src/services/sweeper.js';
import { TelegramService } from '../src/services/telegram.js';

const node = { id: '98a10aee-6336-4bb0-9f90-1083e2ec3064', name: 'worker-test',
  token_hash: hashToken('unit-test-token'), status: 'HEALTHY', ip_address: '10.100.0.2',
  last_seen: new Date('2026-10-16T00:00:00Z') };
const payload = (cpu: number) => ({
  node_id: node.name, timestamp: Date.now(),
  metrics: { cpu: { percent: cpu }, memory: { total_bytes: 100, used_bytes: 40, percent: 40 },
    disk: { total_bytes: 100, used_bytes: 30, percent: 30 },
    network: { rx_bytes_total: 100, tx_bytes_total: 200 }, uptime_seconds: 60 },
});

beforeEach(() => {
  vi.clearAllMocks();
  mock.config.TELEGRAM_MODE = 'dry-run';
  mock.query.mockResolvedValue({ rows: [node], rowCount: 1 });
  mock.tx.mockResolvedValue({ rows: [], rowCount: 1 });
  mock.sendAlert.mockResolvedValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function beacon(cpu: number) {
  const app = Fastify();
  await app.register(telemetryRoutes, { prefix: '/api/telemetry' });
  const result = await app.inject({ method: 'POST', url: '/api/telemetry/beacon',
    headers: { 'x-node-token': 'unit-test-token' }, payload: payload(cpu) });
  await app.close();
  return result;
}

describe('CPU alert lifecycle (mock DB)', () => {
  it('records a CPU threshold alert and audit, then sends only after commit', async () => {
    mock.sendAlert.mockImplementation(async () => {
      expect(mock.tx.mock.calls.at(-1)?.[0]).toBe('COMMIT');
      return true;
    });
    expect((await beacon(90)).statusCode).toBe(200);
    expect(mock.tx.mock.calls.some(([sql]) => sql.includes("'CPU_HIGH'"))).toBe(true);
    expect(mock.sendAlert).toHaveBeenCalledWith(node.name, 'WARNING', expect.stringContaining('CPU_HIGH:'));
  });
  it('does not repeat a CPU alert while that incident is unresolved', async () => {
    mock.tx.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith('SELECT id FROM alerts') ? [{ id: 'existing-incident' }] : [], rowCount: 1,
    }));
    expect((await beacon(99)).statusCode).toBe(200);
    expect(mock.sendAlert).not.toHaveBeenCalled();
  });
  it('resolves CPU and offline incidents on a low fresh beacon', async () => {
    expect((await beacon(20)).statusCode).toBe(200);
    const sql = mock.tx.mock.calls.map(([query]) => query).join('\n');
    expect(sql).toContain("message LIKE 'CPU_HIGH:%'");
    expect(sql).toContain("message LIKE 'NODE_OFFLINE:%'");
    expect(sql).toContain("SET status = 'HEALTHY'");
    expect(mock.sendAlert).not.toHaveBeenCalled();
  });
  it('rolls back CPU persistence failure and does not notify', async () => {
    mock.tx.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO alerts')) throw new Error('private-db-error');
      return { rows: [], rowCount: 1 };
    });
    const result = await beacon(95);
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('private-db-error');
    expect(mock.tx).toHaveBeenCalledWith('ROLLBACK');
    expect(mock.sendAlert).not.toHaveBeenCalled();
  });
});

describe('Liveness (mock DB)', () => {
  beforeEach(() => {
    mock.query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith('SELECT id, name, ip_address, last_seen') ? [node] : [], rowCount: 1,
    }));
  });
  it('marks stale at 15s, records offline event atomically and notifies once', async () => {
    const result = await runSweeperCycle();
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'WARNING'"), [15, 30]);
    expect(result.offlineNodesDetected).toEqual([node.name]);
    expect(mock.tx.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN', expect.stringContaining("SET status = 'OFFLINE'"),
      expect.stringContaining('INSERT INTO alerts'), expect.stringContaining('INSERT INTO audit_logs'), 'COMMIT',
    ]);
    expect(mock.sendAlert).toHaveBeenCalledTimes(1);
  });
  it('does not alert or count a node which recovered between select and update', async () => {
    mock.tx.mockResolvedValue({ rows: [], rowCount: 0 });
    expect((await runSweeperCycle()).offlineNodesDetected).toEqual([]);
    expect(mock.sendAlert).not.toHaveBeenCalled();
    expect(mock.tx.mock.calls.some(([sql]) => sql.includes('INSERT INTO alerts'))).toBe(false);
  });
  it('rolls back offline status if audit persistence fails, leaving it retryable', async () => {
    mock.tx.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO audit_logs')) throw new Error('audit failed');
      return { rows: [], rowCount: 1 };
    });
    expect((await runSweeperCycle()).offlineNodesDetected).toEqual([]);
    expect(mock.tx).toHaveBeenCalledWith('ROLLBACK');
    expect(mock.sendAlert).not.toHaveBeenCalled();
  });
});

describe('Telegram (mock fetch only)', () => {
  it('dry-run reports simulation without any fetch even with a token', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const service = new TelegramService();
    await service.init();
    expect(await service.sendAlert('test', 'WARNING', 'simulation')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    service.stop();
  });
  it('disabled mode performs no fetch and reports not sent', async () => {
    mock.config.TELEGRAM_MODE = 'disabled';
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const service = new TelegramService();
    expect(await service.sendAlert('test', 'WARNING', 'simulation')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    service.stop();
  });
  it('live transport retries a transient failure, bounds timeout and uses plain text', async () => {
    vi.useFakeTimers();
    mock.config.TELEGRAM_MODE = 'live';
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    const service = new TelegramService();
    expect(await service.pairWithOtp('test-chat', service.getPairOtp())).toBe(true);
    const sending = service.sendAlert('untrusted*name', 'CRITICAL', 'mock');
    await vi.runAllTimersAsync();
    expect(await sending).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('parse_mode');
    service.stop();
  });
  it('checks Telegram payload.ok and stops after three unsuccessful attempts', async () => {
    vi.useFakeTimers();
    mock.config.TELEGRAM_MODE = 'live';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false }) });
    vi.stubGlobal('fetch', fetchMock);
    const service = new TelegramService();
    await service.pairWithOtp('test-chat', service.getPairOtp());
    const sending = service.sendAlert('test', 'WARNING', 'mock');
    await vi.runAllTimersAsync();
    expect(await sending).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    service.stop();
  });
});
