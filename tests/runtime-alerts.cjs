// Fastify inject + PostgreSQL thật, payload/timestamp giả lập trong DB test riêng.
// demo.py truyền credentials qua stdin; DB tạm được tạo/xóa bởi chính bài này.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const database = 'zt_check_' + crypto.randomBytes(6).toString('hex');
const admin = new Pool({ connectionString: credentials.migration_url });
let server, testAdmin, closeDatabasePool;
let created = false;
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
  await require('./dist/services/migration-runner.js').runMigrations();
  ({ closeDatabasePool } = require('./dist/services/db.js'));
  server = await require('./dist/server.js').buildServer();
  const { runSweeperCycle } = require('./dist/services/sweeper.js');
  const token = crypto.randomBytes(32).toString('hex');
  await testAdmin.query(
    `INSERT INTO nodes (name,ip_address,token_hash,token_prefix,status,last_seen)
     VALUES ('cpu-probe','10.100.0.99',$1,$2,'HEALTHY',now());`,
    [crypto.createHash('sha256').update(token).digest('hex'), token.slice(0, 8)],
  );
  const payload = (cpu) => ({ node_id: 'cpu-probe', timestamp: Date.now(), metrics: {
    cpu: { percent: cpu }, memory: { total_bytes: 1000, used_bytes: 100, percent: 10 },
    disk: { total_bytes: 1000, used_bytes: 100, percent: 10 },
    network: { rx_bytes_total: 100, tx_bytes_total: 100 }, uptime_seconds: 10,
  } });
  const beacon = (cpu, nodeToken = token, nodeName = 'cpu-probe') => server.inject({
    method: 'POST', url: '/api/telemetry/beacon', headers: { 'x-node-token': nodeToken },
    payload: { ...payload(cpu), node_id: nodeName },
  });
  assert.equal((await beacon(84.8)).statusCode, 200);
  assert.equal((await testAdmin.query("SELECT count(*)::int n FROM alerts WHERE message LIKE 'CPU_HIGH:%'")).rows[0].n, 0);
  for (const cpu of [85, 85.2, 84.8, 85.1, 75]) {
    assert.equal((await beacon(cpu)).statusCode, 200);
    const rows = (await testAdmin.query("SELECT * FROM alerts WHERE message LIKE 'CPU_HIGH:%'")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].resolved, false);
  }
  assert.equal((await testAdmin.query("SELECT count(*)::int n FROM audit_logs WHERE action='CPU_HIGH'")).rows[0].n, 1);
  console.log('PASS CPU mở ở85%, giữ incident tại75–85%, không spam audit (payload giả lập + DB thật)');
  assert.equal((await beacon(74.9)).statusCode, 200);
  assert.equal((await testAdmin.query("SELECT count(*)::int n FROM alerts WHERE message LIKE 'CPU_HIGH:%' AND resolved=false")).rows[0].n, 0);
  assert.equal((await beacon(80)).statusCode, 200);
  assert.equal((await testAdmin.query("SELECT count(*)::int n FROM alerts WHERE message LIKE 'CPU_HIGH:%'")).rows[0].n, 1);
  assert.equal((await beacon(85)).statusCode, 200);
  assert.equal((await testAdmin.query("SELECT count(*)::int n FROM alerts WHERE message LIKE 'CPU_HIGH:%'")).rows[0].n, 2);
  assert.equal((await beacon(10)).statusCode, 200);
  console.log('PASS CPU chỉ resolve dưới75%, trong dải đệm không mở lại; vượt85% tạo incident mới (DB thật)');
  assert.equal((await beacon(10, 'wrong-token')).statusCode, 401);
  assert.equal((await beacon(10, token, 'another-node')).statusCode, 403);
  console.log('PASS token sai/giả mạo node bị từ chối');
  await testAdmin.query("UPDATE nodes SET last_seen=now()-interval '20 seconds'");
  await runSweeperCycle();
  assert.equal((await testAdmin.query('SELECT status FROM nodes')).rows[0].status, 'WARNING');
  await testAdmin.query("UPDATE nodes SET last_seen=now()-interval '35 seconds'");
  await runSweeperCycle();
  await runSweeperCycle();
  assert.equal((await testAdmin.query('SELECT status FROM nodes')).rows[0].status, 'OFFLINE');
  assert.equal((await testAdmin.query("SELECT count(*)::int n FROM alerts WHERE message LIKE 'NODE_OFFLINE:%'")).rows[0].n, 1);
  console.log('PASS Stale/Offline + chống lặp incident (timestamp giả lập + DB thật)');
  assert.equal((await beacon(10)).statusCode, 200);
  assert.equal((await testAdmin.query('SELECT status FROM nodes')).rows[0].status, 'HEALTHY');
  assert.equal((await testAdmin.query('SELECT count(*)::int n FROM alerts WHERE resolved=false')).rows[0].n, 0);
  console.log('PASS phục hồi Online + resolve incident');
  console.log('Telegram chỉ DRY-RUN, không gửi Bot API thật.');
}
main().catch((error) => { console.error('FAIL:', error.message); process.exitCode = 1; }).finally(async () => {
  if (server) await server.close();
  if (closeDatabasePool) await closeDatabasePool();
  if (testAdmin) await testAdmin.end();
  if (created) await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
});
