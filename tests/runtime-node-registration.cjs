// Real PostgreSQL + actual local provisioning CLI in an owned temporary DB.
// Host keys/tokens here are test fixtures; this does not certify a Windows VM.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const database = 'zt_registration_' + crypto.randomBytes(6).toString('hex');
const admin = new Pool({ connectionString: credentials.migration_url });
let created = false, db;

async function main() {
  await admin.query(`CREATE DATABASE ${database}`);
  created = true;
  const url = new URL(credentials.migration_url);
  url.pathname = '/' + database;
  process.env.MIGRATION_DATABASE_URL = url.toString();
  process.env.DATABASE_URL = url.toString();
  process.env.TELEGRAM_MODE = 'dry-run';
  await require('./dist/services/migration-runner.js').runMigrations();
  db = new Pool({ connectionString: url.toString() });
  const grantsBefore = (await db.query(`SELECT table_name,privilege_type FROM information_schema.role_table_grants
    WHERE grantee='zt_app' ORDER BY table_name,privilege_type`)).rows;
  const token = crypto.randomBytes(32).toString('base64url');
  const record = { node_name: 'windows-fixture', node_ip: '10.100.0.3', node_type: 'VM',
    node_token: token, host_key_fingerprint: 'SHA256:' + crypto.randomBytes(32).toString('base64').replace(/=+$/, '') };
  const call = (body) => spawnSync(process.execPath, ['dist/scripts/register-node.js'], {
    env: { ...process.env, DATABASE_URL: url.toString() }, input: JSON.stringify(body), encoding: 'utf8', timeout: 15000,
  });
  const original = { node_name: 'docker-existing', node_ip: '10.100.0.2', node_type: 'DOCKER',
    node_token: crypto.randomBytes(32).toString('hex'), host_key_fingerprint: record.host_key_fingerprint };
  assert.equal(call(original).status, 0);
  const before = (await db.query('SELECT * FROM nodes WHERE name=$1', [original.node_name])).rows;
  const first = call(record);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).created, true);
  const same = call(record);
  assert.equal(same.status, 0, same.stderr);
  assert.deepEqual(JSON.parse(same.stdout), { ...JSON.parse(first.stdout), created: false });
  const vmBefore = (await db.query('SELECT * FROM nodes WHERE name=$1', [record.node_name])).rows[0];
  assert.equal(vmBefore.ssh_username, null, 'Older/default nodes retain the Gateway fallback');
  assert.equal(call({ ...record, ssh_username: 'linux' }).status, 0);
  const vmAfter = (await db.query('SELECT * FROM nodes WHERE name=$1', [record.node_name])).rows[0];
  assert.deepEqual({ ...vmAfter, ssh_username: vmBefore.ssh_username, updated_at: vmBefore.updated_at }, vmBefore,
    'Only the SSH account and its update timestamp may change');
  assert.equal(vmAfter.ssh_username, 'linux');
  assert.equal(call(record).status, 0, 'Omitting an account preserves its existing value');
  assert.equal((await db.query('SELECT ssh_username FROM nodes WHERE name=$1', [record.node_name])).rows[0].ssh_username, 'linux');
  assert.equal(call({ ...record, ssh_username: 'linux' }).status, 0);
  assert.deepEqual((await db.query('SELECT * FROM nodes WHERE name=$1', [record.node_name])).rows[0], vmAfter,
    'Retry with the same account is idempotent');
  for (const ssh_username of ['', 'linux;id', '-root', 'domain\\user', 'x'.repeat(33)]) {
    assert.notEqual(call({ ...record, ssh_username }).status, 0, 'Reject malformed SSH account before updating a node');
    await assert.rejects(db.query('UPDATE nodes SET ssh_username=$1 WHERE name=$2', [ssh_username, record.node_name]));
  }
  for (const change of [
    { node_token: crypto.randomBytes(32).toString('hex') },
    { node_ip: '10.100.0.4' },
    { host_key_fingerprint: original.host_key_fingerprint.replace(/.$/, 'A') === original.host_key_fingerprint
      ? 'SHA256:' + 'B'.repeat(43) : original.host_key_fingerprint.replace(/.$/, 'A') },
    { node_name: 'different-name' },
    { node_name: 'docker-existing', node_ip: '10.100.0.4' },
    { node_name: 'bad node name' },
  ]) {
    const failure = call({ ...record, ssh_username: 'wrong-user', ...change });
    assert.notEqual(failure.status, 0);
    assert.ok(!failure.stderr.includes(token), 'No token in failure output');
  }
  assert.deepEqual((await db.query('SELECT * FROM nodes WHERE name=$1', [original.node_name])).rows, before);
  assert.equal((await db.query('SELECT ssh_username FROM nodes WHERE name=$1', [record.node_name])).rows[0].ssh_username, 'linux');
  assert.equal((await db.query('SELECT count(*)::int n FROM nodes')).rows[0].n, 2);
  assert.equal((await db.query('SELECT count(*)::int n FROM users')).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int n FROM audit_logs')).rows[0].n, 0);
  assert.deepEqual((await db.query(`SELECT table_name,privilege_type FROM information_schema.role_table_grants
    WHERE grantee='zt_app' ORDER BY table_name,privilege_type`)).rows, grantsBefore);
  const explicit = { ...record, node_name: 'explicit-account', node_ip: '10.100.0.5',
    node_token: crypto.randomBytes(32).toString('base64url'), ssh_username: 'service-user' };
  assert.equal(call(explicit).status, 0, 'Accept an explicit account when creating a new node');
  assert.equal((await db.query('SELECT ssh_username FROM nodes WHERE name=$1', [explicit.node_name])).rows[0].ssh_username, 'service-user');
  console.log('PASS real node-registration CLI: new VM, per-node SSH account update and idempotent retry, invalid accounts/name/IP/token/host-key conflicts rejected; existing Docker node/users and role grants preserved.');
}
main().catch((error) => { console.error('FAIL registration:', error.message); process.exitCode = 1; }).finally(async () => {
  if (db) await db.end();
  if (created) await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
});
