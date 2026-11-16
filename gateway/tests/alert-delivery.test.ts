/** Queue state machine with fake DB/transport; never calls Telegram. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ query: vi.fn(), transport: vi.fn() }));
vi.mock('../src/services/db.js', () => ({ query: mock.query }));
vi.mock('../src/services/telegram.js', () => ({ telegramService: { deliverQueued: mock.transport } }));
vi.mock('../src/config/env.js', () => ({ config: { TELEGRAM_REQUEST_TIMEOUT_MS: 1000 } }));
import { enqueueAlertNotification, runAlertDeliveryCycle, startAlertDelivery, stopAlertDelivery } from '../src/services/alert-delivery.js';
beforeEach(() => {
  vi.clearAllMocks();
  mock.query.mockResolvedValue({ rows: [] });
  mock.transport.mockResolvedValue({ status: 'SENT' });
});
afterEach(async () => { await stopAlertDelivery(); vi.useRealTimers(); });
function claim(attempts = 1) {
  let pending = true;
  mock.query.mockImplementation(async (sql: string) => {
    if (sql.includes('RETURNING n.id') && pending) {
      pending = false;
      return { rows: [{ id: 'notification-id', text: 'CPU alert fixture', attempts }] };
    }
    return { rows: [] };
  });
  // Reset stopping flag without waiting for timers, to model runtime startup.
  vi.useFakeTimers();
  startAlertDelivery();
}
describe('durable notification delivery', () => {
  it('stores one intent per incident phase through the supplied transaction', async () => {
    const tx = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await enqueueAlertNotification(tx as any, 'incident-id', 'RECOVERY', 'CPU normal fixture');
    expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (alert_id, phase) DO NOTHING'),
      ['incident-id', 'RECOVERY', 'CPU normal fixture']);
    expect(mock.query).not.toHaveBeenCalled();
  });
  it('records accepted delivery, with no sensitive payload in status update', async () => {
    claim(); await runAlertDeliveryCycle();
    expect(mock.transport).toHaveBeenCalledExactlyOnceWith('CPU alert fixture');
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1 AND status'),
      ['notification-id', 'SENT', null, 5, 1]);
  });
  it('keeps a transient error pending until the bounded third attempt', async () => {
    mock.transport.mockResolvedValue({ status: 'RETRY', error: 'TRANSPORT_ERROR' });
    claim(2); await runAlertDeliveryCycle();
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1 AND status'),
      ['notification-id', 'PENDING', 'TRANSPORT_ERROR', 10, 2]);
  });
  it('marks the third failed attempt final', async () => {
    mock.transport.mockResolvedValue({ status: 'RETRY', error: 'TRANSPORT_ERROR' });
    claim(3); await runAlertDeliveryCycle();
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1 AND status'),
      ['notification-id', 'FAILED', 'TRANSPORT_ERROR', 15, 3]);
  });
  it.each(['DRY_RUN', 'DISABLED', 'FAILED'])('records terminal status %s without claiming it was sent', async status => {
    mock.transport.mockResolvedValue({ status });
    claim(); await runAlertDeliveryCycle();
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1 AND status'),
      ['notification-id', status, null, 5, 1]);
  });
  it('serializes overlapping cycles so a slow transport is not sent twice', async () => {
    let release!: (result: unknown) => void;
    mock.transport.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    claim();
    const one = runAlertDeliveryCycle(), two = runAlertDeliveryCycle();
    await vi.waitFor(() => expect(mock.transport).toHaveBeenCalledTimes(1));
    release({ status: 'SENT' });
    await Promise.all([one, two]);
    expect(mock.transport).toHaveBeenCalledTimes(1);
  });
  it('allows remaining Gateway cleanup when the active DB cycle failed', async () => {
    mock.query.mockRejectedValue(new Error('private-db-failure'));
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startAlertDelivery();
    await expect(stopAlertDelivery()).resolves.toBeUndefined();
    expect(warning.mock.calls.flat().join(' ')).not.toContain('private-db-failure');
    warning.mockRestore();
  });
  it('includes crash recovery and an expiry guard in the persistent claim', async () => {
    claim(); await runAlertDeliveryCycle();
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining("last_error = 'ATTEMPT_INTERRUPTED'"));
    const sql = mock.query.mock.calls.find(([sql]) => sql.includes('RETURNING n.id'))?.[0];
    expect(sql).toContain("status IN ('PENDING', 'PROCESSING')");
    expect(sql).toContain('next_attempt_at <= now()');
    expect(sql).toContain('FOR UPDATE OF pending SKIP LOCKED');
    expect(sql).toContain("opening.status IN ('PENDING', 'PROCESSING')");
    expect(sql).toContain('attempts < 3');
  });
});
