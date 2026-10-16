// Fastify inject + PostgreSQL thật; audit fixtures chỉ ở DB tạm, không vào dashboard demo.
// demo.py truyền credentials qua stdin, chỉ tạo/xóa DB ngẫu nhiên do test này sở hữu.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const database = 'zt_audit_check_' + crypto.randomBytes(6).toString('hex');
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
  // Injected peer addresses test the trust boundary in this isolated DB/server only.
  process.env.TRUSTED_PROXY_IP = '198.51.100.10';
  testAdmin = new Pool({ connectionString: migration.toString() });
  await require('./dist/services/migration-runner.js').runMigrations();
  ({ closeDatabasePool } = require('./dist/services/db.js'));
  const { hashPassword, hashToken } = require('./dist/utils/crypto.js');
  const password = crypto.randomBytes(16).toString('hex');
  const ids = {};
  for (const [name, role] of [['audit-admin', 'ADMIN'], ['audit-viewer', 'VIEWER']]) {
    ids[name] = (await testAdmin.query('INSERT INTO users (username,password_hash,role,is_active) VALUES ($1,$2,$3,true) RETURNING id', [name, hashPassword(password), role])).rows[0].id;
  }
  const node = (await testAdmin.query('INSERT INTO nodes (name,ip_address,node_type,token_hash,token_prefix) VALUES ($1,$2,$3,$4,$5) RETURNING id', ['audit%_!worker', '10.100.0.70', 'DOCKER', hashToken('isolated-audit-fixture'), 'isolated'])).rows[0];
  for (let i = 0; i < 30; i++) {
    await testAdmin.query(`INSERT INTO audit_logs (user_id,action,target,details,ip_address,created_at)
      VALUES ($1,'BASTION_SESSION_START','bastion',$2,'127.0.0.1','2026-01-01T00:00:00Z')`,
      [ids['audit-admin'], JSON.stringify({ node_id: node.id, session_id: 'fixture-' + i, target_ip: '10.100.0.70', token: 'PRIVATE_SENTINEL_TOKEN', password: 'PRIVATE_SENTINEL_PASSWORD', user_agent: 'PRIVATE_SENTINEL_AGENT' })]);
  }
  await testAdmin.query(`INSERT INTO audit_logs (node_id,action,target,details) VALUES
    ($1,'CPU_HIGH','audit%_!worker',$2),($1,'NODE_OFFLINE','audit%_!worker',$3)`,
    [node.id, JSON.stringify({ cpu_percent: 99.5, threshold: 85 }), JSON.stringify({ ip: '10.100.0.70', last_seen: '2026-01-01T00:00:00Z' })]);
  await testAdmin.query("INSERT INTO audit_logs (action,target,details) VALUES ('LEGACY_EVENT','legacy-missing',$1)", [JSON.stringify({ node_id: 'not-a-uuid', token: 'PRIVATE_SENTINEL_TOKEN' })]);
  server = await require('./dist/server.js').buildServer();
  const failedLogin = (remoteAddress, forwarded, username = 'unknown-audit-user') => server.inject({
    method: 'POST', url: '/api/auth/login', remoteAddress,
    headers: { 'x-forwarded-for': forwarded },
    payload: { username, password: 'PRIVATE_SENTINEL_WRONG_PASSWORD' },
  });
  assert.equal((await failedLogin('203.0.113.10', '192.0.2.99')).statusCode, 401);
  assert.equal((await failedLogin('198.51.100.10', '192.0.2.30')).statusCode, 401);
  let failed = (await testAdmin.query("SELECT host(ip_address) AS ip,details,user_id FROM audit_logs WHERE action='LOGIN_FAILED' ORDER BY created_at")).rows;
  assert.deepEqual(failed.map((row) => row.ip), ['203.0.113.10', '192.0.2.30']);
  assert.ok(failed.every((row) => row.user_id === null && row.details.attempted_username === 'unknown-audit-user' && !JSON.stringify(row).includes('PRIVATE_SENTINEL')));
  for (let i = 0; i < 11; i++) {
    const response = await failedLogin('203.0.113.11', '192.0.2.' + (i + 1), 'rate-limit-probe');
    assert.equal(response.statusCode, i < 10 ? 401 : 429);
  }
  assert.equal((await testAdmin.query("SELECT count(*)::int n FROM audit_logs WHERE action='LOGIN_FAILED' AND details->>'attempted_username'='rate-limit-probe'")).rows[0].n, 10);
  console.log('PASS LOGIN_FAILED lưu SQL thật không có secrets; IP trực tiếp không tin XFF, proxy chỉ định được tin; 429 trước ghi audit');
  const login = async (username) => {
    const response = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    assert.equal(response.statusCode, 200);
    return response.json().token;
  };
  const token = await login('audit-admin');
  const viewer = await login('audit-viewer');
  const get = (suffix = '', auth = token) => server.inject({ method: 'GET', url: '/api/audit/logs' + suffix, headers: auth ? { authorization: 'Bearer ' + auth } : {} });
  assert.equal((await get('', null)).statusCode, 401);
  assert.equal((await get('', viewer)).statusCode, 403);
  console.log('PASS audit401/Viewer403/Admin200 với middleware + PostgreSQL thật');
  const failures = (await get('?action=LOGIN_FAILED&q=unknown-audit-user')).json().data;
  assert.equal(failures.length, 2);
  assert.ok(failures.every((row) => row.details.attempted_username === 'unknown-audit-user'));
  const appPool = new Pool({ connectionString: runtime.toString() });
  try {
    for (const sql of ['UPDATE audit_logs SET action=action', 'DELETE FROM audit_logs', 'TRUNCATE audit_logs']) {
      await assert.rejects(appPool.query(sql), (error) => error.code === '42501');
    }
  } finally { await appPool.end(); }
  console.log('PASS tìm LOGIN_FAILED qua API; role zt_app bị PostgreSQL từ chối UPDATE/DELETE/TRUNCATE audit');
  const reconcileCases = [
    { session: crypto.randomUUID(), start: true, ip: '203.0.113.41' },
    { session: crypto.randomUUID(), start: true, ip: null },
    { session: crypto.randomUUID(), start: false, ip: null },
  ];
  for (const item of reconcileCases) {
    if (item.start) await testAdmin.query(
      "INSERT INTO audit_logs (user_id,action,target,details,ip_address) VALUES ($1,'BASTION_SESSION_START','bastion',$2,$3::inet)",
      [ids['audit-admin'], JSON.stringify({ session_id: item.session, node_id: node.id }), item.ip]);
    await testAdmin.query(`INSERT INTO bastion_session_leases (session_id,user_id,node_id,instance_id,lease_expires_at,status)
      VALUES ($1,$2,$3,'isolated-reconcile',now()-interval '1 minute','ACTIVE')`, [item.session, ids['audit-admin'], node.id]);
  }
  // Earlier START belonging to another user must not supply the reconciled IP.
  await testAdmin.query("INSERT INTO audit_logs (user_id,action,target,details,ip_address,created_at) VALUES ($1,'BASTION_SESSION_START','bastion',$2,'192.0.2.99',now()-interval '1 day')",
    [ids['audit-viewer'], JSON.stringify({ session_id: reconcileCases[0].session })]);
  const { runSweeperCycle } = require('./dist/services/sweeper.js');
  await runSweeperCycle();
  await runSweeperCycle();
  for (const item of reconcileCases) {
    const ends = (await testAdmin.query("SELECT host(ip_address) AS ip FROM audit_logs WHERE action='BASTION_SESSION_END' AND details->>'session_id'=$1", [item.session])).rows;
    assert.equal(ends.length, 1);
    assert.equal(ends[0].ip, item.ip);
    assert.equal((await testAdmin.query('SELECT status FROM bastion_session_leases WHERE session_id=$1', [item.session])).rows[0].status, 'RECONCILED');
  }
  console.log('PASS reconciler SQL thật: END giữ IP START cùng user/session, thiếu IP/START lưu null, chạy lại không lặp END');
  for (const page of [1, 2]) {
    const response = await get('?page=' + page);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const result = response.json();
    const expected = (await testAdmin.query('SELECT id FROM audit_logs ORDER BY created_at DESC,id DESC LIMIT 26 OFFSET $1', [(page - 1) * 25])).rows;
    assert.deepEqual(result.data.map((row) => row.id), expected.slice(0, 25).map((row) => row.id));
    assert.equal(result.has_more, expected.length > 25);
    assert.equal(result.page_size, 25);
    assert.ok(!response.body.includes('PRIVATE_SENTINEL'));
  }
  console.log('PASS SQL thật: phân trang25, timestamp trùng được sắp theoUUID, no-store và không lộ raw secrets');
  let response = await get('?action=BASTION_SESSION_START&q=10.100.0.70');
  assert.equal(response.json().data.length, 25);
  assert.ok(response.json().data.every((row) => row.node_id === node.id && row.node_name === 'audit%_!worker'));
  response = await get('?q=' + encodeURIComponent('%_!'));
  assert.equal(response.json().data.length, 25);
  assert.ok(response.json().data.every((row) => row.node_name === 'audit%_!worker'));
  assert.equal((await get('?q=' + encodeURIComponent("' OR 1=1 --"))).json().data.length, 0);
  console.log('PASS tìm VPNIP, nối node legacy JSON, literalLIKE %,_,! và chốngSQL injection (DB thật)');
  const cpu = (await get('?action=CPU_HIGH')).json().data;
  assert.equal(cpu.length, 1);
  assert.deepEqual(cpu[0].details, { cpu_percent: 99.5, threshold: 85 });
  const offline = (await get('?action=NODE_OFFLINE')).json().data;
  assert.equal(offline.length, 1);
  assert.deepEqual(offline[0].details, { ip: '10.100.0.70', last_seen: '2026-01-01T00:00:00Z' });
  const legacy = (await get('?q=legacy-missing')).json().data;
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].node_id, null);
  assert.deepEqual(legacy[0].details, {});
  console.log('PASS CPU/offline details được giữ đúng kiểu; nodeJSON saiUUID không gây500');
  for (const query of ['?page=0', '?page=1.5', '?page=10001', '?action=DELETE', '?q=' + 'x'.repeat(101)]) assert.equal((await get(query)).statusCode, 400);
  for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await server.inject({ method, url: '/api/audit/logs', headers: { authorization: 'Bearer ' + token } })).statusCode, 404);
  const logout = await server.inject({ method: 'POST', url: '/api/auth/logout', headers: { authorization: 'Bearer ' + token } });
  assert.equal(logout.statusCode, 200);
  assert.equal((await get()).statusCode, 401);
  assert.ok((await testAdmin.query("SELECT id FROM audit_logs WHERE user_id=$1 AND action='LOGOUT_SUCCESS'", [ids['audit-admin']])).rows.length > 0);
  console.log('PASS validation, không có API sửa/xóa, logout ghiDB và thu hồi quyền đọc củaJWT cũ');
  console.log('Audit fixtures chỉ ở DB tạm; không phải bằng chứng SSH/CPU vật lý. Browser + cụm demo kiểm tra riêng.');
}
main().catch((error) => { console.error('FAIL:', error.message); process.exitCode = 1; }).finally(async () => {
  if (server) await server.close();
  if (closeDatabasePool) await closeDatabasePool();
  if (testAdmin) await testAdmin.end();
  if (created) await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
});
