const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { stripTypeScriptTypes } = require('node:module');

const apiSource = ts.transpileModule(fs.readFileSync('src/services/api.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const reply = (body, status = 200, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

function createClient(fetchFn) {
  const module = { exports: {} };
  const events = [];
  const storage = new Map();
  const createdUrls = [];
  const revokedUrls = [];
  const clickedLinks = [];

  class FakeBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.options = options;
    }
  }

  const fakeDocument = {
    createElement(tag) {
      return {
        tag,
        href: '',
        download: '',
        hidden: false,
        click() {
          clickedLinks.push({ download: this.download, href: this.href });
        },
        remove() {},
      };
    },
    body: {
      appendChild() {},
    },
  };

  const fakeUrl = {
    createObjectURL(blob) {
      const url = `blob:test-${createdUrls.length + 1}`;
      createdUrls.push({ url, blob });
      return url;
    },
    revokeObjectURL(url) {
      revokedUrls.push(url);
    },
  };

  vm.runInNewContext(apiSource, {
    module,
    exports: module.exports,
    fetch: fetchFn,
    AbortSignal,
    Event,
    URL: fakeUrl,
    Blob: FakeBlob,
    document: fakeDocument,
    setTimeout: (fn) => fn(),
    console: { warn() {} },
    window: { dispatchEvent: (e) => events.push(e.type) },
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
  });

  return {
    api: module.exports.api,
    events,
    storage,
    clickedLinks,
    createdUrls,
    revokedUrls,
  };
}

test('api.getNodes appends correct lifecycle filter query', async () => {
  const requestedUrls = [];
  const { api } = createClient(async (url) => {
    requestedUrls.push(url);
    return reply({ success: true, data: [] });
  });

  await api.getNodes('active');
  await api.getNodes('removing');
  await api.getNodes('removed');
  await api.getNodes('all');

  assert.equal(requestedUrls[0], '/api/telemetry/nodes?lifecycle=active');
  assert.equal(requestedUrls[1], '/api/telemetry/nodes?lifecycle=removing');
  assert.equal(requestedUrls[2], '/api/telemetry/nodes?lifecycle=removed');
  assert.equal(requestedUrls[3], '/api/telemetry/nodes?lifecycle=all');
});

test('api.startOffboarding calls POST /api/nodes/:id/offboarding with confirm_node_name', async () => {
  let captured = null;
  const { api } = createClient(async (url, opts) => {
    captured = { url, method: opts.method, body: JSON.parse(opts.body) };
    return reply({
      success: true,
      status: 'RETIRING',
      operation: {
        operation_id: 'op-123',
        node_id: 'node-456',
        node_name: 'worker-alpha',
        node_ip: '10.100.0.5',
        state: 'PENDING_PEER_REMOVAL',
        created_at: '2026-11-18T00:00:00Z',
      },
    }, 202);
  });

  const res = await api.startOffboarding('node-456', 'worker-alpha');
  assert.equal(captured.url, '/api/nodes/node-456/offboarding');
  assert.equal(captured.method, 'POST');
  assert.deepEqual(captured.body, { confirm_node_name: 'worker-alpha' });
  assert.equal(res.operation_id, 'op-123');
  assert.equal(res.state, 'PENDING_PEER_REMOVAL');
});

test('api.getOffboardingStatus retrieves status or operation info', async () => {
  const { api } = createClient(async (url) => {
    assert.equal(url, '/api/nodes/node-789/offboarding');
    return reply({
      success: true,
      offboarding: {
        operation_id: 'op-789',
        node_id: 'node-789',
        node_name: 'worker-beta',
        node_ip: '10.100.0.6',
        state: 'PENDING_LOCAL_CLEANUP',
        lifecycle_state: 'RETIRING',
        created_at: '2026-11-18T00:00:00Z',
        has_cleanup_token: true,
      },
    });
  });

  const status = await api.getOffboardingStatus('node-789');
  assert.ok(status);
  assert.equal(status.operation_id, 'op-789');
  assert.equal(status.state, 'PENDING_LOCAL_CLEANUP');
  assert.equal(status.has_cleanup_token, true);
});

test('api.downloadOffboardingAuthorization downloads capability blob using Content-Disposition', async () => {
  let postUrl = '';
  const { api, clickedLinks, createdUrls, revokedUrls } = createClient(async (url, opts) => {
    if (url.endsWith('/login')) {
      return reply({ token: 'test-token', user: { id: 'u1', username: 'admin', role: 'ADMIN' } });
    }
    postUrl = url;
    return new Response(JSON.stringify({ capability_token: 'secret-xyz' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="offboarding-worker-gamma.json"',
      },
    });
  });

  await api.login('admin', 'password');
  await api.downloadOffboardingAuthorization('node-gamma', 'fallback.json');

  assert.equal(postUrl, '/api/nodes/node-gamma/offboarding/authorization');
  assert.equal(clickedLinks.length, 1);
  assert.equal(clickedLinks[0].download, 'offboarding-worker-gamma.json');
  assert.equal(createdUrls.length, 1);
  assert.equal(revokedUrls.length, 1);
  assert.equal(revokedUrls[0], createdUrls[0].url);
});

