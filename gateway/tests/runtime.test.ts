/** Runtime ownership with mocked startup services; no database, listener or Telegram connection. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  buildServer: vi.fn(), listen: vi.fn(), close: vi.fn(), ensureSeedData: vi.fn(), closeDatabasePool: vi.fn(),
  startTicketCleaner: vi.fn(), stopTicketCleaner: vi.fn(), startSessionMaintenance: vi.fn(),
  stopSessionMaintenance: vi.fn(), shutdownAllBastionSessions: vi.fn(),
  startSweeper: vi.fn(), stopSweeper: vi.fn(), initTelegram: vi.fn(), stopTelegram: vi.fn(),
}));
vi.mock('../src/app.js', () => ({ buildServer: mock.buildServer }));
vi.mock('../src/config/env.js', () => ({ config: {
  GATEWAY_PORT: 3000, GATEWAY_HOST: '127.0.0.1', TRUSTED_PROXY_IP: undefined,
} }));
vi.mock('../src/services/db.js', () => ({ ensureSeedData: mock.ensureSeedData, closeDatabasePool: mock.closeDatabasePool }));
vi.mock('../src/services/bastion/tickets.js', () => ({
  startTicketCleaner: mock.startTicketCleaner, stopTicketCleaner: mock.stopTicketCleaner,
}));
vi.mock('../src/services/bastion/registry.js', () => ({
  startSessionMaintenance: mock.startSessionMaintenance, stopSessionMaintenance: mock.stopSessionMaintenance,
  shutdownAllBastionSessions: mock.shutdownAllBastionSessions,
}));
vi.mock('../src/services/sweeper.js', () => ({ startSweeper: mock.startSweeper, stopSweeper: mock.stopSweeper }));
vi.mock('../src/services/telegram.js', () => ({ telegramService: { init: mock.initTelegram, stop: mock.stopTelegram } }));

const events = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;
let listenersBefore: Map<string, number>;
let runtime: typeof import('../src/runtime.js');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.buildServer.mockResolvedValue({ listen: mock.listen, close: mock.close });
  mock.listen.mockResolvedValue('http://127.0.0.1:3000');
  mock.close.mockResolvedValue(undefined);
  listenersBefore = new Map(events.map((event) => [event, process.listenerCount(event)]));
  runtime = await import('../src/runtime.js');
});
afterEach(async () => {
  await runtime.stopGateway();
  vi.restoreAllMocks();
});

it('imports runtime without installing listeners or starting background services', () => {
  for (const event of events) expect(process.listenerCount(event)).toBe(listenersBefore.get(event));
  expect(mock.buildServer).not.toHaveBeenCalled();
  expect(mock.startTicketCleaner).not.toHaveBeenCalled();
  expect(mock.startSessionMaintenance).not.toHaveBeenCalled();
  expect(mock.startSweeper).not.toHaveBeenCalled();
  expect(mock.initTelegram).not.toHaveBeenCalled();
});

it('starts once and removes its own listeners and services on repeated shutdown', async () => {
  await Promise.all([runtime.startGateway(), runtime.startGateway()]);
  for (const event of events) expect(process.listenerCount(event)).toBe(listenersBefore.get(event)! + 1);
  for (const fn of [mock.buildServer, mock.initTelegram, mock.ensureSeedData, mock.startTicketCleaner,
    mock.startSessionMaintenance, mock.startSweeper, mock.listen]) expect(fn).toHaveBeenCalledTimes(1);
  expect(mock.listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: 3000 });
  expect(mock.initTelegram.mock.invocationCallOrder[0]).toBeLessThan(mock.ensureSeedData.mock.invocationCallOrder[0]);
  expect(mock.ensureSeedData.mock.invocationCallOrder[0]).toBeLessThan(mock.listen.mock.invocationCallOrder[0]);
  await Promise.all([runtime.stopGateway(), runtime.stopGateway()]);
  for (const event of events) expect(process.listenerCount(event)).toBe(listenersBefore.get(event));
  for (const fn of [mock.stopTicketCleaner, mock.stopSessionMaintenance, mock.shutdownAllBastionSessions,
    mock.stopSweeper, mock.stopTelegram, mock.close, mock.closeDatabasePool]) expect(fn).toHaveBeenCalledTimes(1);
  expect(mock.close.mock.invocationCallOrder[0]).toBeLessThan(mock.closeDatabasePool.mock.invocationCallOrder[0]);
});

it('cleans started services and process listeners when listening fails', async () => {
  const failure = new Error('isolated listen failure');
  mock.listen.mockRejectedValueOnce(failure);
  await expect(runtime.startGateway()).rejects.toBe(failure);
  for (const event of events) expect(process.listenerCount(event)).toBe(listenersBefore.get(event));
  for (const fn of [mock.stopTicketCleaner, mock.stopSessionMaintenance, mock.shutdownAllBastionSessions,
    mock.stopSweeper, mock.stopTelegram, mock.close, mock.closeDatabasePool]) expect(fn).toHaveBeenCalledTimes(1);
});

it('installs signal shutdown handlers only after startup has finished listening', async () => {
  let finishListening!: (address: string) => void;
  let listeningStarted!: () => void;
  const listening = new Promise<string>((resolve) => { finishListening = resolve; });
  const started = new Promise<void>((resolve) => { listeningStarted = resolve; });
  mock.listen.mockImplementationOnce(() => { listeningStarted(); return listening; });
  const starting = runtime.startGateway();
  await started;
  for (const event of ['SIGINT', 'SIGTERM']) expect(process.listenerCount(event)).toBe(listenersBefore.get(event));
  finishListening('http://127.0.0.1:3000');
  await starting;
  for (const event of ['SIGINT', 'SIGTERM']) expect(process.listenerCount(event)).toBe(listenersBefore.get(event)! + 1);
});

it('still closes the database pool when server shutdown rejects', async () => {
  await runtime.startGateway();
  mock.close.mockRejectedValueOnce(new Error('isolated close failure'));
  await expect(runtime.stopGateway()).rejects.toThrow('isolated close failure');
  expect(mock.closeDatabasePool).toHaveBeenCalledTimes(1);
  for (const event of events) expect(process.listenerCount(event)).toBe(listenersBefore.get(event));
  // The rejected shutdown promise is already asserted; teardown must not rethrow it.
  runtime = { ...runtime, stopGateway: async () => {} };
});
