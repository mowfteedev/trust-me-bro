#!/usr/bin/env python3
"""
BÀI KIỂM THỬ THỰC CHIẾN R3-05: TELEMETRY INGEST EXACT HASH & PHÂN LOẠI MÃ LỖI TRÊN MÔI TRƯỜNG RUNTIME THẬT
Dự án: ZT-ServerOps
Phụ trách: security (chủ trì), backend, tester
Tham chiếu: R3-05 & P1 từ REVIEW_round3_bf12171.md

MỤC TIÊU KIỂM CHỨNG TRÊN FASTIFY THẬT:
1. Gửi request thiếu header X-Node-Token -> Trả về 401 MISSING_NODE_TOKEN.
2. Gửi token ngẫu nhiên sai hoàn toàn -> Trả về 401 INVALID_NODE_TOKEN.
3. Gửi token sai nhưng CÓ CHUNG PREFIX 'secret-t' (ví dụ 'secret-token-worker-FAKE') ->
   ĐÃ LOẠI BỎ PREFIX FALLBACK: Bắt buộc trả về 401 INVALID_NODE_TOKEN (không bị nhận nhầm là REVOKED).
4. Gửi credential mẫu 'secret-token-worker-01' (đã bị thu hồi trong migration 007 bằng exact hash) ->
   Trả về 401 REVOKED_NODE_TOKEN.
5. Tạo một node mới hợp lệ với token bí mật riêng: Gửi telemetry -> Trả về 200/201 THÀNH CÔNG.
"""

import subprocess
import json
import uuid
import hashlib

def run_in_gateway_node(script_js):
    cmd = ["docker", "exec", "-i", "zt_gateway", "node", "-"]
    res = subprocess.run(cmd, input=script_js, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"Lỗi chạy script trong gateway container: {res.stderr}")
    return json.loads(res.stdout.strip())

def send_telemetry_request(token=None, payload=None):
    if payload is None:
        payload = {
            "node_id": "test-active-node",
            "timestamp": 1728840000000,
            "cpu": { "percent": 25.5 },
            "memory": { "total_bytes": 16000000000, "used_bytes": 4000000000, "percent": 25.0 },
            "disk": { "total_bytes": 100000000000, "used_bytes": 30000000000, "percent": 30.0 },
            "network": { "rx_bytes": 102400, "tx_bytes": 204800 },
            "uptime_seconds": 3600
        }

    script = f"""
const http = require('http');

const payloadStr = JSON.stringify({json.dumps(payload)});
const headers = {{
  'Content-Type': 'application/json',
  'Content-Length': Buffer.byteLength(payloadStr)
}};

const token = {json.dumps(token)};
if (token !== null) {{
  headers['X-Node-Token'] = token;
}}

const req = http.request({{
  hostname: '127.0.0.1',
  port: 3000,
  path: '/api/telemetry',
  method: 'POST',
  headers
}}, (res) => {{
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {{
    let parsed;
    try {{ parsed = JSON.parse(body); }} catch (e) {{ parsed = {{ raw: body }}; }}
    console.log(JSON.stringify({{ status: res.statusCode, body: parsed }}));
  }});
}});

req.on('error', (err) => {{
  console.error(err);
  process.exit(1);
}});

req.write(payloadStr);
req.end();
"""
    return run_in_gateway_node(script)

print("🧪 [TEST R3-05] Bắt đầu kiểm tra Telemetry Ingest Token Authentication trên Gateway Node 20 thật...")

# 1. Missing Token
res1 = send_telemetry_request(token=None)
print(f"1. Missing Token -> Code: {res1['status']}, Error Code: {res1['body'].get('code')}")
assert res1['status'] == 401, f"Expected 401, got {res1['status']}"
assert res1['body'].get('code') == "MISSING_NODE_TOKEN", f"Expected MISSING_NODE_TOKEN, got {res1['body'].get('code')}"

