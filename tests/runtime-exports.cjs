#!/usr/bin/env node
/** Isolated PostgreSQL 16 + actual routes/JWT/hash. No deployment or Telegram. */
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'gateway');
const readerPython = process.env.ZT_EXPORT_READER_PYTHON || 'python3';
const image = process.env.ZT_TEST_POSTGRES_IMAGE || 'postgres:16-alpine';
const id = crypto.randomBytes(6).toString('hex');
const container = `zt-exports-lab-${id}`;
const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-exports-'));
fs.chmodSync(privateDir, 0o700);
const adminPassword = crypto.randomBytes(24).toString('hex');
const appPassword = crypto.randomBytes(24).toString('hex');
const password = crypto.randomBytes(20).toString('hex');
const envFile = path.join(privateDir, 'postgres.env');
fs.writeFileSync(envFile, `POSTGRES_USER=zt_admin\nPOSTGRES_PASSWORD=${adminPassword}\nPOSTGRES_DB=zt_serverops\n`, { mode: 0o600 });
const docker = (...args) => {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) {
    const detail = String(error.stderr || 'Docker command failed').split('\n')[0];
    throw Object.assign(new Error(detail), { code: 'DOCKER_LAB_FAILURE' });
  }
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
let created = false;
let app;
let admin;
let appPool;
let stage = 'start container';

async function check(name, action) {
  stage = name;
  await action(); results.push({ name, status: 'PASS' }); console.log(`PASS ${name}`);
}