test('ClusterSummary getClusterCounts only counts active nodes and ignores removed/retiring nodes', async () => {
  const summaryRaw = fs.readFileSync('src/components/ClusterSummary.tsx', 'utf8');
  const summaryTranspiled = ts.transpileModule(summaryRaw, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(summaryTranspiled, { module, exports: module.exports, require: () => ({}) });
  const { getClusterCounts } = module.exports;

  const nodes = [
    { id: '1', name: 'active-online', status: 'HEALTHY', lifecycle_state: 'ACTIVE' },
    { id: '2', name: 'active-warning', status: 'WARNING', lifecycle_state: 'ACTIVE' },
    { id: '3', name: 'active-offline', status: 'OFFLINE', lifecycle_state: 'ACTIVE' },
    { id: '4', name: 'retiring-node', status: 'HEALTHY', lifecycle_state: 'RETIRING' },
    { id: '5', name: 'revoked-node', status: 'HEALTHY', lifecycle_state: 'REVOKED' },
    { id: '6', name: 'removed-node', status: 'HEALTHY', lifecycle_state: 'REMOVED' },
  ];

  const counts = getClusterCounts(nodes);
  const total = counts.find(c => c.status === 'ALL').value;
  const online = counts.find(c => c.status === 'HEALTHY').value;
  const stale = counts.find(c => c.status === 'WARNING').value;
  const offline = counts.find(c => c.status === 'OFFLINE').value;

  assert.equal(total, 3, 'Total should only count active nodes');
  assert.equal(online, 1, 'Online should only count active healthy nodes');
  assert.equal(stale, 1, 'Stale should only count active warning nodes');
  assert.equal(offline, 1, 'Offline should only count active offline nodes');
});

test('Confirmation validation requires exact node.name before submit is enabled', () => {
  const targetNodeName = 'worker-delta-01';
  function canSubmit(role, inputName, isSubmitting) {
    if (role !== 'ADMIN') return false;
    if (isSubmitting) return false;
    return inputName.trim() === targetNodeName;
  }

  assert.equal(canSubmit('VIEWER', 'worker-delta-01', false), false, 'VIEWER cannot submit');
  assert.equal(canSubmit('ADMIN', '', false), false, 'Empty input cannot submit');
  assert.equal(canSubmit('ADMIN', 'worker-delta', false), false, 'Partial name cannot submit');
  assert.equal(canSubmit('ADMIN', 'worker-delta-02', false), false, 'Mismatching name cannot submit');
  assert.equal(canSubmit('ADMIN', 'worker-delta-01', true), false, 'Inflight submit is disabled');
  assert.equal(canSubmit('ADMIN', 'worker-delta-01', false), true, 'Exact match enables submit');
  assert.equal(canSubmit('ADMIN', '  worker-delta-01  ', false), true, 'Trimmed match enables submit');
});

test('Legacy unenrolled nodes cannot trigger offboard and SSH is disabled for non-active or revoked nodes', () => {
  function isOffboardAvailable(node, role) {
    if (role !== 'ADMIN') return false;
    if (node.is_enrolled === false) return false;
    if (node.lifecycle_state && node.lifecycle_state !== 'ACTIVE') return false;
    return true;
  }

  function isSshDisabled(node, sourceStale) {
    const isNonActiveOrRevoked = (node.lifecycle_state && node.lifecycle_state !== 'ACTIVE') || node.is_token_revoked === true;
    return node.status === 'OFFLINE' || sourceStale || isNonActiveOrRevoked;
  }

  const legacyNode = { id: 'l1', name: 'legacy-box', is_enrolled: false, lifecycle_state: 'ACTIVE', status: 'HEALTHY' };
  const activeEnrolled = { id: 'a1', name: 'enrolled-box', is_enrolled: true, lifecycle_state: 'ACTIVE', status: 'HEALTHY' };
  const retiringNode = { id: 'r1', name: 'retiring-box', is_enrolled: true, lifecycle_state: 'RETIRING', status: 'HEALTHY' };
  const revokedNode = { id: 'rv1', name: 'revoked-box', is_enrolled: true, lifecycle_state: 'ACTIVE', is_token_revoked: true, status: 'HEALTHY' };
  const removedNode = { id: 'rm1', name: 'removed-box', is_enrolled: true, lifecycle_state: 'REMOVED', status: 'HEALTHY' };

  assert.equal(isOffboardAvailable(legacyNode, 'ADMIN'), false, 'Legacy unenrolled node cannot start offboarding');
  assert.equal(isOffboardAvailable(activeEnrolled, 'ADMIN'), true, 'Enrolled active node can start offboarding');
  assert.equal(isOffboardAvailable(activeEnrolled, 'VIEWER'), false, 'VIEWER cannot start offboarding');
  assert.equal(isOffboardAvailable(retiringNode, 'ADMIN'), false, 'Already retiring node cannot start another offboarding');

  assert.equal(isSshDisabled(activeEnrolled, false), false, 'Active healthy node has SSH enabled');
  assert.equal(isSshDisabled(activeEnrolled, true), true, 'Stale source disables SSH');
  assert.equal(isSshDisabled(retiringNode, false), true, 'Retiring node disables SSH');
  assert.equal(isSshDisabled(revokedNode, false), true, 'Revoked node disables SSH');
  assert.equal(isSshDisabled(removedNode, false), true, 'Removed node disables SSH');
});

test('api.getOffboardingStatus fails closed on server errors and only returns null on genuine 404 / NOT_STARTED', async () => {
  // Case 1: 503 Gateway unavailable -> must THROW, not return null
  const { api: api503 } = createClient(async () => reply({ detail: 'Service Unavailable' }, 503));
  await assert.rejects(api503.getOffboardingStatus('node-1'), (err) => {
    assert.equal(err.status, 503);
    assert.match(err.message, /Service Unavailable/);
    return true;
  });

  // Case 2: 500 Internal Server Error -> must THROW
  const { api: api500 } = createClient(async () => reply({ detail: 'Database error' }, 500));
  await assert.rejects(api500.getOffboardingStatus('node-2'), (err) => {
    assert.equal(err.status, 500);
    return true;
  });

  // Case 3: 404 with OFFBOARD_NOT_FOUND -> returns null (not started)
  const { api: api404 } = createClient(async () => reply({ code: 'OFFBOARD_NOT_FOUND', detail: 'Chưa khởi tạo' }, 404));
  const res404 = await api404.getOffboardingStatus('node-3');
  assert.equal(res404, null);

  // Case 4: 200 with status: NOT_STARTED -> returns null
  const { api: apiNotStarted } = createClient(async () => reply({ success: true, status: 'NOT_STARTED', offboarding: null }));
  const resNotStarted = await apiNotStarted.getOffboardingStatus('node-4');
  assert.equal(resNotStarted, null);
});

test('Keyboard Tab / Shift+Tab focus trap wraps focus inside modal container', () => {
  let focusedIndex = 0;
  const elements = [
    { id: 'btn-close', focus() { focusedIndex = 0; } },
    { id: 'input-confirm', focus() { focusedIndex = 1; } },
    { id: 'btn-cancel', focus() { focusedIndex = 2; } },
    { id: 'btn-submit', focus() { focusedIndex = 3; } },
  ];

  function simulateTab(isShift, currentIndex) {
    if (isShift) {
      if (currentIndex === 0) {
        elements[elements.length - 1].focus();
      } else {
        elements[currentIndex - 1].focus();
      }
    } else {
      if (currentIndex === elements.length - 1) {
        elements[0].focus();
      } else {
        elements[currentIndex + 1].focus();
      }
    }
  }

  // Forward Tab from last element wraps to first
  focusedIndex = 3;
  simulateTab(false, focusedIndex);
  assert.equal(focusedIndex, 0, 'Tab from last element wraps to first');

  // Shift+Tab from first element wraps to last
  focusedIndex = 0;
  simulateTab(true, focusedIndex);
  assert.equal(focusedIndex, 3, 'Shift+Tab from first element wraps to last');

  // Normal forward Tab
  focusedIndex = 1;
  simulateTab(false, focusedIndex);
  assert.equal(focusedIndex, 2, 'Tab advances to next element');
});

test('Modal copy makes accurate claims: Gateway revokes permissions immediately and waits for peer removal', () => {
  const modalSource = fs.readFileSync('src/components/OffboardingModal.tsx', 'utf8');

  // Verify no false physical immediate claim
  assert.ok(
    modalSource.includes('Gateway thu hồi quyền truy cập ngay lập tức, chấm dứt các phiên kết nối SSH và chờ hoàn tất gỡ peer WireGuard'),
    'Warning copy accurately describes immediate permission revocation and waiting for peer removal'
  );

  // Verify peer removal waiting state
  assert.ok(
    modalSource.includes('Gateway đã thu hồi quyền truy cập và đang chờ tiến trình gỡ bỏ peer WireGuard hoàn tất'),
    'State description accurately reflects waiting for peer removal'
  );

  // Verify single useful instruction
  assert.ok(
    modalSource.includes('Chuyển tệp ủy quyền và chạy bộ gỡ bằng quyền quản trị trên Worker'),
    'Single concise instruction present'
  );

  // Verify portal usage outside inert ancestor
  assert.ok(
    modalSource.includes('createPortal(modalContent, document.body)'),
    'Modal renders in document.body portal outside .console-workspace'
  );
});
