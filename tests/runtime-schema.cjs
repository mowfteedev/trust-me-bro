// Upgrade PostgreSQL thật 007→008 trong DB tạm; không sửa DB demo/người dùng.
// Fastify inject kiểm tra API thật, payload byte/percent là dữ liệu kiểm thử.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const appDir = process.cwd();
const database = 'zt_schema_' + crypto.randomBytes(6).toString('hex');
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-migrations-'));
const admin = new Pool({ connectionString: credentials.migration_url });
let created = false, testAdmin, server, closeDatabasePool;

async function main() {
  await admin.query(`CREATE DATABASE ${database}`);
  created = true;
  const migration = new URL(credentials.migration_url);
  const runtime = new URL(credentials.app_url);
  migration.pathname = runtime.pathname = '/' + database;
  process.env.MIGRATION_DATABASE_URL = migration.toString();
  process.env.DATABASE_URL = runtime.toString();
  process.env.NODE_ENV = 'test';
  process.env.TELEGRAM_MODE = 'dry-run';
  testAdmin = new Pool({ connectionString: migration.toString() });
  const { runMigrations } = require('./dist/services/migration-runner.js');
  fs.mkdirSync(path.join(fixtureDir, 'migrations'));
  for (const file of fs.readdirSync(path.join(appDir, 'migrations'))) {
    if (/^00[1-7]_.*\.sql$/.test(file)) {
      fs.copyFileSync(path.join(appDir, 'migrations', file), path.join(fixtureDir, 'migrations', file));
    }
  }
  try {
    process.chdir(fixtureDir);
    await runMigrations();
  } finally {
    process.chdir(appDir);
  }
  assert.equal((await testAdmin.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 7);
  const { hashPassword } = require('./dist/utils/crypto.js');
  const nodeId = crypto.randomUUID(), userId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const password = crypto.randomBytes(24).toString('hex');
  await testAdmin.query(
    "INSERT INTO users (id,username,password_hash,role) VALUES ($1,'schema-viewer',$2,'VIEWER')",
    [userId, hashPassword(password)],
  );
  await testAdmin.query(
    `INSERT INTO nodes (id,name,ip_address,token_hash,token_prefix,status,last_seen)
     VALUES ($1,'schema-probe','10.100.0.98',$2,$3,'HEALTHY',now())`,
    [nodeId, crypto.createHash('sha256').update(token).digest('hex'), token.slice(0, 8)],
  );
  // Deliberately different legacy percentages: only base measurements survive normalization.
  await testAdmin.query(
    `INSERT INTO metrics_history (node_id,cpu_percent,ram_used_bytes,ram_total_bytes,ram_percent,
      disk_used_bytes,disk_total_bytes,disk_percent,network_rx_bytes,network_tx_bytes,uptime_seconds,recorded_at)
     VALUES ($1,12.5,400,1000,50,250,1000,60,123,456,789,now())`, [nodeId],
  );
  await testAdmin.query("INSERT INTO alerts (node_id,severity,message) VALUES ($1,'WARNING','schema-preservation')", [nodeId]);
  await testAdmin.query(
    "INSERT INTO audit_logs (node_id,user_id,action,details) VALUES ($1,$2,'SCHEMA_PROBE',$3)",
    [nodeId, userId, JSON.stringify({ source: 'isolated-upgrade-test' })],
  );
  async function snapshot() {
    return {
      users: (await testAdmin.query('SELECT id,username,password_hash,role,session_version FROM users ORDER BY id')).rows,
      nodes: (await testAdmin.query('SELECT id,name,ip_address,token_hash,host_key_fingerprint FROM nodes ORDER BY id')).rows,
      metrics: (await testAdmin.query(`SELECT node_id,cpu_percent,ram_used_bytes,ram_total_bytes,
        disk_used_bytes,disk_total_bytes,network_rx_bytes,network_tx_bytes,uptime_seconds,recorded_at::text
        FROM metrics_history ORDER BY node_id,recorded_at`)).rows,
      alerts: (await testAdmin.query('SELECT id,node_id,severity,message,resolved FROM alerts ORDER BY id')).rows,
      audit: (await testAdmin.query('SELECT id,node_id,user_id,action,details FROM audit_logs ORDER BY id')).rows,
      foreignKeys: (await testAdmin.query(`SELECT conrelid::regclass::text relation,conname,pg_get_constraintdef(oid) definition
        FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace ORDER BY relation,conname`)).rows,
    };
  }
  const before = await snapshot();
  await runMigrations();
  assert.deepEqual(await snapshot(), before);
  assert.equal((await testAdmin.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 8);
  console.log('PASS upgrade007→008 giữ UUID, FK, history/bytes/CPU/network/uptime, users/alerts/audit (DB thật)');
  await testAdmin.query("SELECT create_daily_metrics_partition((now() AT TIME ZONE 'UTC')::date + 2)");
  const storedRatios = await testAdmin.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND (table_name='metrics_history' OR table_name LIKE 'metrics_history_%')
    AND column_name IN ('ram_percent','disk_percent')`);
  assert.equal(storedRatios.rows.length, 0);
  console.log('PASS parent, partitions hiện có và partition mới không lưu tỷ lệ dư thừa');

  ({ closeDatabasePool } = require('./dist/services/db.js'));
  server = await require('./dist/server.js').buildServer();
  const login = await server.inject({ method: 'POST', url: '/api/auth/login',
    payload: { username: 'schema-viewer', password } });
  assert.equal(login.statusCode, 200);
  const headers = { authorization: 'Bearer ' + login.json().token };
  const historyBefore = await server.inject({ method: 'GET', url: `/api/nodes/${nodeId}/history`, headers });
  assert.equal(historyBefore.statusCode, 200);
  assert.equal(historyBefore.json().data[0].ram_percent, 40);
  assert.equal(historyBefore.json().data[0].disk_percent, 25);
  const beacon = await server.inject({ method: 'POST', url: '/api/telemetry/beacon',
    headers: { 'x-node-token': token }, payload: { node_id: 'schema-probe', timestamp: Date.now(), metrics: {
      cpu: { percent: 13 }, memory: { total_bytes: 1000, used_bytes: 400, percent: 99 },
      disk: { total_bytes: 1000, used_bytes: 250, percent: 99 },
      network: { rx_bytes_total: 124, tx_bytes_total: 457 }, uptime_seconds: 790,
    } } });
  assert.equal(beacon.statusCode, 200);
  const latest = await server.inject({ method: 'GET', url: '/api/nodes', headers });
  assert.equal(latest.statusCode, 200);
  const metric = latest.json().data.find((node) => node.id === nodeId).latest_metric;
  assert.equal(metric.ram_percent, 40);
  assert.equal(metric.disk_percent, 25);
  const history = await server.inject({ method: 'GET', url: `/api/nodes/${nodeId}/history`, headers });
  assert.equal(history.statusCode, 200);
  assert.equal(history.json().data.length, 2);
  assert.ok(history.json().data.every((row) => row.ram_percent === 40 && row.disk_percent === 25));
  assert.ok(history.json().data.every((row) => typeof row.memory_used_bytes === 'number'
    && typeof row.network_rx_bytes === 'number' && typeof row.uptime_seconds === 'number'));
  console.log('PASS beacon ghi schema008, API latest/history giữ fields tỷ lệ tính từ bytes (Fastify inject + DB thật)');
}
main().catch((error) => { console.error('FAIL schema:', error.message); process.exitCode = 1; }).finally(async () => {
  process.chdir(appDir);
  if (server) await server.close();
  if (closeDatabasePool) await closeDatabasePool();
  if (testAdmin) await testAdmin.end();
  if (created) await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});
