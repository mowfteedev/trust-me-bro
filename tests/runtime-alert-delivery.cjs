#!/usr/bin/env node
/** Opt-in real PostgreSQL proof; Telegram transport is always fake in this process. */
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { Pool } = require('../gateway/node_modules/pg');

async function main() {
  assert.equal(process.env.ZT_ALLOW_ISOLATED_DB_TEST, '1', 'Run only against an explicitly isolated test DB');
  assert.ok(process.env.ALERT_TEST_DATABASE_URL && process.env.ALERT_TEST_ADMIN_DATABASE_URL,
    'Set ALERT_TEST_DATABASE_URL (zt_app) and ALERT_TEST_ADMIN_DATABASE_URL (owner)');
  assert.equal(new URL(process.env.ALERT_TEST_DATABASE_URL).pathname,
    new URL(process.env.ALERT_TEST_ADMIN_DATABASE_URL).pathname, 'Use the same isolated database');
  Object.assign(process.env, {
    DATABASE_URL: process.env.ALERT_TEST_DATABASE_URL, NODE_ENV: 'test',
    JWT_SECRET: 'isolated-alert-test-secret-never-use-live-0000', TELEGRAM_MODE: 'live',
    TELEGRAM_BOT_TOKEN: 'isolated-fake-token', TELEGRAM_PAIR_OTP: '619284',
  });
  let transportCalls = 0;
  const transportTexts = [];
  let result = 'SENT';
  global.fetch = async (_url, options) => {
    transportTexts.push(JSON.parse(options.body).text);
    transportCalls++;
    if (result === 'RETRY') throw new Error('fake network outage');
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: transportCalls } }) };
  };
  const imported = async name => import(pathToFileURL(path.resolve(__dirname, `../gateway/dist/${name}.js`)).href);
  const { telegramService } = await imported('services/telegram');
  const { enqueueAlertNotification, runAlertDeliveryCycle, stopAlertDelivery } = await imported('services/alert-delivery');
  const { pool } = await imported('services/db');
  const admin = new Pool({ connectionString: process.env.ALERT_TEST_ADMIN_DATABASE_URL });
  const nodeId = randomUUID();
  const userId = randomUUID();
  const nodeToken = randomUUID();
  let app;
  const fixtureIds = [];
  let checks = 0;
  async function verify(label, callback) { await callback(); checks++; console.log(`PASS ${label}`); }
  async function newAlert() {
    const row = await admin.query("INSERT INTO alerts (node_id,severity,message) VALUES ($1,'WARNING','TEST_ALERT: isolated test') RETURNING id", [nodeId]);
    fixtureIds.push(row.rows[0].id); return row.rows[0].id;
  }
  async function enqueue(id) {
    const tx = await pool.connect();
    try { await tx.query('BEGIN'); await enqueueAlertNotification(tx, id, 'OPEN', 'Isolated fixture — fake Telegram'); await tx.query('COMMIT'); }
    finally { tx.release(); }
  }
  async function read(id) { return (await admin.query('SELECT * FROM alert_notifications WHERE alert_id=$1', [id])).rows[0]; }
  try {
    assert.equal((await pool.query('SELECT current_user')).rows[0].current_user, 'zt_app');
    assert.equal(Number((await admin.query("SELECT count(*) FROM alert_notifications WHERE status IN ('PENDING','PROCESSING')")).rows[0].count), 0,
      'Queue must be empty in this isolated DB before the test');
    await admin.query("INSERT INTO nodes (id,name,ip_address,node_type,token_hash,token_prefix,status) VALUES ($1,$2,$4,'VM',$3,'testhash','HEALTHY')",
      [nodeId, `isolated-alert-${nodeId.slice(0,8)}`, createHash('sha256').update(nodeToken).digest('hex'), `10.199.${parseInt(nodeId.slice(0,2),16)}.${parseInt(nodeId.slice(2,4),16)}`]);
    // No other recipient is permitted, even in an accidentally shared test database.
    const settings = await admin.query("SELECT value FROM system_settings WHERE key='telegram_paired_chat_id'");
    assert.ok(settings.rows.length === 0 || settings.rows[0].value === 'isolated-alert-test-chat', 'Unexpected paired recipient in test DB');
    await telegramService.pairWithOtp('isolated-alert-test-chat', telegramService.getPairOtp());

    await verify('zt_app cannot DELETE queue rows', async () => {
      const privileges = await pool.query("SELECT has_table_privilege(current_user,'alert_notifications','DELETE') AS can_delete");
      assert.equal(privileges.rows[0].can_delete, false);
    });
    await verify('notification intent rolls back with its incident transaction', async () => {
      const id = await newAlert(), tx = await pool.connect();
      try { await tx.query('BEGIN'); await enqueueAlertNotification(tx, id, 'OPEN', 'Rolled back'); await tx.query('ROLLBACK'); }
      finally { tx.release(); }
      assert.equal(await read(id), undefined);
    });
    await verify('unique incident/phase survives concurrent enqueue', async () => {
      const id = await newAlert(); await Promise.all([enqueue(id), enqueue(id)]);
      assert.equal(Number((await admin.query('SELECT count(*) FROM alert_notifications WHERE alert_id=$1',[id])).rows[0].count),1);
      await runAlertDeliveryCycle(); assert.equal((await read(id)).status,'SENT');
    });
    await verify('concurrent worker cycles send committed intent once', async () => {
      const id = await newAlert(); await enqueue(id); const before=transportCalls;
      await Promise.all([runAlertDeliveryCycle(),runAlertDeliveryCycle(),runAlertDeliveryCycle()]);
      assert.equal(transportCalls-before,1); assert.equal((await read(id)).attempts,1);
    });
    await verify('expired claim resumes after a simulated Gateway crash', async () => {
      const id=await newAlert(); await enqueue(id);
      await admin.query("UPDATE alert_notifications SET status='PROCESSING', attempts=1,next_attempt_at=now()-interval '1 minute' WHERE alert_id=$1",[id]);
      await runAlertDeliveryCycle(); const row=await read(id); assert.equal(row.status,'SENT'); assert.equal(row.attempts,2);
    });
    await verify('active lease is not stolen', async () => {
      const id=await newAlert(); await enqueue(id);
      await admin.query("UPDATE alert_notifications SET status='PROCESSING',attempts=1,next_attempt_at=now()+interval '1 minute' WHERE alert_id=$1",[id]);
      const before=transportCalls; await runAlertDeliveryCycle(); assert.equal(transportCalls,before);
      await admin.query("UPDATE alert_notifications SET next_attempt_at=now()-interval '1 minute' WHERE alert_id=$1",[id]);
      await runAlertDeliveryCycle();
    });
    await verify('interrupted final attempt becomes FAILED after lease expiry', async () => {
      const id=await newAlert(); await enqueue(id);
      await admin.query("UPDATE alert_notifications SET status='PROCESSING',attempts=3,next_attempt_at=now()-interval '1 minute' WHERE alert_id=$1",[id]);
      const before=transportCalls; await runAlertDeliveryCycle(); const row=await read(id);
      assert.equal(row.status,'FAILED'); assert.equal(row.last_error,'ATTEMPT_INTERRUPTED'); assert.equal(transportCalls,before);
    });
    await verify('temporary Telegram outage exhausts exactly three durable attempts', async () => {
      result='RETRY'; const id=await newAlert(); await enqueue(id); const before=transportCalls;
      for(let i=0;i<3;i++) {
        await runAlertDeliveryCycle();
        await admin.query("UPDATE alert_notifications SET next_attempt_at=now()-interval '1 minute' WHERE alert_id=$1",[id]);
      }
      const row=await read(id); assert.equal(row.status,'FAILED'); assert.equal(row.attempts,3); assert.equal(transportCalls-before,3);
      await runAlertDeliveryCycle(); assert.equal(transportCalls-before,3); result='SENT';
    });
    await verify('recovery waits for an opening notification still retrying', async () => {
      const id=await newAlert(); await enqueue(id);
      const tx=await pool.connect();
      try { await enqueueAlertNotification(tx,id,'RECOVERY','Recovery ordering fixture'); }
      finally { tx.release(); }
      await admin.query("UPDATE alert_notifications SET next_attempt_at=now()+interval '1 minute' WHERE alert_id=$1 AND phase='OPEN'",[id]);
      const before=transportCalls; await runAlertDeliveryCycle(); assert.equal(transportCalls,before);
      await admin.query("UPDATE alert_notifications SET next_attempt_at=now()-interval '1 minute' WHERE alert_id=$1 AND phase='OPEN'",[id]);
      await runAlertDeliveryCycle(); assert.equal(transportCalls-before,2);
      assert.equal(transportTexts.at(-1),'Recovery ordering fixture');
      const statuses=await admin.query('SELECT status FROM alert_notifications WHERE alert_id=$1',[id]);
      assert.ok(statuses.rows.every(row=>row.status==='SENT'));
    });
    await verify('real API persists CPU recovery once and exposes incident status to Viewer', async () => {
      const { buildServer } = await imported('app');
      app = await buildServer();
      await admin.query("INSERT INTO users (id,username,password_hash,role,is_active) VALUES ($1,$2,'unused-test-hash','VIEWER',true)",
        [userId, `alert-viewer-${userId.slice(0,8)}`]);
      const name=(await admin.query('SELECT name FROM nodes WHERE id=$1',[nodeId])).rows[0].name;
      const token=app.jwt.sign({ id:userId, username:`alert-viewer-${userId.slice(0,8)}`,role:'VIEWER',session_version:1,jti:randomUUID() },{expiresIn:'10m'});
      async function beacon(cpu) {
        const response=await app.inject({method:'POST',url:'/api/telemetry/beacon',headers:{'x-node-token':nodeToken},payload:{
          node_id:name,timestamp:Date.now(),metrics:{cpu:{percent:cpu},memory:{total_bytes:100,used_bytes:40,percent:40},
          disk:{total_bytes:100,used_bytes:20,percent:20},network:{rx_bytes_total:10,tx_bytes_total:20},uptime_seconds:60}
        }});
        assert.equal(response.statusCode,200,response.body);
      }
      for(const cpu of [95,96,80,74,73]) await beacon(cpu);
      const incidents=await admin.query("SELECT * FROM alerts WHERE node_id=$1 AND message LIKE 'CPU_HIGH:%' AND message!='TEST_ALERT: isolated test'",[nodeId]);
      assert.equal(incidents.rowCount,1); const incident=incidents.rows[0]; fixtureIds.push(incident.id);
      assert.ok(incident.resolved_at);
      const notifications=await admin.query('SELECT phase,status FROM alert_notifications WHERE alert_id=$1 ORDER BY phase',[incident.id]);
      assert.deepEqual(notifications.rows.map(row=>row.phase),['OPEN','RECOVERY']);
      assert.ok(notifications.rows.every(row=>row.status==='PENDING'));
      await runAlertDeliveryCycle();
      const response=await app.inject({method:'GET',url:`/api/incidents/?state=resolved&node_id=${nodeId}`,headers:{authorization:`Bearer ${token}`}});
      assert.equal(response.statusCode,200,response.body);
      const data=response.json().data.find(row=>row.id===incident.id);
      assert.equal(data.type,'CPU_HIGH'); assert.equal(data.opening_delivery.status,'SENT');
      assert.equal(data.recovery_delivery.status,'SENT'); assert.ok(data.duration_seconds>=0);
      assert.equal((await app.inject({method:'GET',url:'/api/incidents/'})).statusCode,401);
      assert.equal((await app.inject({method:'GET',url:'/api/incidents'})).statusCode,401);
    });
    console.log(JSON.stringify({suite:'alert-delivery',database:'real PostgreSQL',telegram:'FAKE FETCH ONLY',checks,transportCalls}));
  } finally {
    await stopAlertDelivery(); telegramService.stop();
    await app?.close();
    if(fixtureIds.length) await admin.query('DELETE FROM alerts WHERE id=ANY($1::uuid[])',[fixtureIds]);
    // Real incident audits are append-only even in this disposable DB. Keep their fixture node.
    await admin.query('DELETE FROM nodes WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE node_id=$1)',[nodeId]);
    await admin.query('DELETE FROM users WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE user_id=$1)',[userId]);
    await admin.query("DELETE FROM system_settings WHERE key='telegram_paired_chat_id' AND value='isolated-alert-test-chat'");
    await pool.end(); await admin.end();
  }
}
main().catch(error => { console.error('FAIL alert delivery integration:',error.message);process.exitCode=1; });
