/** Incident read API: fake DB with real role guards, no production access. */
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ query: vi.fn(), role: 'ADMIN' }));
vi.mock('../src/services/db.js', () => ({ query: mock.query }));
vi.mock('../src/middlewares/auth.middleware.js', () => ({
  authenticate: async (_req: unknown, reply: any) => {
    if (mock.role === 'ANONYMOUS') return reply.code(401).send({ code: 'UNAUTHORIZED' });
  },
  authorize: (allowed: string[]) => async (_req: unknown, reply: any) => {
    if (!allowed.includes(mock.role)) return reply.code(403).send({ code: 'FORBIDDEN' });
  },
}));
import { incidentsRoutes } from '../src/routes/incidents.js';
beforeEach(() => { vi.clearAllMocks(); mock.role = 'ADMIN'; mock.query.mockResolvedValue({ rows: [{ data: [], total: 0 }] }); });
async function get(query = '') {
  const app = Fastify(); await app.register(incidentsRoutes, { prefix: '/api/incidents' });
  try { return await app.inject({ method: 'GET', url: `/api/incidents/${query}` }); }
  finally { await app.close(); }
}
describe('incident read contract', () => {
  it.each(['ADMIN', 'VIEWER'])('allows %s to read incidents', async role => {
    mock.role = role;
    const result = await get('?state=resolved&page=2&page_size=10');
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(mock.query).toHaveBeenCalledWith(expect.any(String), ['resolved', null, 10, 10]);
    expect(result.json()).toMatchObject({ success: true, data: [], pagination: { page: 2, total: 0, total_pages: 0 } });
  });
  it('rejects unauthenticated access before reading DB', async () => {
    mock.role = 'ANONYMOUS';
    expect((await get()).statusCode).toBe(401);
    expect(mock.query).not.toHaveBeenCalled();
  });
  it.each(['?state=invalid', '?page=0', '?page_size=101', '?node_id=invalid', '?page=1.5', '?unknown=true'])
  ('rejects invalid filter %s', async filter => {
    expect((await get(filter)).statusCode).toBe(400);
    expect(mock.query).not.toHaveBeenCalled();
  });
  it('uses parameterized UUID and state filters, including the count on empty pages', async () => {
    mock.query.mockResolvedValue({ rows: [{ data: [], total: 13 }] });
    const response = await get('?state=all&page=3&page_size=10&node_id=59d11636-b2da-4df6-9418-131e99355804');
    expect(response.json().pagination).toMatchObject({ total: 13, total_pages: 2 });
    expect(mock.query.mock.calls[0][1]).toEqual(['all', '59d11636-b2da-4df6-9418-131e99355804', 10, 20]);
  });
  it('returns a safe dependency error without DB credentials or query text', async () => {
    mock.query.mockRejectedValue(new Error('postgresql://private-secret@internal/query'));
    const result = await get();
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain('private-secret');
    expect(result.body).not.toContain('postgresql');
  });
});
