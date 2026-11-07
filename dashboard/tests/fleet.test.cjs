const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');

// Exercise the production helper directly; only TypeScript types are removed.
const source = stripTypeScriptTypes(fs.readFileSync('src/utils/fleet.ts', 'utf8'));
const fleet = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const metric = (cpu, used = 25, total = 100) => ({
  cpu_percent: cpu, memory_used_bytes: used, memory_total_bytes: total,
  disk_used_bytes: used, disk_total_bytes: total, recorded_at: '2026-11-06T00:00:00Z',
});
const node = (name, status = 'HEALTHY', latest_metric, ip_address = '10.100.0.2') => ({
  id: name, name, status, latest_metric, ip_address, node_type: 'VM',
  last_seen: '2026-11-06T00:00:00Z', created_at: '2026-11-01T00:00:00Z',
});
const names = (nodes) => nodes.map(item => item.name);

test('missing or invalid metrics stay unknown while a genuine zero remains zero', async () => {
  const { getNodeCpuPercent, getNodeRamPercent, getNodeDiskPercent } = await fleet;
  for (const item of [node('missing'), node('nan', 'HEALTHY', metric(NaN, NaN)),
    node('negative', 'HEALTHY', metric(-1, -1)),
    node('infinite', 'HEALTHY', metric(Infinity, Infinity))]) {
    assert.equal(getNodeCpuPercent(item), undefined);
    assert.equal(getNodeRamPercent(item), undefined);
    assert.equal(getNodeDiskPercent(item), undefined);
  }
  const zero = node('idle', 'HEALTHY', metric(0, 0, 100));
  assert.equal(getNodeCpuPercent(zero), 0);
  assert.equal(getNodeRamPercent(zero), 0);
  assert.equal(getNodeDiskPercent(zero), 0);
  assert.equal(getNodeRamPercent(node('no-total', 'HEALTHY', metric(5, 0, 0))), undefined);
  assert.equal(getNodeDiskPercent(node('over-total', 'HEALTHY', metric(5, 101, 100))), undefined);
});

test('CPU sorts descending, uses name for equal values, and puts unknown after idle zero', async () => {
  const { filterAndSortNodes } = await fleet;
  const input = [node('missing'), node('node-10', 'HEALTHY', metric(75)),
    node('idle', 'HEALTHY', metric(0)), node('node-2', 'HEALTHY', metric(75)),
    node('busy', 'HEALTHY', metric(90)), node('invalid', 'HEALTHY', metric(NaN))];
  assert.deepEqual(names(filterAndSortNodes(input, '', 'ALL', 'cpu')),
    ['busy', 'node-2', 'node-10', 'idle', 'invalid', 'missing']);
});

test('RAM sorting compares usage percentages and puts invalid totals last', async () => {
  const { filterAndSortNodes } = await fleet;
  const input = [node('large-low', 'HEALTHY', metric(0, 40, 1000)),
    node('small-high', 'HEALTHY', metric(0, 9, 10)),
    node('unknown', 'HEALTHY', metric(0, 0, 0)), node('idle', 'HEALTHY', metric(0, 0, 100))];
  assert.deepEqual(names(filterAndSortNodes(input, '', 'ALL', 'ram')),
    ['small-high', 'large-low', 'idle', 'unknown']);
});

test('status prioritizes Offline then Stale then Online without recomputing liveness', async () => {
  const { filterAndSortNodes } = await fleet;
  const oldOnline = { ...node('online'), last_seen: null };
  const freshOffline = node('offline', 'OFFLINE');
  const input = [oldOnline, node('warning-b', 'WARNING'), freshOffline, node('warning-a', 'WARNING')];
  const result = filterAndSortNodes(input, '', 'ALL', 'status');
  assert.deepEqual(names(result), ['offline', 'warning-a', 'warning-b', 'online']);
  assert.equal(result[0].status, 'OFFLINE');
  assert.equal(result[3].status, 'HEALTHY');
});

test('search trims and matches names or VPN addresses case-insensitively together with status filter', async () => {
  const { filterAndSortNodes } = await fleet;
  const input = [node('Debian-01', 'HEALTHY', undefined, '10.100.0.4'),
    node('debian-02', 'OFFLINE', undefined, '10.100.0.5'), node('Windows-01', 'HEALTHY')];
  assert.deepEqual(names(filterAndSortNodes(input, ' DEBIAN ', 'ALL', 'name')), ['Debian-01', 'debian-02']);
  assert.deepEqual(names(filterAndSortNodes(input, 'debian', 'OFFLINE', 'name')), ['debian-02']);
  assert.deepEqual(names(filterAndSortNodes(input, ' .0.4 ', 'ALL', 'name')), ['Debian-01']);
  assert.deepEqual(filterAndSortNodes(input, 'absent', 'ALL', 'name'), []);
});

test('sorting leaves input order and node identities intact for selection by id', async () => {
  const { filterAndSortNodes } = await fleet;
  const selected = node('node-2', 'WARNING', metric(5));
  const input = Object.freeze([node('node-10'), selected, node('node-1')]);
  const visible = filterAndSortNodes(input, '', 'ALL', 'name');
  assert.deepEqual(names(visible), ['node-1', 'node-2', 'node-10']);
  assert.deepEqual(names(input), ['node-10', 'node-2', 'node-1']);
  assert.equal(visible.find(item => item.id === selected.id), selected);
  assert.equal(filterAndSortNodes(input, '', 'HEALTHY', 'name').some(item => item.id === selected.id), false);
  assert.equal(selected.status, 'WARNING');
});
