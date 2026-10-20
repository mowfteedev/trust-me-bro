// Explicit live check only: synthetic CPU in an owned temporary DB, real Telegram.
// The recipient is the already OTP-paired chat. No getUpdates/polling in this process.
// Run through demo.py check-telegram; never included in the ordinary dry-run checks.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const database = 'zt_telegram_check_' + crypto.randomBytes(6).toString('hex');
const admin = new Pool({ connectionString: credentials.migration_url });
const current = new Pool({ connectionString: credentials.app_url });
let created = false, currentClosed = false, testAdmin, server, closeDatabasePool, telegram;
const sending = [];

async function main() {
  assert.equal(process.env.TELEGRAM_MODE, 'live', 'live mode must be configured explicitly');
  assert.ok(process.env.TELEGRAM_BOT_TOKEN, 'bot token must be configured');
  const recipient = (await current.query("SELECT value FROM system_settings WHERE key='telegram_paired_chat_id'")).rows[0]?.value;
  assert.ok(recipient, 'pair with the bot first');
  await current.end();
  currentClosed = true;
  await admin.query(`CREATE DATABASE ${database}`);
  created = true;
  const migration = new URL(credentials.migration_url);
  const runtime = new URL(credentials.app_url);
  migration.pathname = runtime.pathname = '/' + database;
  process.env.MIGRATION_DATABASE_URL = migration.toString();
  process.env.DATABASE_URL = runtime.toString();
  process.env.NODE_ENV = 'test';
  process.env.CPU_ALERT_THRESHOLD_PERCENT = '85';
  testAdmin = new Pool({ connectionString: migration.toString() });
  await require('./dist/services/migration-runner.js').runMigrations();
  ({ closeDatabasePool } = require('./dist/services/db.js'));
  ({ telegramService: telegram } = require('./dist/services/telegram.js'));
  // Copies the authorized recipient only into the temporary DB. Does not start polling.
  assert.equal(await telegram.pairWithOtp(recipient, telegram.getPairOtp()), true);
  const realSend = telegram.sendAlert.bind(telegram);
  telegram.sendAlert = (...args) => {
    const result = realSend(...args); // Observe the real transport; no fetch/DB mocks.
    sending.push(result);
    return result;
  };
  server = await require('./dist/server.js').buildServer();
  const token = crypto.randomBytes(32).toString('hex');
  const node = (await testAdmin.query(
    `INSERT INTO nodes (name,ip_address,token_hash,token_prefix,status,last_seen)
     VALUES ('TEST_GIA_LAP_CPU','10.100.0.99',$1,$2,'HEALTHY',now()) RETURNING id`,
    [crypto.createHash('sha256').update(token).digest('hex'), token.slice(0,8)],
  )).rows[0];
  const beacon = (cpu) => server.inject({ method: 'POST', url: '/api/telemetry/beacon',
    headers: { 'x-node-token': token }, payload: {
      node_id: 'TEST_GIA_LAP_CPU', timestamp: Date.now(), metrics: {
        cpu: { percent: cpu }, memory: { total_bytes: 1000, used_bytes: 100, percent: 10 },
        disk: { total_bytes: 1000, used_bytes: 100, percent: 10 },
        network: { rx_bytes_total: 100, tx_bytes_total: 100 }, uptime_seconds: 10,
      },
    },
  });
  console.log('Scope: CPU99% synthetic in a temporary DB; node TEST_GIA_LAP_CPU; one real Telegram alert to the OTP-paired chat.');
  assert.equal((await beacon(99)).statusCode, 200);
  assert.equal((await beacon(99)).statusCode, 200);
  assert.equal(sending.length, 1, 'repeated high beacons must not spam Telegram');
  assert.equal(await sending[0], true, 'Telegram must acknowledge the real send');
  assert.equal((await testAdmin.query("SELECT count(*)::int n FROM alerts WHERE node_id=$1 AND resolved=false",[node.id])).rows[0].n, 1);
  assert.equal((await testAdmin.query("SELECT count(*)::int n FROM audit_logs WHERE node_id=$1 AND action='CPU_HIGH'",[node.id])).rows[0].n, 1);
  assert.equal((await beacon(10)).statusCode, 200);
  assert.equal((await testAdmin.query('SELECT count(*)::int n FROM alerts WHERE node_id=$1 AND resolved=false',[node.id])).rows[0].n, 0);
  assert.equal(sending.length, 1);
  console.log('PASS CPU synthetic -> real SQL incident/audit -> real sendAlert/Telegram API acknowledgement; dedup and recovery verified.');
}

main().catch((error) => { console.error('FAIL Telegram live:', error.message); process.exitCode = 1; }).finally(async () => {
  await Promise.allSettled(sending);
  telegram?.stop();
  if (server) await server.close();
  if (closeDatabasePool) await closeDatabasePool();
  if (testAdmin) await testAdmin.end();
  if (!currentClosed) await current.end();
  if (created) await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
});
