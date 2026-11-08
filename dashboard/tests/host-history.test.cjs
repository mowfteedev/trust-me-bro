const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const source = stripTypeScriptTypes(fs.readFileSync('src/utils/hostHistory.ts', 'utf8'));
const history = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const epoch = Date.parse('2026-11-08T00:00:00Z');
const snapshot = (time, overrides = {}) => ({ sampled_at: new Date(time).toISOString(), stale: false,
  host: { cpu_percent: 0, memory_used_bytes: 0, memory_total_bytes: 100, disk_used_bytes: 50, disk_total_bytes: 100, ...overrides }, services: [] });
test('history retains genuine zero, unknown CPU and valid capacity ratios', async () => {
  const { appendHostHistory } = await history;
  const zero = appendHostHistory([], snapshot(epoch), epoch);
  assert.deepEqual(zero, [{ at: new Date(epoch).toISOString(), cpu: 0, ram: 0, disk: 50 }]);
  const unknown = appendHostHistory([], snapshot(epoch, { cpu_percent: null, memory_used_bytes: 101 }), epoch);
  assert.equal(unknown[0].cpu, null); assert.equal(unknown[0].ram, null); assert.equal(unknown[0].disk, 50);
});
test('history ignores duplicate, out of order, stale, future and invalid timestamps without mutating state', async () => {
  const { appendHostHistory } = await history;
  const first = appendHostHistory([], snapshot(epoch), epoch);
  for (const s of [snapshot(epoch), snapshot(epoch - 5000), { ...snapshot(epoch + 5000), stale: true }, snapshot(epoch + 6000), { ...snapshot(epoch + 5000), sampled_at: 'invalid' }]) assert.equal(appendHostHistory(first, s, epoch + 5000), first);
  assert.equal(appendHostHistory(first, snapshot(epoch + 5000), epoch + 21000), first);
  assert.deepEqual(first, [{ at: new Date(epoch).toISOString(), cpu: 0, ram: 0, disk: 50 }]);
  const next = appendHostHistory(first, snapshot(epoch + 5000), epoch + 5000);
  assert.notEqual(next, first); assert.equal(first.length, 1); assert.equal(next.length, 2);
});
test('history never records impossible or entirely unknown resource values', async () => {
  const { appendHostHistory } = await history;
  assert.deepEqual(appendHostHistory([], snapshot(epoch, { cpu_percent: Infinity, memory_total_bytes: 0, disk_used_bytes: -1 }), epoch), []);
  const partial = appendHostHistory([], snapshot(epoch, { cpu_percent: -1, memory_used_bytes: NaN }), epoch);
  assert.equal(partial[0].cpu, null); assert.equal(partial[0].ram, null); assert.equal(partial[0].disk, 50);
});
test('history is capped at60 samples and five minutes while retaining exact sample timestamps', async () => {
  const { appendHostHistory } = await history;
  let points = [];
  for (let i = 0; i < 70; i++) points = appendHostHistory(points, snapshot(epoch + i * 1000), epoch + i * 1000);
  assert.equal(points.length, 60); assert.equal(points[0].at, new Date(epoch + 10000).toISOString());
  points = appendHostHistory(points, snapshot(epoch + 400000), epoch + 400000);
  assert.equal(points.length, 1); assert.equal(points[0].at, new Date(epoch + 400000).toISOString());
});
test('trend breaks at unknown values and observation gaps instead of drawing continuous availability', async () => {
  const { hostTrendSegments } = await history;
  const point = (offset, cpu) => ({ at: new Date(epoch + offset).toISOString(), cpu, ram: 50, disk: 50 });
  const input = [point(0, 0), point(5000, 5), point(10000, null), point(15000, 10), point(35000, 15), point(40000, 20)];
  const segments = hostTrendSegments(input, 'cpu');
  assert.deepEqual(segments.map(s => s.map(p => p.value)), [[0, 5], [10], [15, 20]]);
  assert.equal(segments[2][0].at, input[4].at); assert.deepEqual(hostTrendSegments([point(0, null)], 'cpu'), []);
});
