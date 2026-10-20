/** Route/unit checks: actual JWT + RBAC middleware, mocked PostgreSQL only. */
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/services/db.js', () => ({ query: mock.query }));

import { auditRoutes } from '../src/routes/audit.js';

const user = {
  id: '956947db-c94f-453a-8798-908e6a197a3e', username: 'test-admin',
  role: 'ADMIN' as 'ADMIN' | 'VIEWER', is_active: true, session_version: 1,
};
const row = {
  id: '18870e73-4a53-46b1-b7b5-4f826d4ed093', created_at: new Date('2026-10-16T00:00:00Z'),
  action: 'BASTION_SESSION_START', user_id: user.id, username: user.username,
  node_id: 'ae34a547-cfea-4aa0-b171-538038091182', node_name: 'worker-test',
  ip_address: '127.0.0.1', target: 'bastion', details: { session_id: 'session-test', target_ip: '10.100.0.2' },
};
let app: FastifyInstance;
let token: string;
const logQueries = () => mock.query.mock.calls.filter(([sql]) => sql.includes('FROM audit_logs'));

beforeEach(async () => {
  vi.clearAllMocks();
  user.role = 'ADMIN';
  mock.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('FROM users WHERE id') ? [{ ...user }] : [row], rowCount: 1,
  }));
  app = Fastify();
  await app.register(jwt, { secret: 'isolated-route-test-secret-at-least-32-characters',
    sign: { algorithm: 'HS256' }, verify: { algorithms: ['HS256'] } });
  await app.register(auditRoutes, { prefix: '/api/audit' });
  token = app.jwt.sign({ id: user.id, username: user.username, role: 'ADMIN', session_version: 1 });
});
afterEach(async () => { await app.close(); });

const getLogs = (suffix = '') => app.inject({ method: 'GET', url: `/api/audit/logs${suffix}`,
  headers: { authorization: `Bearer ${token}` } });

