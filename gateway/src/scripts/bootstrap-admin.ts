import fs from 'node:fs';
import { Client } from 'pg';
import { hashPassword } from '../utils/crypto.js';

type Input = { username: string; password: string };

function validate(username: unknown, password: unknown): Input {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{3,64}$/.test(username)
    || typeof password !== 'string' || password.length < 12 || password.length > 256
    || /[\r\n\0]/.test(password)) throw new Error('INVALID_INPUT');
  return { username, password };
}

function input(): Input {
  const args = process.argv.slice(2);
  if (args.includes('--password')) throw new Error('PASSWORD_ARGUMENT_FORBIDDEN');
  if (args.length === 1 && args[0] === '--stdin') {
    const buffer = Buffer.alloc(4097);
    let size = 0;
    while (size < buffer.length) {
      const read = fs.readSync(0, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > 4096) throw new Error('INVALID_INPUT');
    const bytes = buffer.subarray(0, size);
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_INPUT');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some(key => !['username', 'password'].includes(key))) throw new Error('INVALID_INPUT');
    return validate(record.username, record.password);
  }
  let username = process.env.BOOTSTRAP_ADMIN_USER || 'admin';
  let password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
  let file = process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE || '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--username' && args[i + 1]) username = args[++i];
    else if (args[i] === '--password-file' && args[i + 1]) file = args[++i];
    else throw new Error('INVALID_ARGUMENT');
  }
  if (!password && file) {
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 4096) throw new Error('UNSAFE_PASSWORD_FILE');
      password = fs.readFileSync(descriptor, 'utf8').replace(/\r?\n$/, '');
    } finally { fs.closeSync(descriptor); }
  }
  return validate(username, password);
}

async function main(): Promise<void> {
  const record = input();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_REQUIRED');
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000,
    query_timeout: 5000, statement_timeout: 5000 });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('zt-first-admin'))");
    // A retry cannot reset a changed password, reactivate a user or promote a Viewer.
    const existing = await client.query("SELECT id FROM users WHERE role = 'ADMIN' OR username = $1 LIMIT 1", [record.username]);
    if (existing.rows.length) {
      await client.query('COMMIT');
      console.log(JSON.stringify({ created: false, existing_accounts_preserved: true }));
      return;
    }
    await client.query(`INSERT INTO users (username,password_hash,role,is_active,session_version)
      VALUES ($1,$2,'ADMIN',TRUE,1)`, [record.username, hashPassword(record.password)]);
    await client.query('COMMIT');
    console.log(JSON.stringify({ created: true, username: record.username }));
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally { await client.end(); }
}

main().catch(() => {
  console.error('Admin bootstrap stopped. Use --stdin JSON or a protected password file; password must be 12–256 characters. Existing users are preserved.');
  process.exitCode = 1;
});