async function main() {
  assert.equal(spawnSync(readerPython, ['-c', 'import openpyxl'], { stdio: 'ignore' }).status, 0,
    'Install tests/requirements.txt in an isolated Python environment; set ZT_EXPORT_READER_PYTHON to its python.');
  assert(fs.existsSync(path.join(runtime, 'dist/routes/audit.js')), 'Run npm --prefix gateway run build first');
  docker('run', '--detach', '--name', container, '--label', 'zt.lab=exports', '--memory', '256m',
    '--env-file', envFile, '-p', '127.0.0.1::5432', image,
    'postgres', '-c', 'shared_buffers=16MB', '-c', 'max_connections=15');
  created = true;
  stage = 'wait for PostgreSQL';
  const deadline = Date.now() + 30000;
  while (true) {
    // The image uses a temporary Unix-socket server during initialization; wait
    // for TCP so that migration never races that server's shutdown.
    const ready = spawnSync('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'zt_admin', '-d', 'zt_serverops'], { stdio: 'ignore' });
    if (ready.status === 0) break;
    assert(Date.now() < deadline, 'Isolated PostgreSQL readiness timeout');
    await wait(150);
  }
  const port = docker('port', container, '5432/tcp').split(':').at(-1);
  stage = 'load dependencies and migrations';
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `postgresql://zt_app:${appPassword}@127.0.0.1:${port}/zt_serverops`;
  process.env.MIGRATION_DATABASE_URL = `postgresql://zt_admin:${adminPassword}@127.0.0.1:${port}/zt_serverops`;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.TELEGRAM_MODE = 'disabled';
  process.env.ALLOW_DEFAULT_SEED = 'false';
  const oldCwd = process.cwd();
  process.chdir(runtime);
  const { Pool } = require(path.join(runtime, 'node_modules/pg'));
  admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
  await require(path.join(runtime, 'dist/services/migration-runner.js')).runMigrations();
  const setPassword = await admin.query("SELECT format('ALTER ROLE zt_app PASSWORD %L', $1::text) AS statement;", [appPassword]);
  await admin.query(setPassword.rows[0].statement);
  const { hashPassword } = require(path.join(runtime, 'dist/utils/crypto.js'));
  const fixtures = await admin.query(`INSERT INTO users (username, password_hash, role)
    VALUES ('export-admin', $1, 'ADMIN'), ('export-viewer', $1, 'VIEWER') RETURNING id, username, role;`, [hashPassword(password)]);
  const adminUser = fixtures.rows.find(row => row.role === 'ADMIN');
  const viewerUser = fixtures.rows.find(row => row.role === 'VIEWER');
  const seedNode = async name => (await admin.query(`INSERT INTO nodes (name, ip_address, token_hash, token_prefix)
    VALUES ($1, $2, $3, $4) RETURNING id;`, [name, name === 'export-node' ? '10.100.0.2' : '10.100.0.3',
    crypto.randomBytes(32).toString('hex'), crypto.randomBytes(4).toString('hex')])).rows[0].id;
  const nodeId = await seedNode('export-node'); const otherNodeId = await seedNode('export-other-node');
  await admin.query(`INSERT INTO audit_logs (user_id, node_id, action, target, details, created_at)
    SELECT $1, $2, 'LOGIN_FAILED', '=HYPERLINK("https://example.com")',
      jsonb_build_object('attempted_username', 'literal%_!-' || i, 'password', 'MUST_NOT_EXPORT_PASSWORD', 'token', 'MUST_NOT_EXPORT_TOKEN'),
      TIMESTAMPTZ '2026-11-17 00:00:00+00' + i * INTERVAL '1 second' FROM generate_series(1,40) i;`, [adminUser.id, nodeId]);
  await admin.query(`INSERT INTO audit_logs (action, target, details)
    VALUES ('LOGIN_SUCCESS', 'other-filter', '{}'), ('AUDIT_PURGED', 'history-retained', '{"deleted_count":1}');`);
  await admin.query(`INSERT INTO alerts (node_id, severity, message, triggered_at, resolved_at)
    SELECT $1, 'WARNING', '=SUM(1,2)', TIMESTAMPTZ '2026-11-17 00:00:00+00',
      CASE WHEN i % 3 = 0 THEN TIMESTAMPTZ '2026-11-17 00:00:42+00' ELSE NULL END
      FROM generate_series(1,32) i;`, [nodeId]);
  await admin.query(`INSERT INTO alerts (node_id, severity, message) VALUES ($1, 'CRITICAL', 'OTHER_NODE');`, [otherNodeId]);
  await admin.query(`INSERT INTO alert_notifications (alert_id, phase, text, status, attempts)
    SELECT id, 'OPEN', 'MUST_NOT_EXPORT_BOT_PAYLOAD', 'SENT', 1 FROM alerts;`);
  const Fastify = require(path.join(runtime, 'node_modules/fastify'));
  app = Fastify();
  await app.register(require(path.join(runtime, 'node_modules/@fastify/jwt')), { secret: process.env.JWT_SECRET });
  await app.register(require(path.join(runtime, 'dist/routes/audit.js')).auditRoutes, { prefix: '/api/audit' });
  await app.register(require(path.join(runtime, 'dist/routes/incidents.js')).incidentsRoutes, { prefix: '/api/incidents' });
  appPool = require(path.join(runtime, 'dist/services/db.js')).pool;
  const token = user => app.jwt.sign({ ...user, session_version: 1, jti: crypto.randomUUID() }, { expiresIn: '1h' });
  const adminToken = token(adminUser); const viewerToken = token(viewerUser);
  const call = (method, url, jwt, payload) => app.inject({ method, url,
    headers: jwt ? { authorization: `Bearer ${jwt}` } : {}, payload });
  const evidenceDir = process.env.ZT_EXPORT_EVIDENCE_DIR || privateDir;
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  function readWorkbook(response, filename) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert(response.headers['content-disposition'].endsWith('.xlsx"'));
    const file = path.join(evidenceDir, filename); fs.writeFileSync(file, response.rawPayload, { mode: 0o600 });
    // Independent ZIP CRC/XML parser plus a real XLSX reader, isolated test tool only.
    const program = `import sys,json,zipfile,xml.etree.ElementTree as ET
from openpyxl import load_workbook
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 for name in z.namelist():
  if name.endswith('.xml') or name.endswith('.rels'): ET.fromstring(z.read(name))
 all_xml=b''.join(z.read(name) for name in z.namelist())
 assert b'MUST_NOT_EXPORT' not in all_xml
w=load_workbook(sys.argv[1],read_only=True,data_only=False)
s=w.active
rows=list(s.iter_rows())
assert not any(c.data_type=='f' for row in rows for c in row)
print(json.dumps({'rows':len(rows),'columns':len(rows[0]),'literal':sum(isinstance(c.value,str) and c.value.startswith('=') for row in rows for c in row),'numeric':sum(c.data_type=='n' and c.value is not None for row in rows[1:] for c in row),'vietnam_time':any(isinstance(c.value,str) and '07:00:' in c.value for row in rows for c in row)}))
`;
    return JSON.parse(execFileSync(readerPython, ['-c', program, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  }
  const baseline = (await admin.query('SELECT count(*)::int AS n FROM audit_logs;')).rows[0].n;
  await check('migration 014 removes purge function without removing historical audit rows', async () => {
    assert.equal((await admin.query("SELECT to_regprocedure('public.purge_audit_logs(interval,uuid,inet)') AS function;")).rows[0].function, null);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM schema_migrations;")).rows[0].n,
      fs.readdirSync(path.join(runtime, 'migrations')).filter(name => name.endsWith('.sql')).length);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='AUDIT_PURGED';")).rows[0].n, 1);
  });
  await check('Admin/Viewer purge and preview endpoints are gone', async () => {
    for (const jwt of [adminToken, viewerToken]) {
      assert.equal((await call('GET', '/api/audit/logs/purge-preview?retention=1d', jwt)).statusCode, 404);
      assert.equal((await call('DELETE', '/api/audit/logs', jwt, { retention: '1d' })).statusCode, 404);
    }
  });
  await check('runtime role cannot mutate or truncate audit logs', async () => {
    for (const statement of ['UPDATE audit_logs SET action=action', 'DELETE FROM audit_logs', 'TRUNCATE audit_logs']) {
      await assert.rejects(appPool.query(statement), error => error.code === '42501');
    }
  });
  await check('old purge session flag cannot bypass the immutable trigger even as DB owner', async () => {
    const client = await admin.connect();
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('audit.allow_purge','on',true);");
      await assert.rejects(client.query('DELETE FROM audit_logs'), /append-only/);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  await check('anonymous exports are rejected before data access', async () => {
    for (const url of ['/api/audit/logs/export', '/api/incidents/export']) assert.equal((await call('GET', url)).statusCode, 401);
  });
  await check('Admin audit XLSX includes all 40 literal-filtered results beyond page 1 and no secrets', async () => {
    const filter = '?action=LOGIN_FAILED&q=' + encodeURIComponent('literal%_!');
    const firstPage = await call('GET', '/api/audit/logs' + filter, adminToken);
    assert.equal(firstPage.json().data.length, 25); assert.equal(firstPage.json().has_more, true);
    const parsed = readWorkbook(await call('GET', '/api/audit/logs/export' + filter, adminToken), 'audit-admin.xlsx');
    assert.equal(parsed.rows, 41); assert.equal(parsed.columns, 10); assert.equal(parsed.literal, 40); assert(parsed.vietnam_time);
  });
  await check('Admin can immediately export filtered incidents with numeric durations and literal formula text', async () => {
    const parsed = readWorkbook(await call('GET', `/api/incidents/export?state=resolved&node_id=${nodeId}`, adminToken), 'incidents-admin.xlsx');
    assert.equal(parsed.rows, 11); assert.equal(parsed.columns, 12); assert.equal(parsed.numeric, 10); assert.equal(parsed.literal, 10);
  });
  await check('Viewer can export both kinds and an empty filtered result is a valid workbook', async () => {
    const audit = readWorkbook(await call('GET', '/api/audit/logs/export?q=no-such-audit-row', viewerToken), 'audit-viewer-empty.xlsx');
    assert.equal(audit.rows, 1);
    const incidents = readWorkbook(await call('GET', `/api/incidents/export?state=open&node_id=${nodeId}`, viewerToken), 'incidents-viewer.xlsx');
    assert.equal(incidents.rows, 23); assert.equal(incidents.numeric, 22);
  });
  await check('export is read-only and same-user duplicate requests are rate limited', async () => {
    const response = await call('GET', '/api/audit/logs/export', adminToken);
    assert.equal(response.statusCode, 429); assert(response.headers['retry-after']);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM audit_logs;')).rows[0].n, baseline);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM alerts;')).rows[0].n, 33);
  });
  console.log(`Exports real-PG/XLSX checks: ${results.length} PASS`);
  if (process.env.ZT_EXPORT_EVIDENCE_DIR) fs.writeFileSync(path.join(evidenceDir, 'exports-real-pg.json'), JSON.stringify({
    environment: 'isolated PostgreSQL16 + real zt_app/API/JWT, Python ZIP/XML + openpyxl, no production/VM/Telegram',
    results, timestamp: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
}

main().catch(error => {
  const safe = String(error?.message || error?.code || 'error').replaceAll(adminPassword, '<REDACTED>')
    .replaceAll(appPassword, '<REDACTED>').replaceAll(password, '<REDACTED>').replace(/postgres(?:ql)?:\/\/\S+/g, '<DATABASE_URL>');
  console.error(`Exports lab FAILED (${stage}): ${safe.slice(0, 600)}`); process.exitCode = 1;
}).finally(async () => {
  if (app) await app.close().catch(() => {});
  if (appPool) await appPool.end().catch(() => {});
  if (admin) await admin.end().catch(() => {});
  if (created) { try { docker('rm', '--force', '--volumes', container); } catch { console.error('Lab cleanup needs review'); process.exitCode = 1; } }
  fs.rmSync(privateDir, { recursive: true, force: true });
});
