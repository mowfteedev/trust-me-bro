const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync('src/hooks/useExcelExport.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function hook() {
  const module = { exports: {} }, state = [], cleanup = []; let updates = 0;
  vm.runInNewContext(code, { module, exports: module.exports, Error,
    require: () => ({ useRef: value => ({ current: value }),
      useEffect: effect => cleanup.push(effect()),
      useState: initial => { const index = state.length; state.push(initial); return [initial, value => { updates++; state[index] = value; }]; } }),
  });
  return { value: module.exports.useExcelExport(), state, cleanup, updates: () => updates };
}
test('double clicks start only one export and errors release the button for a retry', async () => {
  const h = hook(); let calls = 0, reject;
  const pending = h.value.run(() => { calls++; return new Promise((_resolve, fail) => { reject = fail; }); });
  await h.value.run(async () => { calls++; });
  assert.equal(calls, 1); assert.equal(h.state[0], true);
  reject(new Error('Hãy thu hẹp bộ lọc')); await pending;
  assert.equal(h.state[0], false); assert.match(h.state[1], /thu hẹp/);
  await h.value.run(async () => { calls++; });
  assert.equal(calls, 2); assert.equal(h.state[1], null);
});
test('a late export result cannot update the state of an unmounted page', async () => {
  const h = hook(); let finish;
  const pending = h.value.run(() => new Promise(resolve => { finish = resolve; }));
  h.cleanup.forEach(fn => fn()); const before = h.updates();
  finish(); await pending; assert.equal(h.updates(), before);
});
