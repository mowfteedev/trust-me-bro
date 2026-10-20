/** Unit tests with a mocked database and Telegram transport; no external messages. */
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  query: vi.fn(), tx: vi.fn(), release: vi.fn(), sendAlert: vi.fn(),
  config: {
    NODE_STALE_THRESHOLD_SECONDS: 15, NODE_OFFLINE_THRESHOLD_SECONDS: 30,
    CPU_ALERT_THRESHOLD_PERCENT: 85, CPU_RECOVERY_THRESHOLD_PERCENT: 75, SWEEPER_INTERVAL_MS: 5000,
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

describe('cross-platform telemetry validation (mock DB)', () => {
  async function submit(body: unknown) {
    const app = Fastify();
    await app.register(telemetryRoutes, { prefix: '/api/telemetry' });
    try {
      return await app.inject({ method: 'POST', url: '/api/telemetry/beacon',
        headers: { 'x-node-token': 'unit-test-token' }, payload: body as any });
    } finally { await app.close(); }
  }
  it('accepts a Windows-shaped beacon without inventing Linux load average', async () => {
    expect((await submit(payload(12))).statusCode).toBe(200);
    expect(mock.tx.mock.calls.some(([sql]) => sql.includes('INSERT INTO metrics_history'))).toBe(true);
  });
  it('keeps support for complete legacy flat telemetry', async () => {
    const value = payload(12);
    expect((await submit({ node_id: value.node_id, timestamp: value.timestamp, ...value.metrics })).statusCode).toBe(200);
  });
  it.each(['timestamp', 'uptime', 'network', 'rx', 'memory', 'disk', 'load'])(
    'rejects missing or impossible %s measurements before persistence', async (field) => {
      const value: any = payload(12);
      if (field === 'timestamp') delete value.timestamp;
      if (field === 'uptime') delete value.metrics.uptime_seconds;
      if (field === 'network') delete value.metrics.network;
      if (field === 'rx') delete value.metrics.network.rx_bytes_total;
      if (field === 'memory') value.metrics.memory.used_bytes = 101;
      if (field === 'disk') value.metrics.disk.used_bytes = 101;
      if (field === 'load') value.metrics.cpu.load_avg = [-1, 0, 0];
      expect((await submit(value)).statusCode).toBe(400);
      expect(mock.tx).not.toHaveBeenCalled();
      expect(mock.sendAlert).not.toHaveBeenCalled();
    });
});

describe('CPU alert lifecycle (mock DB)', () => {
  it('keeps the incident across the hysteresis band and reopens only after recovery', async () => {
    let active = false;
    mock.tx.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT id FROM alerts')) return { rows: active ? [{ id: 'incident' }] : [], rowCount: active ? 1 : 0 };
      if (sql.includes('INSERT INTO alerts')) active = true;
      if (sql.includes('UPDATE alerts') && sql.includes("message LIKE 'CPU_HIGH:%'")) active = false;
      return { rows: [], rowCount: 1 };
    });
    for (const cpu of [85, 84.8, 85.1, 75]) {
      expect((await beacon(cpu)).statusCode).toBe(200);
      expect(active).toBe(true);
      expect(mock.sendAlert).toHaveBeenCalledTimes(1);
    }
    expect((await beacon(74.9)).statusCode).toBe(200);
    expect(active).toBe(false);
    expect((await beacon(84.9)).statusCode).toBe(200);
    expect(active).toBe(false);
    expect(mock.sendAlert).toHaveBeenCalledTimes(1);
    expect((await beacon(85)).statusCode).toBe(200);
    expect(active).toBe(true);
    expect(mock.sendAlert).toHaveBeenCalledTimes(2);
    expect(mock.tx.mock.calls.filter(([sql]) => sql.includes("'CPU_HIGH'"))).toHaveLength(2);
  });
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

describe('orphan SSH audit reconciliation (mock DB)', () => {
  const lease = { session_id: 'e44d9c38-9d6e-450f-b7d1-c253c5293c31',
    user_id: '956947db-c94f-453a-8798-908e6a197a3e', node_id: node.id,
    instance_id: 'isolated-test-gateway', status: 'CLOSED', close_reason: 'Client Closed',
    lease_expires_at: new Date('2026-10-16T00:00:00Z') };
  beforeEach(() => {
    mock.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM bastion_session_leases l') ? [lease] : [], rowCount: 1,
    }));
  });
  it('links the END IP to the original START for the same session and user, with no fabricated fallback', async () => {
    await runSweeperCycle();
    const insert = mock.query.mock.calls.find(([sql]) => sql.includes("SELECT $1, 'BASTION_SESSION_END'"));
    expect(insert).toBeDefined();
    const [sql, params] = insert!;
    expect(sql).toContain('SELECT start_log.ip_address FROM audit_logs start_log');
    expect(sql).toContain("start_log.action = 'BASTION_SESSION_START'");
    expect(sql).toContain("start_log.details->>'session_id' = $3");
    expect(sql).toContain('start_log.user_id = $1');
    expect(sql).toContain('ORDER BY start_log.created_at ASC, start_log.id ASC');
    expect(sql).toContain('LIMIT 1');
    expect(sql).not.toContain('127.0.0.1');
    expect(sql).not.toContain('COALESCE');
    expect(params[0]).toBe(lease.user_id);
    expect(params[2]).toBe(lease.session_id);
    expect(JSON.parse(params[1])).toMatchObject({ session_id: lease.session_id, reason: lease.close_reason });
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'RECONCILED'"),
      [lease.session_id, lease.close_reason]);
  });
  it('leaves the lease retryable when the reconciled END audit cannot be inserted', async () => {
    mock.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT $1, 'BASTION_SESSION_END'")) throw new Error('isolated-audit-write-failure');
      return { rows: sql.includes('FROM bastion_session_leases l') ? [lease] : [], rowCount: 1 };
    });
    await runSweeperCycle();
    expect(mock.query.mock.calls.some(([sql]) => sql.includes("SET status = 'RECONCILED'"))).toBe(false);
  });
});

describe('Telegram (mock fetch only)', () => {
  it('sends the Vietnamese alert text in a plain-text Telegram payload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T18:05:06Z'));
    mock.config.TELEGRAM_MODE = 'live';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200,
      json: async () => ({ ok: true, result: { message_id: 1 } }) });
    vi.stubGlobal('fetch', fetchMock);
    const service = new TelegramService();
    await service.pairWithOtp('test-chat', service.getPairOtp());
    expect(await service.sendAlert(node.name, 'WARNING', `CPU_HIGH: ${node.name} CPU 90% >= 85%.`)).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.chat_id).toBe('test-chat');
    expect(body.text).toContain('ZT-ServerOps | CPU cao');
    expect(body.text).toContain('CPU ghi nhận: 90%\nNgưỡng cảnh báo: ≥ 85%');
    expect(body.text).toContain('(UTC+7)');
    expect(body).not.toHaveProperty('parse_mode');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    service.stop();
  });
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
