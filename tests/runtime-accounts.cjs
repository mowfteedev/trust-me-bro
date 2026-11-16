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
const image = process.env.ZT_TEST_POSTGRES_IMAGE || 'postgres:16-alpine';
const id = crypto.randomBytes(6).toString('hex');
const container = `zt-accounts-lab-${id}`;
const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-accounts-'));
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
  assert(fs.existsSync(path.join(runtime, 'dist/routes/users.js')), 'Run npm --prefix gateway run build first');
  docker('run', '--detach', '--name', container, '--label', 'zt.lab=accounts', '--memory', '256m',
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
  const seed = await admin.query(`INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'ADMIN') RETURNING id;`, ['lab-admin', hashPassword(password)]);
  const seedId = seed.rows[0].id;
  const Fastify = require(path.join(runtime, 'node_modules/fastify'));
  app = Fastify();
  await app.register(require(path.join(runtime, 'node_modules/@fastify/jwt')), { secret: process.env.JWT_SECRET });
  await app.register(require(path.join(runtime, 'dist/routes/auth.js')).authRoutes, { prefix: '/api/auth' });
  await app.register(require(path.join(runtime, 'dist/routes/users.js')).usersRoutes, { prefix: '/api/users' });
  appPool = require(path.join(runtime, 'dist/services/db.js')).pool;
  const call = (method, url, token, payload) => app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
  const login = async username => {
    const result = await call('POST', '/api/auth/login', '', { username, password });
    assert.equal(result.statusCode, 200); return result.json().token;
  };
  let a; let b; let viewerId; let viewerToken;
  await check('migration 012 and actual unprivileged runtime role', async () => {
    const role = await appPool.query('SELECT current_user, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user;');
    assert.deepEqual(role.rows[0], { current_user: 'zt_app', rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM schema_migrations WHERE name = '012_auth_session_revocations.sql';")).rows[0].n, 1);
    assert.equal((await appPool.query("SELECT has_table_privilege(current_user, 'public.revoked_auth_sessions', 'SELECT,INSERT,DELETE') AS allowed;")).rows[0].allowed, true);
  });
  await check('two device JWTs: current logout persists one revocation', async () => {
    a = await login('lab-admin'); b = await login('lab-admin');
    assert.notEqual(app.jwt.decode(a).jti, app.jwt.decode(b).jti);
    assert.equal((await call('POST', '/api/auth/logout', a, {})).json().scope, 'current');
    assert.equal((await call('GET', '/api/auth/me', a)).statusCode, 401);
    assert.equal((await call('GET', '/api/auth/me', b)).statusCode, 200);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM revoked_auth_sessions;')).rows[0].n, 1);
  });
  await check('logout-all revokes every JWT; fresh login remains usable', async () => {
    a = await login('lab-admin');
    assert.equal((await call('POST', '/api/auth/logout-all', a, {})).statusCode, 200);
    assert.equal((await call('GET', '/api/auth/me', a)).statusCode, 401);
    assert.equal((await call('GET', '/api/auth/me', b)).statusCode, 401);
    a = await login('lab-admin');
  });
  await check('create user with hashed password, bounded response and durable audit', async () => {
    const result = await call('POST', '/api/users', a, { username: 'lab-viewer', password, role: 'VIEWER' });
    assert.equal(result.statusCode, 201); viewerId = result.json().user.id;
    assert(!result.body.includes('password_hash'));
    const row = (await admin.query('SELECT password_hash FROM users WHERE id = $1;', [viewerId])).rows[0];
    assert.notEqual(row.password_hash, password);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'USER_CREATED' AND target = $1;", [viewerId])).rows[0].n, 1);
    viewerToken = await login('lab-viewer');
  });
  await check('Viewer cannot list/change accounts; self-lockout is rejected', async () => {
    assert.equal((await call('GET', '/api/users', viewerToken)).statusCode, 403);
    assert.equal((await call('PATCH', `/api/users/${seedId}`, viewerToken, { role: 'VIEWER' })).statusCode, 403);
    assert.equal((await call('PATCH', `/api/users/${seedId}`, a, { is_active: false })).statusCode, 409);
  });
  await check('permission update revokes previous JWT immediately', async () => {
    assert.equal((await call('PATCH', `/api/users/${viewerId}`, a, { role: 'ADMIN' })).statusCode, 200);
    assert.equal((await call('GET', '/api/auth/me', viewerToken)).statusCode, 401);
    viewerToken = await login('lab-viewer');
  });
  await check('concurrent crossed demotions retain one active Admin', async () => {
    const outcomes = await Promise.all([
      call('PATCH', `/api/users/${viewerId}`, a, { role: 'VIEWER' }),
      call('PATCH', `/api/users/${seedId}`, viewerToken, { role: 'VIEWER' }),
    ]);
    const statusCodes = outcomes.map(result => result.statusCode);
    assert.equal(statusCodes.filter(status => status === 200).length, 1);
    assert.equal(statusCodes.filter(status => status === 401 || status === 403).length, 1);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM users WHERE role = 'ADMIN' AND is_active;")).rows[0].n, 1);
  });
  const winner = (await admin.query("SELECT id, username FROM users WHERE role = 'ADMIN' AND is_active;")).rows[0];
  const loser = (await admin.query("SELECT id, username, session_version FROM users WHERE role = 'VIEWER';")).rows[0];
  a = await login(winner.username);
  await check('audit rejection rolls back user mutation and version bump', async () => {
    await admin.query(`CREATE FUNCTION public.lab_reject_user_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'USER_UPDATED' THEN RAISE EXCEPTION 'lab forced audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER lab_reject_user_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION public.lab_reject_user_audit();`);
    try {
      const result = await call('PATCH', `/api/users/${loser.id}`, a, { is_active: false });
      assert.equal(result.statusCode, 503); assert(!result.body.includes('lab forced'));
      const row = (await admin.query('SELECT is_active, session_version FROM users WHERE id = $1;', [loser.id])).rows[0];
      assert.equal(row.is_active, true); assert.equal(row.session_version, loser.session_version);
    } finally { await admin.query('DROP TRIGGER lab_reject_user_audit ON audit_logs; DROP FUNCTION public.lab_reject_user_audit();'); }
  });
  await check('password change verifies old password and invalidates all previous devices', async () => {
    const token = await login(loser.username);
    assert.equal((await call('POST', '/api/auth/change-password', token,
      { current_password: 'incorrect-value', new_password: 'replacement-password-123' })).statusCode, 400);
    assert.equal((await call('POST', '/api/auth/change-password', token,
      { current_password: password, new_password: 'replacement-password-123' })).statusCode, 200);
    assert.equal((await call('GET', '/api/auth/me', token)).statusCode, 401);
  });
  await check('no password or token stored in account audit details', async () => {
    const audit = JSON.stringify((await admin.query('SELECT details FROM audit_logs;')).rows);
    assert(!audit.includes(password)); assert(!audit.includes('replacement-password-123'));
    assert(!audit.includes(a));
  });
  process.chdir(oldCwd);
  if (process.env.ZT_ACCOUNT_EVIDENCE_PATH) {
    fs.writeFileSync(process.env.ZT_ACCOUNT_EVIDENCE_PATH, JSON.stringify({
      environment: 'isolated PostgreSQL 16; actual zt_app, routes, JWT and password hashing; no VM/WireGuard/Telegram',
      results, timestamp: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
  }
  console.log(`Accounts real-PG checks: ${results.length} PASS`);
}

main().catch(error => {
  // Do not print connection URLs, credentials, query parameters or full stack.
  const safeMessage = String(error?.message || error?.code || 'error')
    .replaceAll(adminPassword, '<REDACTED>').replaceAll(appPassword, '<REDACTED>')
    .replaceAll(password, '<REDACTED>').replace(/postgres(?:ql)?:\/\/\S+/g, '<DATABASE_URL>');
  console.error(`Accounts lab FAILED (${stage}): ${safeMessage.slice(0, 600)}`);
  process.exitCode = 1;
}).finally(async () => {
  if (app) await app.close().catch(() => {});
  if (appPool) await appPool.end().catch(() => {});
  if (admin) await admin.end().catch(() => {});
  if (created) { try { docker('rm', '--force', '--volumes', container); } catch { console.error('Lab cleanup needs review'); process.exitCode = 1; } }
  fs.rmSync(privateDir, { recursive: true, force: true });
});
