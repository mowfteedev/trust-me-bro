// Upgrade PostgreSQL thật 007→009 trong DB tạm; không sửa DB demo/người dùng.
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
  const migrations = fs.readdirSync(path.join(appDir, 'migrations')).filter((file) => file.endsWith('.sql')).sort();
  assert.ok(migrations.some((file) => /^009_.*\.sql$/.test(file)), 'Missing per-node SSH account migration');
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
      users: (await testAdmin.query('SELECT * FROM users ORDER BY id')).rows,
      nodes: (await testAdmin.query("SELECT to_jsonb(nodes)-'ssh_username' AS data FROM nodes ORDER BY id")).rows,
      metrics: (await testAdmin.query(`SELECT node_id,cpu_percent,ram_used_bytes,ram_total_bytes,
        disk_used_bytes,disk_total_bytes,network_rx_bytes,network_tx_bytes,uptime_seconds,recorded_at::text
        FROM metrics_history ORDER BY node_id,recorded_at`)).rows,
      alerts: (await testAdmin.query('SELECT * FROM alerts ORDER BY id')).rows,
      audit: (await testAdmin.query('SELECT * FROM audit_logs ORDER BY id')).rows,
      foreignKeys: (await testAdmin.query(`SELECT conrelid::regclass::text relation,conname,pg_get_constraintdef(oid) definition
        FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace ORDER BY relation,conname`)).rows,
    };
  }
  const before = await snapshot();
  await runMigrations();
  assert.deepEqual(await snapshot(), before);
  const applied = await testAdmin.query('SELECT name,applied_at::text FROM schema_migrations ORDER BY name');
  assert.deepEqual(applied.rows.map((row) => row.name), migrations);
  assert.equal((await testAdmin.query('SELECT ssh_username FROM nodes WHERE id=$1', [nodeId])).rows[0].ssh_username, null);
  await testAdmin.query('UPDATE nodes SET ssh_username=$1 WHERE id=$2', ['linux', nodeId]);
  await assert.rejects(testAdmin.query('UPDATE nodes SET ssh_username=$1 WHERE id=$2', ['root;id', nodeId]),
    (error) => error.code === '23514' && error.constraint === 'ck_nodes_ssh_username');
  const upgraded = await snapshot();
  await runMigrations();
  assert.deepEqual(await snapshot(), upgraded);
  assert.deepEqual((await testAdmin.query('SELECT name,applied_at::text FROM schema_migrations ORDER BY name')).rows, applied.rows);
  assert.equal((await testAdmin.query('SELECT ssh_username FROM nodes WHERE id=$1', [nodeId])).rows[0].ssh_username, 'linux');
  const newNodeId = crypto.randomUUID();
  await testAdmin.query(`INSERT INTO nodes (id,name,ip_address,token_hash,token_prefix)
    VALUES ($1,'schema-new-node','10.100.0.97',$2,'newnode-')`, [newNodeId, crypto.randomBytes(32).toString('hex')]);
  assert.equal((await testAdmin.query('SELECT ssh_username FROM nodes WHERE id=$1', [newNodeId])).rows[0].ssh_username, null);
  console.log('PASS upgrade007→009 giữ UUID/FK/history/users/alerts/audit; SSH fallback NULL, account riêng, constraint và rerun không đổi dữ liệu (DB thật)');
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

  // Hold an administrative update open: the initial lookup sees the old token,
  // then the beacon must wait for this row lock and recheck the committed identity.
  for (const change of ['revoke', 'replace']) {
    const lock = await testAdmin.connect();
    let pending;
    try {
      await lock.query('BEGIN');
      await lock.query(change === 'revoke'
        ? 'UPDATE nodes SET is_token_revoked=true WHERE id=$1'
        : 'UPDATE nodes SET token_hash=$2 WHERE id=$1',
      change === 'revoke' ? [nodeId] : [nodeId, crypto.randomBytes(32).toString('hex')]);
      pending = server.inject({ method: 'POST', url: '/api/telemetry/beacon',
        headers: { 'x-node-token': token }, payload: { node_id: 'schema-probe', timestamp: Date.now(), metrics: {
          cpu: { percent: 13 }, memory: { total_bytes: 1000, used_bytes: 400, percent: 40 },
          disk: { total_bytes: 1000, used_bytes: 250, percent: 25 },
          network: { rx_bytes_total: 125, tx_bytes_total: 458 }, uptime_seconds: 791,
        } } }).then((response) => response);
      const deadline = Date.now() + 2000;
      while (true) {
        const waiting = await testAdmin.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%'`, [database]);
        if (waiting.rows.length) break;
        assert.ok(Date.now() < deadline, 'Beacon did not reach the row lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await lock.query('COMMIT');
      assert.equal((await pending).statusCode, 401, `${change}: in-flight old token was accepted`);
      assert.equal((await testAdmin.query('SELECT count(*)::int n FROM metrics_history WHERE node_id=$1', [nodeId])).rows[0].n, 2);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
      if (pending) await pending;
      await testAdmin.query('UPDATE nodes SET is_token_revoked=false,token_hash=$2 WHERE id=$1',
        [nodeId, crypto.createHash('sha256').update(token).digest('hex')]);
    }
  }
  console.log('PASS revoke/replace token trong lúc beacon chờ row lock: HTTP401, không thêm metrics (DB thật)');

  // Simulate persisted data from before a wall-clock correction. Keep the row,
  // but do not let its future timestamp replace current dashboard measurements.
  await testAdmin.query(`INSERT INTO metrics_history (node_id,cpu_percent,ram_used_bytes,ram_total_bytes,
    disk_used_bytes,disk_total_bytes,network_rx_bytes,network_tx_bytes,uptime_seconds,recorded_at)
    VALUES ($1,99,900,1000,900,1000,999,999,999,now()+interval '3 hours')`, [nodeId]);
  const current = await server.inject({ method: 'GET', url: '/api/nodes', headers });
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().data.find((node) => node.id === nodeId).latest_metric.cpu_percent, 13);
  const visibleHistory = await server.inject({ method: 'GET', url: `/api/nodes/${nodeId}/history`, headers });
  assert.equal(visibleHistory.statusCode, 200);
  assert.equal(visibleHistory.json().data.length, 2);
  assert.ok(visibleHistory.json().data.every((row) => row.cpu_percent !== 99));
  assert.equal((await testAdmin.query('SELECT count(*)::int n FROM metrics_history WHERE node_id=$1', [nodeId])).rows[0].n, 3);
  console.log('PASS mẫu có timestamp tương lai không che mẫu mới; giữ nguyên dữ liệu DB (fixture SQL, không sửa giờ host)');

  const retained = await snapshot();
  const old = (await testAdmin.query(`SELECT 'metrics_history_y' || to_char(day,'YYYY_MM_DD') AS name,
    day::text AS start,(day+1)::text AS finish FROM (SELECT (now() AT TIME ZONE 'UTC')::date-15 AS day) dates`)).rows[0];
  assert.match(old.name, /^metrics_history_y\d{4}_\d{2}_\d{2}$/);
  await testAdmin.query(`CREATE TABLE public.${old.name} PARTITION OF metrics_history
    FOR VALUES FROM ('${old.start}') TO ('${old.finish}')`);
  await testAdmin.query(`INSERT INTO metrics_history (node_id,cpu_percent,ram_used_bytes,ram_total_bytes,
    disk_used_bytes,disk_total_bytes,network_rx_bytes,network_tx_bytes,uptime_seconds,recorded_at)
    VALUES ($1,5,100,1000,100,1000,1,1,1,now()-interval '15 days')`, [newNodeId]);
  const maintenanceUrl = new URL(credentials.maintenance_url);
  maintenanceUrl.pathname = '/' + database;
  const appCheck = new Pool({ connectionString: runtime.toString() });
  const maintenanceCheck = new Pool({ connectionString: maintenanceUrl.toString() });
  try {
    const policy = (await testAdmin.query(`SELECT pg_get_userbyid(proowner) AS owner,prosecdef,proconfig
      FROM pg_proc WHERE oid='public.drop_old_metrics_partitions(integer)'::regprocedure`)).rows[0];
    assert.equal(policy.owner, 'zt_admin');
    assert.equal(policy.prosecdef, true);
    assert.ok(policy.proconfig.includes('search_path=pg_catalog, public, pg_temp'));
    await assert.rejects(appCheck.query('SELECT drop_old_metrics_partitions(7)'), { code: '42501' });
    await assert.rejects(maintenanceCheck.query(`DROP TABLE public.${old.name}`), { code: '42501' });
    const job = require('node:child_process').spawnSync(process.execPath, ['dist/scripts/run-maintenance.js'], {
      env: { ...process.env, MAINTENANCE_DATABASE_URL: maintenanceUrl.toString(), RETENTION_DAYS: '7' },
      encoding: 'utf8', timeout: 15000,
    });
    assert.equal(job.status, 0, job.stderr || String(job.error || 'Maintenance job failed'));
    assert.equal((await testAdmin.query('SELECT to_regclass($1) AS relation', [old.name])).rows[0].relation, null);
    assert.deepEqual(await snapshot(), retained);
    console.log('PASS job retention thật xóa partition15ngày, giữ metrics/audit/FK; app bị cấm EXECUTE, maintenance bị cấm DROP trực tiếp (DB riêng)');
  } finally {
    await Promise.all([appCheck.end(), maintenanceCheck.end()]);
  }
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
