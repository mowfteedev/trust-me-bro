/** Configuration validation only; dotenv is disabled to avoid reading local secrets. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('JWT_SECRET', 'test-only-validation-secret-at-least-32-characters');
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture:fixture@localhost/fixture');
  vi.stubEnv('CPU_ALERT_THRESHOLD_PERCENT', undefined);
  vi.stubEnv('CPU_RECOVERY_THRESHOLD_PERCENT', undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('defaults to85% raise and75% recovery and accepts a configured lower recovery', async () => {
  const initial = await import('../src/config/env.js');
  expect(initial.config.CPU_ALERT_THRESHOLD_PERCENT).toBe(85);
  expect(initial.config.CPU_RECOVERY_THRESHOLD_PERCENT).toBe(75);
  vi.resetModules();
  vi.stubEnv('CPU_ALERT_THRESHOLD_PERCENT', '60');
  vi.stubEnv('CPU_RECOVERY_THRESHOLD_PERCENT', '50');
  expect((await import('../src/config/env.js')).config.CPU_RECOVERY_THRESHOLD_PERCENT).toBe(50);
});

it.each(['0', '-1', '85', '90', 'NaN', 'Infinity'])('refuses invalid recovery %s before startup', async (recovery) => {
  vi.stubEnv('CPU_RECOVERY_THRESHOLD_PERCENT', recovery);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('configuration rejected'); });
  await expect(import('../src/config/env.js')).rejects.toThrow('configuration rejected');
  expect(process.exit).toHaveBeenCalledWith(1);
  expect(JSON.stringify(log.mock.calls)).toContain('CPU_RECOVERY_THRESHOLD_PERCENT');
  expect(JSON.stringify(log.mock.calls)).not.toContain('test-only-validation-secret');
});
