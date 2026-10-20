/**
 * ==============================================================================
 * BỘ KIỂM CHỨNG LOGIC VÒNG 3 THEO ĐẶC TẢ CỦA CHUYÊN GIA ĐỘC LẬP
 * File: tests/test_round3_probes.cjs
 * ==============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { stripTypeScriptTypes } = require('node:module');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const results = [];

function scheduler() {
  let now = 0;
  let hrNowNs = 0n;
  const jobs = new Set();
  class Clock extends Date { static now() { return now; } }
  return {
    jobs,
    Clock,
    advance(ms) {
      now = ms; // Wall-clock Date.now có thể lùi hoặc nhảy
    },
    advanceHr(ms) {
      hrNowNs += BigInt(ms) * 1_000_000n; // Monotonic hrtime chỉ tiến về phía trước
    },
    hrtimeBigint() {
      return hrNowNs;
    },
    setInterval(fn, ms) { const h = { fn, ms, unref() {} }; jobs.add(h); return h; },
    clearInterval(h) { jobs.delete(h); },
    setTimeout(fn, ms) { const h = { fn, ms, unref() {} }; jobs.add(h); return h; },
    clearTimeout(h) { jobs.delete(h); }
  };
}

async function load(file, deps, sched = scheduler()) {
  const quiet = { log() {}, warn() {}, error() {} };
  const mockProcess = {
    env: { NODE_ENV: 'production' },
    cwd: () => root,
    hrtime: { bigint: () => sched.hrtimeBigint() }
  };
  const context = vm.createContext({
    console: quiet,
    Buffer,
    Date: sched.Clock,
    Math,
    Number,
    JSON,
    process: mockProcess,
    setInterval: sched.setInterval,
    clearInterval: sched.clearInterval,
    setTimeout: sched.setTimeout,
    clearTimeout: sched.clearTimeout
  });

  const code = stripTypeScriptTypes(fs.readFileSync(path.join(root, file), 'utf8'), { mode: 'transform' });
  const m = new vm.SourceTextModule(code, { context });
  await m.link(async (spec) => {
    const val = spec === 'fastify' ? { FastifyInstance: undefined, FastifyPluginAsync: undefined } : deps[spec];
    if (!val) throw Error('Missing dependency: ' + spec);
    return new vm.SyntheticModule(Object.keys(val), function () {
      for (const [k, v] of Object.entries(val)) this.setExport(k, v);
    }, { context });
  });
  await m.evaluate();
  return m.namespace;
}

class Socket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.messages = [];
    this.closes = [];
    this.pauses = 0;
    this.resumes = 0;
  }
  send(x) { this.messages.push(x); }
  close(code, reason) {
    this.closes.push({ code, reason });
    if (code === 1006) throw Error('Reserved close code 1006');
    this.readyState = 3;
    this.emit('close');
  }
  pause() { this.pauses++; }
  resume() { this.resumes++; }
}

async function makeBastion(query) {
  const sched = scheduler();
  const probes = [], clients = [];
  class Probe extends EventEmitter {
    constructor() { super(); probes.push(this); }
    setTimeout() {}
    connect() {}
    destroy() { this.destroyed = true; }
  }
  class SSH extends EventEmitter {
    constructor() { super(); clients.push(this); }
    connect(opts) { this.opts = opts; }
    shell(opts, cb) { this.shellCb = cb; }
    end() { this.ended = true; }
  }
  const b = await load('gateway/src/services/bastion.ts', {
    'node:fs': { default: { readFileSync: () => Buffer.from('lab-key') } },
    'node:net': { default: { Socket: Probe } },
    'node:crypto': { default: crypto },
    ssh2: { Client: SSH },
    '../config/env.js': { config: { BASTION_SSH_KEY_PATH: 'lab', BASTION_DEFAULT_USER: 'root' } },
    './db.js': { query },
    '../utils/crypto.js': { generateSecureToken: n => crypto.randomBytes(n).toString('hex') }
  }, sched);
  return { b, sched, probes, clients };
}

const healthy = async (sql, params) => {
  if (sql.includes('ANY($1)')) return { rows: [{ id: 'u', role: 'ADMIN', is_active: true, session_version: 1 }] };
  if (sql.includes('FROM users')) return { rows: [{ id: params[0], role: 'ADMIN', is_active: true, session_version: 1 }] };
  if (sql.includes('FROM nodes')) return { rows: [{ id: 'node-uuid', name: 'n', ip_address: '10.0.0.2', host_key_fingerprint: 'a'.repeat(64) }] };
  return { rows: [] };
};

async function attach(h, user = 'u', node = 'n') {
  const socket = new Socket();
  await h.b.attachBastionSession(socket, node, h.b.createBastionTicket(node, user, 1));
  return socket;
}

async function ready(h) {
  const s = await attach(h);
  h.probes[0].emit('connect');
  h.clients[0].emit('ready');
  const stream = new EventEmitter();
  stream.destroy = () => { stream.destroyed = true; };
  stream.pause = () => { stream.pauses = (stream.pauses || 0) + 1; };
  stream.resume = () => { stream.resumes = (stream.resumes || 0) + 1; };
  stream.write = () => false;
  h.clients[0].shellCb(null, stream);
  return { s, stream };
}

(async () => {
  // TEST 1: User Quota Race
  {
    let release; const pending = new Promise(r => { release = r; });
    const h = await makeBastion((sql, params) => sql.includes('FROM users') ? pending : healthy(sql, params));
    const sockets = Array.from({ length: 6 }, () => new Socket());
    const tasks = sockets.map(s => h.b.attachBastionSession(s, 'n', h.b.createBastionTicket('n', 'u', 1)));
    release({ rows: [{ id: 'u', role: 'ADMIN', is_active: true, session_version: 1 }] });
    await Promise.all(tasks);
    results.push({
      test: 'concurrent same-user quota',
      probesCreated: h.probes.length,
      rejected4429: sockets.flatMap(s => s.closes).filter(x => x.code === 4429).length
    });
    sockets.forEach(s => s.close(1000, 'test end'));
  }

  // TEST 2: Node Quota Across 11 Users
  {
    const h = await makeBastion(healthy);
    const sockets = [];
    for (let i = 0; i < 11; i++) sockets.push(await attach(h, 'u' + i));
    results.push({
      test: 'same-node quota across 11 users',
      probesCreated: h.probes.length,
      rejected4429: sockets.flatMap(s => s.closes).filter(x => x.code === 4429).length
    });
    sockets.forEach(s => s.close(1000, 'test end'));
  }

  // TEST 3: N06 - Monotonic Watchdog 500ms SLA <= 5.2s
  {
    let checks = 0;
    const h = await makeBastion((sql, params) => {
      if (sql.includes('ANY($1)')) { checks++; return new Promise(() => {}); }
      return healthy(sql, params);
    });
    const { s } = await ready(h);
    const watchdog = [...h.sched.jobs].find(x => x.ms === 500);
    // Tiến tới 4500ms: socket vẫn mở
    h.sched.advance(4500);
    h.sched.advanceHr(4500);
    watchdog.fn();
    const stillOpenAt4500 = s.readyState === 1;

    // Tiến thêm 500ms (đạt mốc 5000ms): watchdog đóng ngay lập tức với 4503
    h.sched.advance(500);
    h.sched.advanceHr(500);
    watchdog.fn();
    results.push({
      test: 'monotonic watchdog strict 5s SLA',
      stillOpenAt4500,
      closesAt5000: s.closes,
      pendingBatchQueries: checks
    });
  }

  // TEST 4: N06 - Wall-clock lùi giờ không làm treo lease (Monotonic Protection)
  {
    const h = await makeBastion((sql, params) => sql.includes('ANY($1)') ? new Promise(() => {}) : healthy(sql, params));
    const { s } = await ready(h);
    const watchdog = [...h.sched.jobs].find(x => x.ms === 500);
    // Wall-clock Date.now lùi 60 giây, nhưng hrtime tiến 5000ms
    h.sched.advance(-60000); // Date.now nhảy lùi
    h.sched.advanceHr(5000); // Monotonic hrtime vẫn tiến 5000ms
    watchdog.fn();
    results.push({
      test: 'wall-clock steps backwards protected by monotonic clock',
      closedAt5000Hrtime: s.closes.some(c => c.code === 4503),
      wallClockMs: -60000
    });
    s.close(1000, 'test end');
  }

  // TEST 5: N05 - Bounded Queue 64KB & Overload Protection
  {
    const h = await makeBastion(healthy);
    const { s, stream } = await ready(h);
    let writes = 0, bytesAcceptedByStream = 0;
    stream.write = (chunk) => {
      writes++;
      bytesAcceptedByStream += chunk.length;
      return false; // Stream báo nghẽn
    };

    // Gửi chunk 1 (64KB): Stream nhận, stream.write trả false, socket pause
    s.emit('message', Buffer.alloc(65536));
    // Gửi chunk 2 (64KB): Đang paused -> vào queue (64KB tổng)
    s.emit('message', Buffer.alloc(65536));
    // Gửi chunk 3 (1 byte): Vượt trần 64KB -> trigger đóng phiên bảo vệ Gateway (4429)
    s.emit('message', Buffer.alloc(1));

    results.push({
      test: 'bounded queue 64KB limit and overflow protection',
      writesToUnderlyingStream: writes,
      bytesAcceptedByUnderlyingStream: bytesAcceptedByStream,
      socketClosed4429: s.closes.some(c => c.code === 4429),
      pauseCalls: s.pauses
    });
  }

  // TEST 6: N07 - New user session added during batch DB check NOT revoked
  {
    let release; const pending = new Promise(r => { release = r; });
    const h = await makeBastion((sql, params) => sql.includes('ANY($1)') ? pending : healthy(sql, params));
    const first = await attach(h, 'u');
    const checker = [...h.sched.jobs].find(x => x.ms === 2000);
    const inFlight = checker.fn();

    // Thêm user hợp lệ v trong lúc query đang pending
    const addedDuringCheck = await attach(h, 'v');
    release({ rows: [{ id: 'u', role: 'ADMIN', is_active: true, session_version: 1 }] });
    await inFlight;

    results.push({
      test: 'new valid user session added during batch DB check',
      firstUserStillOpen: first.readyState === 1,
      newlyAddedUserStillOpen: addedDuringCheck.readyState === 1,
      newlyAddedUserClosesCount: addedDuringCheck.closes.length
    });
    first.close(1000, 'test end');
    addedDuringCheck.close(1000, 'test end');
  }

  // TEST 7: N08 - START audit resolves after browser disconnect triggers END audit
  {
    let releaseStart, signalEntered;
    const pendingStart = new Promise(r => { releaseStart = r; });
    const startEntered = new Promise(r => { signalEntered = r; });
    const auditQueries = [];
    const h = await makeBastion((sql, params) => {
      if (sql.includes('BASTION_SESSION_START')) {
        auditQueries.push('START');
        signalEntered();
        return pendingStart;
      }
      if (sql.includes('BASTION_SESSION_END')) {
        auditQueries.push('END');
      }
      return healthy(sql, params);
    });

    const s = new Socket();
    const p = h.b.attachBastionSession(s, 'n', h.b.createBastionTicket('n', 'u', 1));
    await startEntered;
    // Ngắt kết nối khi START audit đang pending query DB
    s.close(1000, 'closed during audit');
    releaseStart({ rows: [] });
    await p;

    results.push({
      test: 'START audit resolves after browser disconnect triggers END audit',
      auditQueries,
      hasEndAudit: auditQueries.includes('END'),
      probesCreated: h.probes.length
    });
  }

  // TEST 8: Telegram DB Atomic Compare-And-Set
  {
    const executedQueries = [];
    const tg = await load('gateway/src/services/telegram.ts', {
      '../config/env.js': { config: { TELEGRAM_BOT_TOKEN: '', TELEGRAM_PAIR_OTP: '123456' } },
      '../utils/crypto.js': { generateSecureToken: n => crypto.randomBytes(n).toString('hex'), generateNumericOtp: () => '123456' },
      './db.js': {
        query: async (sql, params) => {
          executedQueries.push({ sql, params });
          // Giả lập instance khác đã chiếm Chat ID -> rowCount = 0
          return { rowCount: 0, rows: [] };
        }
      }
    });

    const success = await tg.telegramService.pairWithOtp('chat-999', '123456');
    results.push({
      test: 'telegram atomic compare-and-set rejects concurrent hijack',
      rejectedWhenRowCountZero: success === false,
      hasCompareAndSetClause: executedQueries.some(q => q.sql.includes('WHERE system_settings.value = $1'))
    });
  }

  console.log(JSON.stringify({ runtime: process.version, results }, null, 2));
})().catch(err => {
  console.error('PROBE ERROR:', err);
  process.exit(1);
});
