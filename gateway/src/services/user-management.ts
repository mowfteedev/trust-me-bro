import type { PoolClient } from 'pg';
import { getClient } from './db.js';
import { hashPassword, verifyPassword } from '../utils/crypto.js';
import { revokeUserSessions } from './bastion/registry.js';

export const PUBLIC_USER_COLUMNS = 'id, username, role, is_active, created_at, updated_at';

export class AccountError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

// Serialize account writes so two concurrent demotions cannot remove the last Admin.
async function accountTransaction<T>(actorId: string, adminOnly: boolean,
  action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(20261116, 6);');
    const actor = await client.query('SELECT role, is_active FROM users WHERE id = $1 FOR UPDATE;', [actorId]);
    if (!actor.rows[0]?.is_active || (adminOnly && actor.rows[0].role !== 'ADMIN')) {
      throw new AccountError(403, 'FORBIDDEN', 'Tài khoản không còn quyền thực hiện thao tác này.');
    }
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function audit(client: PoolClient, actorId: string, action: string,
  target: string, details: Record<string, unknown>, ip: string | null) {
  await client.query(`INSERT INTO audit_logs (user_id, action, target, details, ip_address)
    VALUES ($1, $2, $3, $4, $5::inet);`, [actorId, action, target, JSON.stringify(details), ip]);
}

export async function createAccount(actorId: string, input: {
  username: string; password: string; role: 'ADMIN' | 'VIEWER';
}, ip: string | null) {
  // Do not hold the transaction while computing the password hash.
  const passwordHash = hashPassword(input.password);
  try {
    return await accountTransaction(actorId, true, async client => {
      const result = await client.query(`INSERT INTO users (username, password_hash, role)
        VALUES ($1, $2, $3) RETURNING ${PUBLIC_USER_COLUMNS};`,
      [input.username, passwordHash, input.role]);
      const user = result.rows[0];
      await audit(client, actorId, 'USER_CREATED', user.id, { username: user.username, role: user.role }, ip);
      return user;
    });
  } catch (error: any) {
    if (error?.code === '23505') throw new AccountError(409, 'USERNAME_EXISTS', 'Tên đăng nhập đã được sử dụng.');
    throw error;
  }
}

export async function updateAccount(actorId: string, userId: string,
  changes: { role?: 'ADMIN' | 'VIEWER'; is_active?: boolean }, ip: string | null) {
  let revokedVersion: number | null = null;
  const user = await accountTransaction(actorId, true, async client => {
    const result = await client.query(`SELECT ${PUBLIC_USER_COLUMNS}, session_version FROM users WHERE id = $1 FOR UPDATE;`, [userId]);
    const target = result.rows[0];
    if (!target) throw new AccountError(404, 'USER_NOT_FOUND', 'Không tìm thấy tài khoản.');
    const role = changes.role ?? target.role;
    const active = changes.is_active ?? target.is_active;
    if (actorId === userId && (!active || role !== 'ADMIN')) {
      throw new AccountError(409, 'SELF_LOCKOUT', 'Không thể tự khóa hoặc hạ quyền tài khoản đang sử dụng.');
    }
    if (target.role === 'ADMIN' && target.is_active && (!active || role !== 'ADMIN')) {
      const admins = await client.query("SELECT count(*)::int AS count FROM users WHERE role = 'ADMIN' AND is_active = true;");
      if (Number(admins.rows[0].count) <= 1) throw new AccountError(409, 'LAST_ADMIN', 'Phải giữ ít nhất một quản trị viên đang hoạt động.');
    }
    const changed = role !== target.role || active !== target.is_active;
    if (!changed) {
      const { session_version: _version, ...publicUser } = target;
      return publicUser;
    }
    const updated = await client.query(`UPDATE users SET role = $2, is_active = $3,
      session_version = session_version + 1, updated_at = now() WHERE id = $1
      RETURNING ${PUBLIC_USER_COLUMNS}, session_version;`, [userId, role, active]);
    const { session_version: version, ...publicUser } = updated.rows[0];
    revokedVersion = Number(version);
    await audit(client, actorId, 'USER_UPDATED', userId,
      { username: target.username, role, is_active: active }, ip);
    return publicUser;
  });
  if (revokedVersion !== null) revokeUserSessions(userId, revokedVersion);
  return user;
}

export async function changeAccountPassword(actorId: string, userId: string,
  password: string, ip: string | null, currentPassword?: string) {
  const newHash = hashPassword(password);
  const version = await accountTransaction(actorId, currentPassword === undefined, async client => {
    const result = await client.query('SELECT username, password_hash FROM users WHERE id = $1 FOR UPDATE;', [userId]);
    const target = result.rows[0];
    if (!target) throw new AccountError(404, 'USER_NOT_FOUND', 'Không tìm thấy tài khoản.');
    if (currentPassword !== undefined && (actorId !== userId || !verifyPassword(currentPassword, target.password_hash))) {
      throw new AccountError(400, 'INCORRECT_PASSWORD', 'Mật khẩu hiện tại không chính xác.');
    }
    const updated = await client.query(`UPDATE users SET password_hash = $2,
      session_version = session_version + 1, updated_at = now() WHERE id = $1 RETURNING session_version;`, [userId, newHash]);
    await audit(client, actorId, currentPassword === undefined ? 'USER_PASSWORD_RESET' : 'PASSWORD_CHANGED',
      userId, { username: target.username }, ip);
    return Number(updated.rows[0].session_version);
  });
  revokeUserSessions(userId, version);
}
