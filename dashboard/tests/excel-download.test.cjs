const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync('src/services/api.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const login = id => ({ token: `test-${id}`, user: { id, username: id, role: 'VIEWER' } });
const file = () => new Response(new Uint8Array([80, 75, 3, 4]), { headers: { 'content-type': mime } });

function client(fetch) {
  const module = { exports: {} }, storage = new Map(), downloads = [], events = [], revoked = [];
  vm.runInNewContext(source, {
    module, exports: module.exports, fetch, AbortSignal, Event, URLSearchParams,
    setTimeout: fn => { fn(); return 1; }, console: { warn() {} },
    window: { dispatchEvent: event => events.push(event.type) },
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL: url => revoked.push(url) },
    document: { createElement: () => { const link = { click: () => downloads.push({ name: link.download, url: link.href }), remove() {} }; return link; }, body: { appendChild() {} } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  });
  return { api: module.exports.api, downloads, events, revoked };
}

test('exports authenticated binary files with applied filters and no pagination', async () => {
  const calls = [];
  const c = client(async (url, options) => {
    calls.push({ url, options }); return url.endsWith('/login') ? json(login('viewer')) : file();
  });
  await c.api.login('viewer', 'fixture');
  await c.api.exportAuditLogs({ action: 'LOGIN_FAILED', q: 'máy & =1+1' });
  await c.api.exportIncidents('resolved');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-viewer');
  assert.equal(calls[1].options.headers.Accept, mime);
  const url = new URL(calls[1].url, 'https://example.test');
  assert.equal(url.searchParams.get('q'), 'máy & =1+1');
  assert.equal(url.searchParams.get('action'), 'LOGIN_FAILED');
  assert.equal(url.searchParams.has('page'), false);
  assert.equal(calls[2].url, '/api/incidents/export?state=resolved');
  assert.deepEqual(c.downloads.map(x => x.name), ['zt-audit-logs.xlsx', 'zt-incidents.xlsx']);
  assert.equal(c.revoked.length, 2);
  assert.equal(typeof c.api.purgeAuditLogs, 'undefined');
  assert.equal(typeof c.api.getPurgePreview, 'undefined');
});

test('overflow and busy failures show server guidance without downloading JSON as Excel', async () => {
  for (const status of [422, 409, 429, 503]) {
    const c = client(async url => url.endsWith('/login') ? json(login('viewer')) : json({ detail: 'Hãy thu hẹp bộ lọc hoặc thử lại.' }, status));
    await c.api.login('viewer', 'fixture');
    await assert.rejects(c.api.exportIncidents('all'), /thu hẹp bộ lọc/);
    assert.equal(c.downloads.length, 0);
    assert.equal(c.api.isAuthenticated(), true);
  }
});

test('expired export credentials clear only their session and never download an error response', async () => {
  const c = client(async url => url.endsWith('/login') ? json(login('viewer')) : json({ detail: 'Hết hạn' }, 401));
  await c.api.login('viewer', 'fixture');
  await assert.rejects(c.api.exportIncidents('all'), /Hết hạn/);
  assert.equal(c.api.isAuthenticated(), false);
  assert.deepEqual(c.events, ['zt-session-expired']);
  assert.equal(c.downloads.length, 0);
});

test('a late successful export from an old session cannot download after a new login', async () => {
  let finish, counter = 0;
  const c = client(async url => url.endsWith('/login') ? json(login(String(++counter))) : new Promise(resolve => { finish = resolve; }));
  await c.api.login('old', 'fixture');
  const pending = assert.rejects(c.api.exportIncidents('all'), /đã thay đổi/);
  await c.api.login('new', 'fixture'); finish(file()); await pending;
  assert.equal(c.api.getCurrentUser().username, '2');
  assert.equal(c.downloads.length, 0);
});

test('an HTML response is rejected rather than saved with an xlsx extension', async () => {
  const c = client(async url => url.endsWith('/login') ? json(login('viewer')) : new Response('<html>proxy error</html>', { headers: { 'content-type': 'text/html' } }));
  await c.api.login('viewer', 'fixture');
  await assert.rejects(c.api.exportIncidents('all'), /Excel hợp lệ/);
  assert.equal(c.downloads.length, 0);
});
