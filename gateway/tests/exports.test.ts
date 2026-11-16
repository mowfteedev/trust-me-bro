/** Actual auth/JWT/ZIP routes, simulated PostgreSQL; no production or external calls. */
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/services/db.js', () => ({ query: mock.query }));
import { auditRoutes } from '../src/routes/audit.js';
import { incidentsRoutes } from '../src/routes/incidents.js';
import { spreadsheetParts } from './helpers/xlsx.js';

let app: FastifyInstance;
let user: { id: string; username: string; role: 'ADMIN' | 'VIEWER'; is_active: boolean; session_version: number };
let token: string;
const auditRow = { id: 'audit-id', created_at: new Date('2026-11-17T00:00:00Z'), action: 'LOGIN_FAILED',
  user_id: null, username: '=1+1', node_id: null, node_name: null, ip_address: '192.0.2.1', target: 'auth',
  details: { attempted_username: '=SUM(1,2)', password: 'never-export-this', token: 'private-token' } };
const incident = { id: 'incident-id', node_id: '00000000-0000-4000-8000-000000000001', node_name: 'worker-fixture',
  ip_address: '10.100.0.2', severity: 'WARNING', message: '=HYPERLINK("https://example.com")',
  created_at: new Date('2026-11-17T00:00:00Z'), resolved_at: null, duration_seconds: 42, opening_status: 'SENT', recovery_status: null };
beforeEach(async () => {
  vi.clearAllMocks();
  user = { id: randomUUID(), username: 'export-check', role: 'ADMIN', is_active: true, session_version: 1 };
  mock.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM users WHERE id') ? [user]
    : sql.includes('FROM audit_logs') ? [auditRow] : [incident] }));
  app = Fastify(); await app.register(jwt, { secret: 'isolated-export-secret-longer-than-thirty-two-characters' });
  await app.register(auditRoutes, { prefix: '/api/audit' });
  await app.register(incidentsRoutes, { prefix: '/api/incidents' });
  token = app.jwt.sign({ id: user.id, username: user.username, role: user.role, session_version: 1 });
});
afterEach(async () => { await app.close(); vi.restoreAllMocks(); });
const get = (url: string, auth = token) => app.inject({ method: 'GET', url, headers: auth ? { authorization: `Bearer ${auth}` } : {} });
const sheet = (response: Awaited<ReturnType<typeof get>>) => spreadsheetParts(response.rawPayload)['xl/worksheets/sheet1.xml'];

describe('filtered read-only Excel exports', () => {
  it.each(['ADMIN', 'VIEWER'])('allows %s to export both kinds immediately using separate budgets', async role => {
    user.role = role as typeof user.role;
    for (const [url, filename] of [['/api/audit/logs/export', 'zt-audit-logs.xlsx'], ['/api/incidents/export', 'zt-incidents.xlsx']]) {
      const response = await get(url);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(response.headers['content-disposition']).toBe(`attachment; filename="${filename}"`);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.rawPayload.subarray(0, 2).toString()).toBe('PK');
    }
    expect(mock.query.mock.calls.some(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
  });
  it.each(['/api/audit/logs/export', '/api/incidents/export'])('rejects anonymous export %s before DB reads', async url => {
    expect((await get(url, '')).statusCode).toBe(401); expect(mock.query).not.toHaveBeenCalled();
  });
  it.each(['/api/audit/logs/export?page=2', '/api/audit/logs/export?action=INVALID', '/api/audit/logs/export?q=a&q=b',
    '/api/incidents/export?page_size=10', '/api/incidents/export?state=INVALID', '/api/incidents/export?node_id=invalid'])
  ('rejects unsupported export filters %s', async url => {
    expect((await get(url)).statusCode).toBe(400);
    expect(mock.query.mock.calls.some(([sql]) => sql.includes('FROM audit_logs') || sql.includes('FROM alerts'))).toBe(false);
  });
  it('uses the current literal audit filters and reads the complete bounded result, not a page', async () => {
    const response = await get('/api/audit/logs/export?action=LOGIN_FAILED&q=admin%25_!');
    expect(response.statusCode).toBe(200);
    const query = mock.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs'))!;
    expect(query[1]).toEqual(['LOGIN_FAILED', '%admin!%!_!!%', 10001, 0]);
    expect(sheet(response)).toContain('07:00:00');
    expect(sheet(response)).toContain('=SUM(1,2)');
    expect(sheet(response)).not.toContain('never-export-this');
    expect(sheet(response)).not.toContain('private-token');
    expect(sheet(response)).not.toContain('<f');
  });
  it('applies incident filters and keeps duration numeric and missing delivery blank', async () => {
    const response = await get(`/api/incidents/export?state=resolved&node_id=${incident.node_id}`);
    expect(response.statusCode).toBe(200);
    const query = mock.query.mock.calls.find(([sql]) => sql.includes('FROM alerts'))!;
    expect(query[1]).toEqual(['resolved', incident.node_id, 10001]);
    expect(sheet(response)).toContain('<c r="J2" t="n"><v>42</v></c>');
    expect(sheet(response)).not.toContain('<f');
  });
  it('rejects a second same-kind export during the cooldown, allowing another user', async () => {
    expect((await get('/api/audit/logs/export')).statusCode).toBe(200);
    const rejected = await get('/api/audit/logs/export');
    expect(rejected.statusCode).toBe(429); expect(rejected.headers['retry-after']).toBeDefined();
    user.id = randomUUID(); token = app.jwt.sign({ ...user });
    expect((await get('/api/audit/logs/export')).statusCode).toBe(200);
  });
  it('blocks overlapping exports across both routes, then releases the guard', async () => {
    let resolve!: (value: unknown) => void; let started!: () => void;
    const entered = new Promise<void>(done => { started = done; });
    mock.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM users WHERE id')) return { rows: [user] };
      if (sql.includes('FROM audit_logs')) { started(); return new Promise(done => { resolve = done; }); }
      return { rows: [incident] };
    });
    const first = get('/api/audit/logs/export'); first.then(() => {});
    await entered;
    const second = await get('/api/incidents/export');
    expect(second.statusCode).toBe(409); expect(second.headers['retry-after']).toBe('2');
    resolve({ rows: [auditRow] }); expect((await first).statusCode).toBe(200);
    expect((await get('/api/incidents/export')).statusCode).toBe(200);
  });
  it.each(['database', 'rows', 'bytes'])('releases its global guard after %s failure without truncating or exposing secrets', async failure => {
    mock.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM users WHERE id')) return { rows: [user] };
      if (sql.includes('FROM audit_logs')) {
        if (failure === 'database') throw new Error('private-db-password');
        return { rows: Array.from({ length: failure === 'rows' ? 10001 : 10000 }, () => ({
          ...auditRow, details: { message: 'x'.repeat(500) },
        })) };
      }
      return { rows: [incident] };
    });
    const response = await get('/api/audit/logs/export');
    expect(response.statusCode).toBe(failure === 'database' ? 503 : 422);
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.body).not.toContain('private-db-password');
    expect((await get('/api/incidents/export')).statusCode).toBe(200);
  });
});
