const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(fs.readFileSync('src/services/api.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const session = (id) => ({ token: `fixture-${id}`, user: { id, username: id, role: 'ADMIN' } });

// Exercise the actual service; browser storage/events and HTTP are isolated fixtures.
function client(fetch) {
  const store = new Map(), events = [], module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, fetch, AbortSignal, Event,
    console: { warn() {} },
    window: { dispatchEvent: (event) => events.push(event.type) },
    localStorage: { getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) },
  });
  return { api: module.exports.api, events, store };
}

test('a late 401 from the old session preserves a newer login', async () => {
  let finishOld, login = 0;
  const { api, events } = client(async (url) => url.endsWith('/login')
    ? response(session(String(++login))) : new Promise((resolve) => { finishOld = resolve; }));
  await api.login('first', 'fixture');
  const pending = assert.rejects(api.getNodes(), /đăng nhập lại/);
  await api.login('second', 'fixture');
  finishOld(response({}, 401));
  await pending;
  assert.equal(api.getCurrentUser().username, '2');
  assert.deepEqual(events, []);
});

test('a current-session 401 clears credentials and announces expiry', async () => {
  const { api, events, store } = client(async (url) => response(url.endsWith('/login') ? session('current') : {}, url.endsWith('/login') ? 200 : 401));
  await api.login('current', 'fixture');
  await assert.rejects(api.getNodes(), /đăng nhập lại/);
  assert.equal(api.getCurrentUser(), null);
  assert.equal(store.size, 0);
  assert.deepEqual(events, ['zt-session-expired']);
});

test('a late logout completion does not erase a newer session', async () => {
  let finishLogout, login = 0;
  const { api } = client(async (url) => url.endsWith('/login')
    ? response(session(String(++login))) : new Promise((resolve) => { finishLogout = resolve; }));
  await api.login('first', 'fixture');
  const pending = api.logout();
  await api.login('second', 'fixture');
  finishLogout(response({ success: true }));
  assert.equal((await pending).serverRevoked, true);
  assert.equal(api.getCurrentUser().username, '2');
});

test('logout network failure clears only the local session and reports uncertainty', async () => {
  const { api, store } = client(async (url) => {
    if (url.endsWith('/login')) return response(session('current'));
    throw new Error('fixture offline');
  });
  await api.login('current', 'fixture');
  const result = await api.logout();
  assert.equal(result.serverRevoked, false);
  assert.match(result.error, /fixture offline/);
  assert.equal(api.getCurrentUser(), null);
  assert.equal(store.size, 0);
});
