const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(fs.readFileSync('src/hooks/useSession.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

// Run the real hook callbacks with isolated React state, events and API promises.
function sessionHook() {
  const state = [], listeners = new Map(), module = { exports: {} };
  let index = 0, token = 'old-token', finishLogout, failLogout;
  const api = {
    getCurrentUser: () => ({ id: 'old', username: 'old', role: 'ADMIN' }),
    getToken: () => token,
    logout: () => new Promise((resolve, reject) => {
      finishLogout = (result) => { if (token === 'old-token') token = null; resolve(result); };
      failLogout = reject;
    }),
    login: async () => { token = 'new-token'; return { id: 'new', username: 'new', role: 'ADMIN' }; },
  };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require: (name) => name === 'react' ? {
      useState: (initial) => { const i = index++; state[i] = initial; return [state[i], (value) => { state[i] = value; }]; },
      useEffect: (effect) => effect(),
    } : { api },
    window: { addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener() {} },
  });
  return {
    hook: module.exports.useSession(), state,
    expire: () => { token = null; listeners.get('zt-session-expired')(); },
    finish: (result) => finishLogout(result), fail: () => failLogout(new Error('fixture offline')),
  };
}

test('late logout success or failure cannot replace a newer UI login', async () => {
  for (const failed of [false, true]) {
    const current = sessionHook();
    const pending = current.hook.logout();
    current.expire();
    await current.hook.login('fixture');
    assert.equal(current.state[0].username, 'new');
    if (failed) current.fail(); else current.finish({ serverRevoked: true });
    await pending;
    assert.equal(current.state[0].username, 'new');
    assert.equal(current.state[3], null);
  }
});

test('ordinary logout clears the UI and reports unconfirmed server revocation', async () => {
  for (const serverRevoked of [true, false]) {
    const current = sessionHook();
    const pending = current.hook.logout();
    current.finish({ serverRevoked });
    await pending;
    assert.equal(current.state[0], null);
    if (serverRevoked) assert.equal(current.state[3], null);
    else assert.match(current.state[3], /chưa xác nhận thu hồi/);
  }
});
