// Optional lab proof: actual Go Mini-Agent -> localhost HTTP -> Fastify -> PostgreSQL.
// Credentials are prefixed through stdin like runtime-alerts.cjs; no fixture beacons.
// Uses a lowered, measured-baseline threshold, NOT proof of crossing the default 85%.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { Pool } = require('pg');

const database = 'zt_cpu_live_' + crypto.randomBytes(6).toString('hex');
const admin = new Pool({ connectionString: credentials.migration_url,
  connectionTimeoutMillis: 3000, query_timeout: 10000, statement_timeout: 10000 });
const workers = [];
let created = false, testAdmin, server, closeDatabasePool, agent, agentExit;
let agentStopped = false, agentError, agentLog = '', abortError;
const runDeadline = setTimeout(() => {
  abortError = new Error('overall CPU lab deadline exceeded (90 seconds)');
  if (agent && !agentStopped) agent.kill('SIGKILL');
  for (const worker of workers) void worker.terminate();
}, 90000);

function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

async function until(label, milliseconds, inspect) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (abortError) throw abortError;
    if (agentError) throw agentError;
    if (agentStopped) throw new Error('Go Agent exited before verification: ' + agentLog);
    const result = await inspect();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(label + ' timed out; no fabricated readings or forced PASS');
}

