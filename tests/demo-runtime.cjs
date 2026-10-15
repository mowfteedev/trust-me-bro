// Kiểm tra chức năng thật trong cụm demo. demo.py truyền credentials qua stdin.
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { Pool } = require('pg');
const base = 'http://127.0.0.1:3000';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let passed = 0;
function check(condition, name) { assert.ok(condition, name); console.log(`PASS ${++passed}: ${name}`); }
async function api(path, token, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
}
async function login(username, password) {
  const response = await api('/api/auth/login', null, { username, password });
  assert.equal(response.status, 200);
  return response.body.token;
}
async function terminal(nodeId, ticket, command, expected) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:3000/ws/terminal/${nodeId}`);
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('Terminal timeout')); }, 10000);
    let output = '';
    let complete = false;
    socket.on('open', () => socket.send(JSON.stringify({ type: 'AUTH', ticket })));
    socket.on('message', (data) => {
      const text = data.toString();
      try {
        const frame = JSON.parse(text);
        if (frame.type === 'ERROR') { clearTimeout(timeout); socket.close(); reject(new Error(frame.message)); return; }
        if (frame.type === 'READY') {
          socket.send(JSON.stringify({ type: 'RESIZE', rows: 32, cols: 100 }));
          socket.send(command + '\n');
          return;
        }
      } catch {}
      output += text;
      if (output.includes(expected)) { complete = true; socket.close(); }
    });
    socket.on('error', (error) => { clearTimeout(timeout); reject(error); });
    socket.on('close', () => {
      clearTimeout(timeout);
      if (complete) resolve(output); else reject(new Error('Terminal đóng trước kết quả lệnh'));
    });
  });
}
async function waitFor(fn, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (true) {
    if (await fn()) return;
    if (Date.now() >= deadline) throw new Error('Điều kiện chưa đạt trong deadline');
    // Poll trạng thái thật; không giả định công việc đã xong sau một hard sleep.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
async function main() {
  check((await api('/readyz')).status === 200, 'Gateway + PostgreSQL ready');
  check((await api('/api/nodes')).status === 401, 'Chưa login không đọc nodes');
  check((await api('/api/auth/login', null, { username: 'demo-admin', password: 'wrong-password' })).status === 401, 'Mật khẩu sai bị từ chối');
  const viewer = await login('demo-viewer', credentials.viewer_password);
  const admin = await login('demo-admin', credentials.admin_password);
  check((await api('/api/auth/me', viewer)).body.user.role === 'VIEWER', 'Viewer có vai trò từ DB');
  check((await api('/api/auth/me', admin)).body.user.role === 'ADMIN', 'Admin có vai trò từ DB');
  const forged = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ role: 'ADMIN' })).toString('base64url') + '.';
  check((await api('/api/nodes', forged)).status === 401, 'JWT unsigned bị từ chối');
  let nodes;
  await waitFor(async () => {
    const response = await api('/api/nodes', viewer);
    nodes = response.body.data;
    return response.status === 200 && nodes.some((node) => node.name === 'node-worker-01' && node.status === 'HEALTHY' && node.latest_metric);
  }, 12000);
  const node = nodes.find((item) => item.name === 'node-worker-01');
  check(node.latest_metric.cpu_percent >= 0 && node.latest_metric.memory_total_bytes > 0 && node.latest_metric.disk_total_bytes > 0, 'Telemetry thật CPU/RAM/disk hiển thị qua API');
  check(node.latest_metric.network_rx_bytes >= 0 && node.latest_metric.network_tx_bytes >= 0 && node.latest_metric.uptime_seconds > 0, 'Network I/O + uptime thật qua API');
  const history = await api(`/api/nodes/${node.id}/history`, viewer);
  check(history.status === 200 && history.body.data.length > 0, 'Viewer đọc lịch sử biểu đồ');
  check((await api('/api/bastion/ticket', viewer, { node_id: node.id })).status === 403, 'Viewer không lấy vé SSH');
  const ticket = await api('/api/bastion/ticket', admin, { node_id: node.id });
  check(ticket.status === 200, 'Admin lấy vé SSH');
  const auditSince = (await pool.query('SELECT now()::text AS stamp')).rows[0].stamp;
  // Tạo marker chỉ trong stdout của shell, không nằm nguyên vẹn trong lệnh bị echo.
  const output = await terminal(node.id, ticket.body.ticket, "printf 'ZT_%s_OK\\n' REAL; id; stty size", 'ZT_REAL_OK\r\nuid=');
  check(output.includes('ztuser'), 'WebSocket→SSH→PTY thực thi lệnh thật qua WireGuard');
  await waitFor(async () => {
    const events = await pool.query(
      `SELECT details->>'session_id' AS session_id FROM audit_logs
       WHERE details->>'node_id' = $1 AND created_at >= $2::timestamptz
         AND action IN ('BASTION_SESSION_START','BASTION_SESSION_END')
       GROUP BY details->>'session_id' HAVING count(DISTINCT action) = 2;`,
      [node.id, auditSince],
    );
    return events.rows.some((row) => row.session_id);
  });
  check(true, 'Audit có START + END sau đóng terminal');
  const revocationTicket = await api('/api/bastion/ticket', admin, { node_id: node.id });
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:3000/ws/terminal/${node.id}`);
    const deadline = setTimeout(() => { socket.terminate(); reject(new Error('Phiên SSH chưa bị thu hồi sau logout')); }, 10000);
    let logoutRequest;
    socket.on('open', () => socket.send(JSON.stringify({ type: 'AUTH', ticket: revocationTicket.body.ticket })));
    socket.on('message', (data) => {
      try {
        if (JSON.parse(data.toString()).type === 'READY' && !logoutRequest) {
          logoutRequest = api('/api/auth/logout', admin, {});
        }
      } catch {}
    });
    socket.on('error', reject);
    socket.on('close', async (code) => {
      clearTimeout(deadline);
      try {
        assert.equal(code, 4403);
        assert.equal((await logoutRequest)?.status, 200);
        resolve();
      } catch (error) { reject(error); }
    });
  });
  check(true, 'Đăng xuất đóng phiên SSH đang mở bằng session revocation');
  check((await api('/api/auth/me', admin)).status === 401, 'Đăng xuất thu hồi JWT trên server');
  check((await api('/api/auth/logout', viewer, {})).status === 200, 'Viewer đăng xuất được');
  console.log(`${passed} kiểm tra chức năng thật đạt; Telegram thật và VM không nằm trong bài này.`);
}
main().catch((error) => { console.error('FAIL:', error.message); process.exitCode = 1; }).finally(() => pool.end());