describe('read-only audit log API', () => {
  it('requires authentication before any log query', async () => {
    const result = await app.inject({ method: 'GET', url: '/api/audit/logs' });
    expect(result.statusCode).toBe(401);
    expect(mock.query).not.toHaveBeenCalled();
  });

  it('uses the current database role and rejects a Viewer even with an Admin JWT claim', async () => {
    user.role = 'VIEWER';
    expect((await getLogs()).statusCode).toBe(403);
    expect(logQueries()).toHaveLength(0);
  });

  it('returns the real row shape and a stable newest-first page', async () => {
    const result = await getLogs();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ success: true, page: 1, page_size: 25, has_more: false,
      data: [{ ...row, created_at: row.created_at.toISOString() }] });
    const [sql, params] = logQueries()[0];
    expect(sql).toContain('ORDER BY a.created_at DESC, a.id DESC');
    expect(sql).toContain("n.id::text = COALESCE(a.node_id::text, a.details->>'node_id')");
    expect(sql).not.toContain('::uuid');
    expect(params).toEqual([26, 0]);
  });

  it('fetches one extra row for has_more and returns only 25 entries', async () => {
    mock.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM users WHERE id') ? [user] : Array.from({ length: 26 }, (_, i) => ({ ...row, id: `row-${i}` })),
    }));
    const result = await getLogs('?page=2');
    expect(result.json().data).toHaveLength(25);
    expect(result.json()).toMatchObject({ page: 2, page_size: 25, has_more: true });
    expect(logQueries()[0][1]).toEqual([26, 25]);
  });

  it.each(['?page=0', '?page=-1', '?page=1.5', '?page=10001', '?page=oops',
    '?action=DELETE_ALL', `?q=${'x'.repeat(101)}`, '?q=first&q=second'])('rejects an invalid query %s', async (suffix) => {
    expect((await getLogs(suffix)).statusCode).toBe(400);
    expect(logQueries()).toHaveLength(0);
  });

  it('parameterizes the action and literal substring, including SQL and LIKE metacharacters', async () => {
    const search = "  admin%_!' OR 1=1 --  ";
    expect((await getLogs(`?action=LOGIN_SUCCESS&q=${encodeURIComponent(search)}`)).statusCode).toBe(200);
    const [sql, params] = logQueries()[0];
    expect(params).toEqual(['LOGIN_SUCCESS', "%admin!%!_!!' OR 1=1 --%", 26, 0]);
    expect(sql).not.toContain(search.trim());
    expect(sql).toContain('a.action = $1');
    expect(sql).toContain("u.username ILIKE $2 ESCAPE '!'");
    expect(sql).toContain("n.name ILIKE $2 ESCAPE '!'");
    expect(sql).toContain("host(a.ip_address) ILIKE $2 ESCAPE '!'");
    expect(sql).toContain("host(n.ip_address) ILIKE $2 ESCAPE '!'");
    expect(sql).toContain("a.target ILIKE $2 ESCAPE '!'");
    expect(sql).toContain("a.details->>'attempted_username' ILIKE $2 ESCAPE '!'");
  });

  it('does not add a search predicate for whitespace-only input', async () => {
    expect((await getLogs('?q=%20%20')).statusCode).toBe(200);
    expect(logQueries()[0][1]).toEqual([26, 0]);
  });

  it('allows only bounded string details and never serializes extra row or JSON secrets', async () => {
    mock.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM users WHERE id') ? [user] : [{ ...row, password: 'private-row-value',
        details: { session_id: 's'.repeat(200), reason: 'r'.repeat(300), target_ip: { invalid: true },
          message: 'm'.repeat(1000), user_agent: 'private-agent', token: 'private-token', password: 'private-password' } }],
    }));
    const result = await getLogs();
    expect(result.json().data[0].details).toEqual({ session_id: 's'.repeat(96), reason: 'r'.repeat(160), message: 'm'.repeat(500) });
    expect(result.body).not.toContain('private-');
    expect(result.body).not.toContain('user_agent');
    expect(result.body).not.toContain('password');
    expect(result.body).not.toContain('token');
  });

  it('handles null legacy users, nodes and details without fabricating values', async () => {
    mock.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM users WHERE id') ? [user] : [{ ...row, user_id: null, username: null,
        node_id: null, node_name: null, ip_address: null, target: null, details: null }],
    }));
    expect((await getLogs()).json().data[0]).toMatchObject({ username: null, node_name: null, details: {} });
  });

  it('returns a bounded attempted username for failed logins even when no user exists', async () => {
    mock.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM users WHERE id') ? [user] : [{ ...row, action: 'LOGIN_FAILED',
        user_id: null, username: null, details: { attempted_username: `bad\n${'x'.repeat(80)}`,
          reason: 'invalid_credentials', password: 'private-password', token: 'private-token' } }],
    }));
    const result = await getLogs('?action=LOGIN_FAILED');
    expect(result.statusCode).toBe(200);
    expect(result.json().data[0]).toMatchObject({ user_id: null, username: null,
      details: { attempted_username: `bad${'x'.repeat(47)}`, reason: 'invalid_credentials' } });
    expect(result.body).not.toContain('private-');
  });

  it('does not expose attempted_username from unrelated historical event JSON', async () => {
    mock.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM users WHERE id') ? [user] : [{ ...row,
        details: { attempted_username: 'not-a-failed-login' } }],
    }));
    expect((await getLogs()).json().data[0].details).toEqual({});
  });

  it('preserves numeric CPU alert evidence including the valid percentage boundaries', async () => {
    mock.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM users WHERE id') ? [user] : [
        { ...row, action: 'CPU_HIGH', details: { cpu_percent: 87.5, threshold: 85 } },
        { ...row, action: 'CPU_HIGH', details: { cpu_percent: 0, threshold: 100 } },
      ],
    }));
    const result = await getLogs('?action=CPU_HIGH');
    expect(result.json().data.map((item: any) => item.details)).toEqual([
      { cpu_percent: 87.5, threshold: 85 }, { cpu_percent: 0, threshold: 100 },
    ]);
  });

  it('preserves validated offline IP and ISO timestamp evidence, including a null last_seen', async () => {
    mock.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM users WHERE id') ? [user] : [
        { ...row, action: 'NODE_OFFLINE', details: { ip: '10.100.0.2', last_seen: '2026-10-16T08:00:00.123Z' } },
        { ...row, action: 'NODE_OFFLINE', details: { ip: '2001:db8::2', last_seen: null } },
      ],
    }));
    const result = await getLogs('?action=NODE_OFFLINE');
    expect(result.json().data.map((item: any) => item.details)).toEqual([
      { ip: '10.100.0.2', last_seen: '2026-10-16T08:00:00.123Z' }, { ip: '2001:db8::2', last_seen: null },
    ]);
  });

  it('drops malformed CPU and offline evidence rather than coercing or truncating it into valid values', async () => {
    const invalidNumbers = [-1, 100.01, NaN, Infinity, '85', null, [], {}, true];
    const invalidNetworkEvidence = [
      { ip: 'not-an-ip', last_seen: 'not-a-date' },
      { ip: 123, last_seen: 123 },
      { ip: 'a'.repeat(65), last_seen: 'x'.repeat(65) },
      { ip: {}, last_seen: '2026-02-30T08:00:00Z' },
    ];
    mock.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM users WHERE id') ? [user] : [
        ...invalidNumbers.map((value) => ({ ...row, action: 'CPU_HIGH', details: { cpu_percent: value, threshold: value } })),
        ...invalidNetworkEvidence.map((details) => ({ ...row, action: 'NODE_OFFLINE', details })),
      ],
    }));
    const result = await getLogs();
    expect(result.statusCode).toBe(200);
    expect(result.json().data.every((item: any) => Object.keys(item.details).length === 0)).toBe(true);
  });

  it('sanitizes database failures and does not return exception messages', async () => {
    mock.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM audit_logs')) throw new Error('private-password connection-string');
      return { rows: [user] };
    });
    const result = await getLogs();
    expect(result.statusCode).toBe(503);
    expect(result.json().code).toBe('AUDIT_UNAVAILABLE');
    expect(result.body).not.toContain('private-password');
    expect(result.body).not.toContain('connection-string');
  });
});