async function main() {
  const binary = process.env.ZT_AGENT_TEST_BINARY || '/tmp/zt-agent-check';
  fs.accessSync(binary, fs.constants.X_OK);
  console.log('CPU_LIVE: real Linux /proc samples; isolated DB; loopback interface/HTTP lab only.');
  console.log('CPU_LIVE: interval=1s, jitter=0, GOMAXPROCS=1; Telegram dry-run, no external messages.');
  await admin.query(`CREATE DATABASE ${database}`);
  created = true;
  const migration = new URL(credentials.migration_url);
  const runtime = new URL(credentials.app_url);
  migration.pathname = runtime.pathname = '/' + database;
  migration.searchParams.set('options', '-c statement_timeout=10000 -c lock_timeout=5000');
  process.env.MIGRATION_DATABASE_URL = migration.toString();
  process.env.DATABASE_URL = runtime.toString();
  process.env.NODE_ENV = 'test';
  process.env.TELEGRAM_MODE = 'dry-run';
  process.env.TRUSTED_PROXY_IP = '';
  process.env.CPU_ALERT_THRESHOLD_PERCENT = '100';
  testAdmin = new Pool({ connectionString: migration.toString(),
    connectionTimeoutMillis: 3000, query_timeout: 5000, statement_timeout: 5000 });
  await bounded(require('./dist/services/migration-runner.js').runMigrations(), 30000, 'migrations');
  ({ closeDatabasePool } = require('./dist/services/db.js'));
  const { config } = require('./dist/config/env.js');
  server = await require('./dist/server.js').buildServer();
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  const token = crypto.randomBytes(32).toString('hex');
  const node = (await testAdmin.query(
    `INSERT INTO nodes (name,ip_address,token_hash,token_prefix,status,last_seen)
     VALUES ('cpu-live-probe','127.0.0.1',$1,$2,'HEALTHY',now()) RETURNING id;`,
    [crypto.createHash('sha256').update(token).digest('hex'), token.slice(0, 8)],
  )).rows[0];
  agent = spawn(binary, [], { stdio: ['ignore', 'ignore', 'pipe'], env: {
    NODE_ID: 'cpu-live-probe', NODE_TOKEN: token, GATEWAY_URL: address,
    NETWORK_INTERFACE: 'lo', DISK_MOUNT_POINT: '/', BEACON_INTERVAL_SECONDS: '1',
    JITTER_RATIO: '0', HTTP_TIMEOUT_SECONDS: '2', MAX_BACKOFF_SECONDS: '2', GOMAXPROCS: '1',
  } });
  agent.stderr.on('data', (chunk) => { agentLog = (agentLog + chunk.toString()).slice(-4000); });
  agent.on('error', (error) => { agentError = new Error('cannot start Go Agent: ' + error.message); });
  agentExit = new Promise((resolve) => agent.once('close', () => { agentStopped = true; resolve(); }));

  let phase = 'baseline', lastPrintedCount = 0;
  async function readings() {
    const rows = (await testAdmin.query(
      'SELECT cpu_percent,recorded_at FROM metrics_history WHERE node_id=$1 ORDER BY recorded_at;', [node.id],
    )).rows;
    if (rows.length > lastPrintedCount) {
      console.log('CPU_LIVE samples ' + phase + ': ' + rows.slice(lastPrintedCount)
        .map((row) => Number(row.cpu_percent).toFixed(2) + '%@' + row.recorded_at.toISOString()).join(', '));
      lastPrintedCount = rows.length;
    }
    return rows;
  }
  async function incidents() {
    return (await testAdmin.query(
      "SELECT id,resolved,resolved_at FROM alerts WHERE node_id=$1 AND message LIKE 'CPU_HIGH:%' ORDER BY triggered_at;", [node.id],
    )).rows;
  }
  async function audits() {
    return (await testAdmin.query(
      "SELECT details FROM audit_logs WHERE node_id=$1 AND action='CPU_HIGH';", [node.id],
    )).rows;
  }

  const baseline = await until('three real baseline heartbeats', 15000, async () => {
    const rows = await readings();
    return rows.length >= 3 ? rows : null;
  });
  assert.equal((await incidents()).length, 0, 'baseline unexpectedly crossed initial 100% threshold');
  const baselineMax = Math.max(...baseline.map((row) => Number(row.cpu_percent)));
  const threshold = Math.round((baselineMax + 4.5) * 100) / 100;
  assert.ok(threshold < 100, 'baseline too busy for a bounded two-thread CPU lab');
  config.CPU_ALERT_THRESHOLD_PERCENT = threshold;
  console.log(`CPU_LIVE threshold=${threshold}% (baseline maximum=${baselineMax.toFixed(2)}% +4.5 points).`);
  console.log('CPU_LIVE: test configuration only; default 85% was NOT demonstrated by this lab.');

  phase = 'load';
  const parallelism = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  assert.ok(parallelism >= 2, 'CPU lab requires at least two available CPUs to avoid occupying the whole host');
  const count = Math.min(2, Math.floor(parallelism / 2));
  console.log(`CPU_LIVE controlled load: ${count} Worker threads, each self-stops after 10 seconds; host logical CPUs=${os.cpus().length}.`);
  const loadScript = `const { parentPort } = require('node:worker_threads');
    const until = performance.now() + 10000; let result = 1;
    while (performance.now() < until) {
      for (let i = 1; i < 20000; i++) result = Math.imul(result ^ i, 1664525) + 1013904223 | 0;
    }
    parentPort.postMessage(result);`;
  const loadDone = [];
  for (let i = 0; i < count; i++) {
    const worker = new Worker(loadScript, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 16 } });
    workers.push(worker);
    loadDone.push(new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', (code) => code === 0 ? resolve() : reject(new Error('CPU load worker exited with ' + code)));
    }));
  }
  // Attach rejection handlers immediately even while DB polling is in progress.
  const finishedLoad = Promise.all(loadDone);
  void finishedLoad.catch(() => {});
  let peak = baselineMax;
  await until('two real above-threshold samples and one active incident', 12000, async () => {
    const rows = await readings();
    peak = Math.max(peak, ...rows.map((row) => Number(row.cpu_percent)));
    const alerts = await incidents();
    assert.ok(alerts.length <= 1, 'threshold oscillation created another incident; this run cannot prove deduplication');
    const above = rows.slice(baseline.length).filter((row) => Number(row.cpu_percent) >= threshold);
    return above.length >= 2 && alerts.length === 1 && !alerts[0].resolved ? true : null;
  }).catch((error) => {
    throw new Error(error.message + `; measured peak=${peak.toFixed(2)}%, required=${threshold}% (limited load may be insufficient)`);
  });
  await bounded(finishedLoad, 12000, 'bounded CPU load');
  const loaded = await readings();
  assert.ok(loaded.slice(baseline.length).filter((row) => Number(row.cpu_percent) >= threshold).length >= 2);
  assert.equal((await incidents()).length, 1, 'repeated high beacons must share one incident');
  const recordedAudits = await audits();
  assert.equal(recordedAudits.length, 1, 'repeated high beacons must produce one CPU_HIGH audit');
  assert.equal(Number(recordedAudits[0].details.threshold), threshold);
  assert.ok(Number(recordedAudits[0].details.cpu_percent) >= threshold);
  console.log(`PASS CPU_LIVE real Agent/HTTP/SQL: peak=${Math.max(...loaded.map((row) => Number(row.cpu_percent))).toFixed(2)}%; one incident and one CPU_HIGH audit despite repeated high samples.`);

  phase = 'recovery';
  const afterLoadCount = loaded.length;
  const recovered = await until('real CPU cooldown and resolved incident', 20000, async () => {
    const rows = await readings();
    const fresh = rows.slice(afterLoadCount);
    const alerts = await incidents();
    assert.equal(alerts.length, 1, 'background CPU oscillation created another incident');
    if (fresh.length >= 2 && fresh.slice(-2).every((row) => Number(row.cpu_percent) < threshold)
      && alerts[0].resolved && alerts[0].resolved_at) return rows;
    return null;
  });
  assert.equal((await audits()).length, 1);
  console.log('PASS CPU_LIVE actual cooldown: last two readings=' + recovered.slice(-2)
    .map((row) => Number(row.cpu_percent).toFixed(2) + '%').join(', ') + '; original incident resolved in PostgreSQL.');
  console.log('CPU_LIVE scope: Agent in Gateway lab container reads Linux host /proc; this is not the two-VM/WireGuard/default-85% proof.');
}

main().catch((error) => {
  console.error('FAIL CPU_LIVE:', error.message);
  process.exitCode = 1;
}).finally(async () => {
  clearTimeout(runDeadline);
  const cleanup = async (label, action) => {
    try { await bounded(action(), 5000, label); }
    catch (error) { console.error('FAIL CPU_LIVE cleanup:', error.message); process.exitCode = 1; }
  };
  await cleanup('load workers', () => Promise.allSettled(workers.map((worker) => worker.terminate())));
  if (agent && !agentStopped) {
    agent.kill('SIGTERM');
    try { await bounded(agentExit, 2000, 'Agent stop'); }
    catch { agent.kill('SIGKILL'); await cleanup('Agent kill', () => agentExit); }
  }
  if (server) await cleanup('Fastify close', () => server.close());
  if (closeDatabasePool) await cleanup('application DB close', closeDatabasePool);
  if (testAdmin) await cleanup('test DB close', () => testAdmin.end());
  if (created) await cleanup('owned test DB drop', () => admin.query(`DROP DATABASE ${database} WITH (FORCE)`));
  await cleanup('admin DB close', () => admin.end());
  if (!process.exitCode) console.log('PASS CPU_LIVE cleanup: Go child/workers stopped; owned temporary database dropped.');
});
