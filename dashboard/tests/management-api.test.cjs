const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(fs.readFileSync('src/services/api.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
const login = id => ({ token: `fixture-${id}`, user: { id, username: id, role: 'ADMIN' } });
function createClient(fetch) {
  const module = { exports: {} }, events = [], values = new Map();
  vm.runInNewContext(source, { module, exports: module.exports, fetch, AbortSignal, Event,
    console: { warn() {} }, window: { dispatchEvent: event => events.push(event.type) },
    localStorage: { getItem: name => values.get(name) ?? null, setItem: (name, value) => values.set(name, value), removeItem: name => values.delete(name) } });
  return { api: module.exports.api, events };
}
for (const method of ['changePassword', 'logoutAll']) {
  const invoke = api => method === 'changePassword' ? api.changePassword('fixture-old', 'fixture-new-12') : api.logoutAll();
  test(`late ${method} success cannot erase a newer login`, async () => {
    let finish, count = 0;
    const { api, events } = createClient(async url => url.endsWith('/login') ? reply(login(String(++count))) : new Promise(resolve => { finish = resolve; }));
    await api.login('first', 'fixture');
    const oldAction = invoke(api);
    await api.login('second', 'fixture');
    finish(reply({ success: true })); await oldAction;
    assert.equal(api.getToken(), 'fixture-2');
    assert.equal(api.getCurrentUser().username, '2');
    assert.deepEqual(events, []);
  });
  test(`${method} success invalidates its current session`, async () => {
    const { api, events } = createClient(async url => reply(url.endsWith('/login') ? login('current') : { success: true }));
    await api.login('current', 'fixture'); await invoke(api);
    assert.equal(api.getToken(), null);
    assert.deepEqual(events, ['zt-session-expired']);
  });
  test(`${method} service failure preserves current credentials`, async () => {
    const { api, events } = createClient(async url => url.endsWith('/login') ? reply(login('current')) : reply({ detail: 'fixture unavailable' }, 503));
    await api.login('current', 'fixture'); await assert.rejects(invoke(api), /fixture unavailable/);
    assert.equal(api.getToken(), 'fixture-current');
    assert.deepEqual(events, []);
  });
}
test('account and incident API methods retain validated server contracts', async () => {
  const calls = [];
  const { api } = createClient(async (url, options) => { calls.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) }); return reply({ data: [], has_more: false }); });
  await api.getUsers(2);
  await api.createUser({ username: 'fixture', password: 'fixture-password', role: 'VIEWER' });
  await api.updateUser('fixture-id', { role: 'VIEWER', is_active: false });
  await api.resetPassword('fixture-id', 'fixture-password');
  await api.getIncidents('resolved', 2);
  assert.equal(calls[0].url, '/api/users?page=2');
  assert.equal(calls[1].method, 'POST'); assert.deepEqual(calls[1].body, { username: 'fixture', password: 'fixture-password', role: 'VIEWER' });
  assert.equal(calls[2].method, 'PATCH'); assert.equal(calls[2].url, '/api/users/fixture-id');
  assert.equal(calls[3].url, '/api/users/fixture-id/reset-password');
  assert.equal(calls[4].url, '/api/incidents?state=resolved&page=2&page_size=20');
});
