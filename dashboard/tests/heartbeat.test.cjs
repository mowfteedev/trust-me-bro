const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');

const source = stripTypeScriptTypes(fs.readFileSync('src/utils/heartbeat.ts', 'utf8'));
const heartbeat = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const now = Date.parse('2026-11-07T12:00:00Z');
const sample = offset => ({ recorded_at: new Date(now + offset).toISOString() });
const total = buckets => buckets.reduce((count, bucket) => count + bucket.count, 0);

test('30 buckets cover only the preceding 90 seconds, oldest first', async () => {
  const { buildHeartbeatBuckets } = await heartbeat;
  const buckets = buildHeartbeatBuckets([], now);
  assert.equal(buckets.length, 30);
  assert.equal(buckets[0].start, now - 90000);
  assert.equal(buckets[29].end, now);
  assert.equal(total(buckets), 0);
  for (let index = 0; index < 30; index++) {
    assert.equal(buckets[index].end - buckets[index].start, 3000);
    if (index) assert.equal(buckets[index - 1].end, buckets[index].start);
  }
});

test('window start, shared bucket edges and the latest endpoint count exactly once', async () => {
  const { buildHeartbeatBuckets } = await heartbeat;
  const buckets = buildHeartbeatBuckets([sample(-90000), sample(-87001), sample(-87000), sample(-1), sample(0)], now);
  assert.equal(buckets[0].count, 2);
  assert.equal(buckets[1].count, 1);
  assert.equal(buckets[29].count, 2);
  assert.equal(total(buckets), 5);
});

test('old, future and invalid timestamps do not invent received heartbeat', async () => {
  const { buildHeartbeatBuckets } = await heartbeat;
  const buckets = buildHeartbeatBuckets([sample(-90001), sample(1), { recorded_at: '' }, { recorded_at: 'invalid' }], now);
  assert.equal(total(buckets), 0);
  assert.equal(buckets.filter(bucket => bucket.count === 0).length, 30);
  assert.deepEqual(buildHeartbeatBuckets([sample(0)], NaN), []);
});

test('duplicate rows are counted once and ordering cannot move samples across gaps', async () => {
  const { buildHeartbeatBuckets } = await heartbeat;
  const input = [sample(-500), sample(-88500), sample(-500), sample(-45000)];
  const before = JSON.stringify(input);
  const buckets = buildHeartbeatBuckets(input, now);
  assert.equal(total(buckets), 3);
  assert.equal(buckets[0].count, 1);
  assert.equal(buckets[15].count, 1);
  assert.equal(buckets[29].count, 1);
  assert.equal(buckets[10].count, 0);
  assert.equal(JSON.stringify(input), before);
});

test('as time advances, missing slots remain unknown and old samples leave the window', async () => {
  const { buildHeartbeatBuckets } = await heartbeat;
  const samples = [sample(-89999), sample(-1000)];
  const later = buildHeartbeatBuckets(samples, now + 6000);
  assert.equal(total(later), 1);
  assert.equal(later[27].count, 1);
  assert.equal(later[28].count, 0);
  assert.equal(later[29].count, 0);
});
