const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

test('hidden tabs stop polling, resume once, and cleanup prevents later requests', () => {
  const source = ts.transpileModule(fs.readFileSync('src/utils/visiblePolling.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const timers = new Map(), listeners = new Map(), module = { exports: {} };
  let id = 0, calls = 0;
  const document = { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name) };
  vm.runInNewContext(source, { module, exports: module.exports, document,
    setInterval: fn => { timers.set(++id, fn); return id; }, clearInterval: id => timers.delete(id) });
  const stop = module.exports.startVisiblePolling(() => { calls++; }, 5000);
  assert.equal(calls, 1);
  assert.equal(timers.size, 1);
  [...timers.values()][0](); assert.equal(calls, 2);
  document.hidden = true; listeners.get('visibilitychange')();
  assert.equal(timers.size, 0); assert.equal(calls, 2);
  document.hidden = false; listeners.get('visibilitychange')();
  assert.equal(calls, 3); assert.equal(timers.size, 1);
  const lateTick = [...timers.values()][0];
  stop(); lateTick();
  assert.equal(calls, 3); assert.equal(timers.size, 0); assert.equal(listeners.size, 0);
});
