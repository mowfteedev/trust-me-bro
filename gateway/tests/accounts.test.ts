/** Real HTTP/JWT/password hashing; PostgreSQL and SSH revocation are simulated. */
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

const db = vi.hoisted(() => ({ query: vi.fn(), getClient: vi.fn(), revokeUser: vi.fn(), revokeSession: vi.fn() }));
vi.mock('../src/services/db.js', () => ({ query: db.query, getClient: db.getClient }));
vi.mock('../src/services/bastion/registry.js', () => ({ revokeUserSessions: db.revokeUser, revokeAuthSessionSessions: db.revokeSession }));
import { authRoutes } from '../src/routes/auth.js';
import { usersRoutes } from '../src/routes/users.js';
import { hashPassword, verifyPassword } from '../src/utils/crypto.js';

const adminId = 'c1d5e459-73b6-41a5-aab3-a9b657d82c46';
const viewerId = '7d4da22d-9c65-4919-82e9-f1f382d5b6cf';
const password = 'long-private-password-123';
type User = { id: string; username: string; role: 'ADMIN' | 'VIEWER'; is_active: boolean; session_version: number; password_hash: string; created_at: string; updated_at: string };
let users: User[];
let revoked: Map<string, string>;
let audits: any[][];
let app: FastifyInstance;
let failAudit: boolean;
let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
const publicUser = (user: User) => {
  const { password_hash: _password, session_version: _version, ...result } = user;
  return result;
};