# 2. Invalid Token (sai hoàn toàn)
res2 = send_telemetry_request(token="completely-invalid-random-token-xyz")
print(f"2. Invalid Token -> Code: {res2['status']}, Error Code: {res2['body'].get('code')}")
assert res2['status'] == 401, f"Expected 401, got {res2['status']}"
assert res2['body'].get('code') == "INVALID_NODE_TOKEN", f"Expected INVALID_NODE_TOKEN, got {res2['body'].get('code')}"

# Thiết lập node mẫu mang đúng exact hash của 'secret-token-worker-01' và trạng thái is_token_revoked = TRUE
revoked_hash = hashlib.sha256(b"secret-token-worker-01").hexdigest()
setup_sql = f"""
UPDATE nodes SET token_hash = '{revoked_hash}', is_token_revoked = TRUE WHERE name = 'node-worker-01';
INSERT INTO nodes (id, name, ip_address, token_prefix, token_hash, status, is_token_revoked)
SELECT 'c43b945d-6b6f-4d3c-8048-4cd1ad8b023e', 'node-worker-01', '10.100.0.10', 'secret-t', '{revoked_hash}', 'OFFLINE', TRUE
WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE name = 'node-worker-01');
"""
subprocess.run(["docker", "exec", "zt_postgres", "psql", "-U", "zt_admin", "-d", "zt_serverops", "-c", setup_sql], check=True, capture_output=True)

# 3. Invalid Token nhưng CHUNG PREFIX 'secret-t' (Test R3-05 quan trọng: Chống False REVOKED)
res3 = send_telemetry_request(token="secret-token-worker-FAKE-ATTACKER")
print(f"3. Invalid Token chung prefix 'secret-t' -> Code: {res3['status']}, Error Code: {res3['body'].get('code')}")
assert res3['status'] == 401, f"Expected 401, got {res3['status']}"
assert res3['body'].get('code') == "INVALID_NODE_TOKEN", f"Expected INVALID_NODE_TOKEN (Bỏ prefix fallback), got {res3['body'].get('code')}"

# 4. Token mẫu đã thu hồi 'secret-token-worker-01' (Hash: 10a3ce77...)
res4 = send_telemetry_request(token="secret-token-worker-01")
print(f"4. Revoked Token mẫu -> Code: {res4['status']}, Error Code: {res4['body'].get('code')}")
assert res4['status'] == 401, f"Expected 401, got {res4['status']}"
assert res4['body'].get('code') == "REVOKED_NODE_TOKEN", f"Expected REVOKED_NODE_TOKEN, got {res4['body'].get('code')}"

# 5. Tạo một node hợp lệ trong database và gửi Telemetry thành công
valid_token = "valid-prod-token-" + uuid.uuid4().hex
token_hash = hashlib.sha256(valid_token.encode("utf-8")).hexdigest()
node_id = str(uuid.uuid4())

# Thêm node vào CSDL qua docker exec psql
sql = f"""
INSERT INTO nodes (id, name, ip_address, token_prefix, token_hash, status, is_token_revoked)
VALUES ('{node_id}', 'test-active-node', '10.100.0.99', '{valid_token[:8]}', '{token_hash}', 'HEALTHY', FALSE)
ON CONFLICT (name) DO UPDATE SET token_hash = EXCLUDED.token_hash, is_token_revoked = FALSE, status = 'HEALTHY';
"""
db_res = subprocess.run(
    ["docker", "exec", "zt_postgres", "psql", "-U", "zt_admin", "-d", "zt_serverops", "-c", sql],
    capture_output=True, text=True
)
assert db_res.returncode == 0, f"Lỗi tạo node test: {db_res.stderr}"

res5 = send_telemetry_request(token=valid_token)
print(f"5. Valid Token mới -> Code: {res5['status']}, Response: {res5['body'].get('message', res5['body'].get('status'))}")
assert res5['status'] in (200, 201), f"Expected 200/201, got {res5['status']}"

print("\n=============================================================")
print("🎉 [ALL TESTS PASS] Kiểm thử Telemetry Ingest R3-05 ĐẠT CHUẨN 100%!")
print("=============================================================")