beforeEach(async () => {
  vi.clearAllMocks();
  const hash = hashPassword(password);
  users = [{ id: adminId, username: 'admin-check', role: 'ADMIN', is_active: true, session_version: 1, password_hash: hash,
    created_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:00:00Z' },
  { id: viewerId, username: 'viewer-check', role: 'VIEWER', is_active: true, session_version: 1, password_hash: hash,
    created_at: '2026-11-16T00:00:00Z', updated_at: '2026-11-16T00:00:00Z' }];
  revoked = new Map(); audits = []; failAudit = false;
  let snapshot: User[] = [];
  const runQuery = async (sql: string, params: any[] = []): Promise<any> => {
    if (sql === 'BEGIN') { snapshot = structuredClone(users); return { rows: [] }; }
    if (sql === 'ROLLBACK') { users = snapshot; return { rows: [] }; }
    if (sql === 'COMMIT' || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('INSERT INTO audit_logs')) {
      if (failAudit) throw new Error('private-database-error');
      audits.push(params); return { rows: [] };
    }
    if (sql.includes('INSERT INTO revoked_auth_sessions')) { revoked.set(params[0], params[1]); return { rows: [] }; }
    if (sql.includes('DELETE FROM revoked_auth_sessions')) return { rows: [] };
    if (sql.includes('INSERT INTO users')) {
      if (users.some(user => user.username === params[0])) throw Object.assign(new Error('duplicate private value'), { code: '23505' });
      const user: User = { ...users[0], id: randomUUID(), username: params[0], password_hash: params[1], role: params[2], session_version: 1 };
      users.push(user); return { rows: [publicUser(user)] };
    }
    if (sql.includes('count(*)')) return { rows: [{ count: users.filter(user => user.is_active && user.role === 'ADMIN').length }] };
    if (sql.includes('ORDER BY username')) return { rows: users.map(publicUser) };
    const user = users.find(user => sql.includes('WHERE username') ? user.username === params[0] : user.id === params[0]);
    if (sql.includes('UPDATE users') && user) {
      if (sql.includes('password_hash =')) user.password_hash = params[1];
      if (sql.includes('SET role =')) { user.role = params[1]; user.is_active = params[2]; }
      user.session_version++;
      return { rows: [{ ...publicUser(user), session_version: user.session_version }] };
    }
    if (sql.includes('FROM users')) return { rows: user ? [{ ...user, session_revoked: params[1] && revoked.get(params[1]) === user.id }] : [] };
    throw new Error(`Unexpected test SQL: ${sql}`);
  };
  db.query.mockImplementation(runQuery);
  client = { query: vi.fn(runQuery), release: vi.fn() };
  db.getClient.mockResolvedValue(client);
  app = Fastify();
  await app.register(jwt, { secret: 'isolated-accounts-test-secret-more-than-32-characters' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(usersRoutes, { prefix: '/api/users' });
});
afterEach(async () => { await app.close(); });

const tokenFor = (id = adminId, legacy = false) => {
  const user = users.find(user => user.id === id)!;
  return app.jwt.sign({ id, username: user.username, role: user.role, session_version: user.session_version,
    ...(legacy ? {} : { jti: randomUUID() }) }, { expiresIn: '1h' });
};
const request = (method: 'GET' | 'POST' | 'PATCH', url: string, token = tokenFor(), payload?: any) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

describe('per-device and all-device sessions', () => {
  it('issues a distinct bounded jti for every successful login', async () => {
    const a = await request('POST', '/api/auth/login', '', { username: 'admin-check', password });
    const b = await request('POST', '/api/auth/login', '', { username: 'admin-check', password });
    expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200);
    expect(app.jwt.decode<any>(a.json().token).jti).not.toBe(app.jwt.decode<any>(b.json().token).jti);
    expect(a.json().user).not.toHaveProperty('password_hash');
  });
  it('revokes only the current JWT and its SSH sessions, keeping the second device signed in', async () => {
    const a = tokenFor(); const b = tokenFor();
    const result = await request('POST', '/api/auth/logout', a, {});
    expect(result.statusCode).toBe(200); expect(result.json().scope).toBe('current');
    expect((await request('GET', '/api/auth/me', a)).statusCode).toBe(401);
    expect((await request('GET', '/api/auth/me', b)).statusCode).toBe(200);
    expect(db.revokeSession).toHaveBeenCalledWith(app.jwt.decode<any>(a).jti);
    expect(db.revokeUser).not.toHaveBeenCalled();
    expect(users[0].session_version).toBe(1);
  });
  it('logout-all invalidates every device and closes their SSH sessions', async () => {
    const a = tokenFor(); const b = tokenFor();
    expect((await request('POST', '/api/auth/logout-all', a, {})).statusCode).toBe(200);
    expect((await request('GET', '/api/auth/me', a)).statusCode).toBe(401);
    expect((await request('GET', '/api/auth/me', b)).statusCode).toBe(401);
    expect(db.revokeUser).toHaveBeenCalledWith(adminId, 2);
  });
  it('keeps the legacy JWT behavior explicit: logout falls back to all devices', async () => {
    const result = await request('POST', '/api/auth/logout', tokenFor(adminId, true), {});
    expect(result.statusCode).toBe(200); expect(result.json().scope).toBe('all');
    expect(db.revokeUser).toHaveBeenCalledWith(adminId, 2);
  });
  it('fails closed when revocation storage cannot be checked', async () => {
    db.query.mockRejectedValue(new Error('secret database connection'));
    const result = await request('GET', '/api/auth/me');
    expect(result.statusCode).toBe(503); expect(result.body).not.toContain('secret database');
  });
  it('rejects malformed session identifiers before any database query', async () => {
    const token = app.jwt.sign({ id: adminId, username: 'admin', role: 'ADMIN', session_version: 1, jti: 'not-a-uuid' }, { expiresIn: '1h' });
    expect((await request('GET', '/api/auth/me', token)).statusCode).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('account management RBAC and transactions', () => {
  it('allows only Admin to list, create, update and reset another user', async () => {
    const token = tokenFor(viewerId);
    for (const [method, path, payload] of [
      ['GET', '/api/users/', undefined],
      ['POST', '/api/users/', { username: 'third-user', password, role: 'VIEWER' }],
      ['PATCH', `/api/users/${adminId}`, { is_active: false }],
      ['POST', `/api/users/${adminId}/reset-password`, { password }],
    ] as const) expect((await request(method, path, token, payload)).statusCode).toBe(403);
    expect(db.getClient).not.toHaveBeenCalled();
  });
  it('returns bounded public user fields and private no-store responses', async () => {
    const result = await request('GET', '/api/users/');
    expect(result.statusCode).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json().data).toHaveLength(2); expect(result.body).not.toContain('password_hash');
    expect(result.body).not.toContain('session_version');
    expect((await request('GET', '/api/users')).statusCode).toBe(200);
  });
  it('creates a hashed account and records a secret-free audit in one transaction', async () => {
    const result = await request('POST', '/api/users/', tokenFor(), { username: 'third-user', password, role: 'VIEWER' });
    expect(result.statusCode).toBe(201);
    expect(verifyPassword(password, users[2].password_hash)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(password);
    expect(audits[0][1]).toBe('USER_CREATED');
    expect(client.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true);
  });
  it('rejects duplicate usernames without exposing database messages', async () => {
    const result = await request('POST', '/api/users/', tokenFor(), { username: 'admin-check', password, role: 'VIEWER' });
    expect(result.statusCode).toBe(409); expect(result.body).not.toContain('private');
  });
  it.each([{ password: 'short' }, { username: 'bad name' }, { role: 'OWNER' }, { unexpected: true }])('validates create inputs %j', async bad => {
    const result = await request('POST', '/api/users/', tokenFor(), { username: 'third-user', password, role: 'VIEWER', ...bad });
    expect(result.statusCode).toBe(400); expect(db.getClient).not.toHaveBeenCalled();
  });
  it('prevents self-disable and self-demotion', async () => {
    for (const payload of [{ is_active: false }, { role: 'VIEWER' }]) {
      const result = await request('PATCH', `/api/users/${adminId}`, tokenFor(), payload);
      expect(result.statusCode).toBe(409); expect(result.json().code).toBe('SELF_LOCKOUT');
    }
    expect(users[0].is_active).toBe(true); expect(users[0].role).toBe('ADMIN');
  });
  it('checks actor privileges again inside the serialized transaction', async () => {
    const original = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes('SELECT role, is_active')) return { rows: [{ role: 'VIEWER', is_active: true }] };
      return original(sql, params);
    });
    const result = await request('PATCH', `/api/users/${viewerId}`, tokenFor(), { role: 'ADMIN' });
    expect(result.statusCode).toBe(403);
    expect(users[1].role).toBe('VIEWER');
    expect(client.query.mock.calls.some(([sql]) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
  });
  it('checks the remaining active Admin count before removing another Admin', async () => {
    users[1].role = 'ADMIN';
    const original = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes('count(*)')) return { rows: [{ count: 1 }] };
      return original(sql, params);
    });
    const result = await request('PATCH', `/api/users/${viewerId}`, tokenFor(), { role: 'VIEWER' });
    expect(result.statusCode).toBe(409); expect(result.json().code).toBe('LAST_ADMIN');
    expect(users[1].role).toBe('ADMIN');
  });
  it('rolls back account changes when the audit insert fails', async () => {
    failAudit = true;
    const result = await request('PATCH', `/api/users/${viewerId}`, tokenFor(), { is_active: false });
    expect(result.statusCode).toBe(503); expect(users[1].is_active).toBe(true);
    expect(db.revokeUser).not.toHaveBeenCalled();
    expect(result.body).not.toContain('private-database-error');
  });
  it('revokes existing sessions when an Admin changes permissions', async () => {
    const token = tokenFor(viewerId);
    expect((await request('PATCH', `/api/users/${viewerId}`, tokenFor(), { role: 'ADMIN' })).statusCode).toBe(200);
    expect(db.revokeUser).toHaveBeenCalledWith(viewerId, 2);
    expect((await request('GET', '/api/auth/me', token)).statusCode).toBe(401);
  });
  it('verifies the old password before accepting a self-service change', async () => {
    const token = tokenFor(viewerId);
    const wrong = await request('POST', '/api/auth/change-password', token,
      { current_password: 'wrong-password', new_password: 'another-long-password' });
    expect(wrong.statusCode).toBe(400); expect(users[1].session_version).toBe(1);
    expect((await request('POST', '/api/auth/change-password', token,
      { current_password: password, new_password: 'another-long-password' })).statusCode).toBe(200);
    expect(verifyPassword('another-long-password', users[1].password_hash)).toBe(true);
    expect((await request('GET', '/api/auth/me', token)).statusCode).toBe(401);
    expect(JSON.stringify(audits)).not.toContain(password);
  });
  it('Admin password reset revokes the target sessions without exposing the hash', async () => {
    const token = tokenFor(viewerId);
    const result = await request('POST', `/api/users/${viewerId}/reset-password`, tokenFor(), { password: 'reset-long-password-456' });
    expect(result.statusCode).toBe(200); expect(result.body).not.toContain('password_hash');
    expect(verifyPassword('reset-long-password-456', users[1].password_hash)).toBe(true);
    expect((await request('GET', '/api/auth/me', token)).statusCode).toBe(401);
  });
});
