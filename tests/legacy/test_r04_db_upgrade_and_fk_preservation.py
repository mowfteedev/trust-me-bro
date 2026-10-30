#!/usr/bin/env python3
import hashlib
import json
import subprocess
import time
import uuid

def run_in_gateway(cmd_list):
    full_cmd = ["docker", "exec", "zt_gateway"] + cmd_list
    res = subprocess.run(full_cmd, capture_output=True, text=True)
    return res.returncode, res.stdout, res.stderr

def run_sql(sql):
    cmd = ["docker", "exec", "zt_postgres", "psql", "-U", "zt_admin", "-d", "zt_serverops", "-v", "ON_ERROR_STOP=1", "-c", sql]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"SQL Error: {res.stderr}\nQuery: {sql}")
    return res.stdout

def test_db_upgrade_and_fk_preservation():
    print("======================================================================")
    print("🧪 [TEST N04 UPGRADE] Kiểm thử nâng cấp CSDL và bảo toàn FK lịch sử")
    print("======================================================================")

    test_node_uuid = str(uuid.uuid4())
    node_name = f"upg-node-{test_node_uuid[:8]}"
    node_ip = f"10.100.{(int(test_node_uuid[:2], 16) % 250) + 1}.{(int(test_node_uuid[2:4], 16) % 250) + 1}"
    raw_default_token = "secret-token-sample-for-upgrade-test-" + test_node_uuid[:8]
    token_prefix = raw_default_token[:8]
    token_hash = hashlib.sha256(raw_default_token.encode()).hexdigest()

    print("1. Tạo node ban đầu với dữ liệu metrics, alerts và audit FK...")
    run_sql(f"""
        INSERT INTO nodes (id, name, ip_address, node_type, token_hash, token_prefix, status)
        VALUES ('{test_node_uuid}', '{node_name}', '{node_ip}', 'DOCKER', '{token_hash}', '{token_prefix}', 'HEALTHY');

        INSERT INTO metrics_history (node_id, cpu_percent, ram_used_bytes, ram_total_bytes, ram_percent, disk_used_bytes, disk_total_bytes, disk_percent, network_rx_bytes, network_tx_bytes, uptime_seconds, recorded_at)
        VALUES ('{test_node_uuid}', 15.5, 524288000, 1048576000, 50.0, 10737418240, 21474836480, 50.0, 1024, 2048, 3600, (now() AT TIME ZONE 'UTC'));

        INSERT INTO alerts (node_id, severity, message, triggered_at)
        VALUES ('{test_node_uuid}', 'WARNING', 'High CPU during upgrade baseline', (now() AT TIME ZONE 'UTC'));

        INSERT INTO audit_logs (node_id, action, target, details, ip_address)
        VALUES ('{test_node_uuid}', 'UPGRADE_BASELINE_LOG', 'node', '{{"state": "pre-upgrade"}}', '127.0.0.1'::inet);
    """)

    # Kiểm tra số lượng trước migration
    pre_metrics = run_sql(f"SELECT COUNT(*) FROM metrics_history WHERE node_id = '{test_node_uuid}';").splitlines()[2].strip()
    pre_alerts = run_sql(f"SELECT COUNT(*) FROM alerts WHERE node_id = '{test_node_uuid}';").splitlines()[2].strip()
    pre_audit = run_sql(f"SELECT COUNT(*) FROM audit_logs WHERE node_id = '{test_node_uuid}';").splitlines()[2].strip()
    assert pre_metrics == "1", f"Metrics ban đầu sai: {pre_metrics}"
    assert pre_alerts == "1", f"Alerts ban đầu sai: {pre_alerts}"
    assert pre_audit == "1", f"Audit ban đầu sai: {pre_audit}"
    print(f"✔ Dữ liệu pre-upgrade: Metrics={pre_metrics}, Alerts={pre_alerts}, Audit={pre_audit}")

    print("2. Chạy migration 006 cập nhật thu hồi token (soft revoke với is_token_revoked)...")
    run_sql(f"""
        ALTER TABLE public.nodes ADD COLUMN IF NOT EXISTS is_token_revoked BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE public.nodes ALTER COLUMN token_hash TYPE VARCHAR(128);

        UPDATE public.nodes
        SET is_token_revoked = TRUE, updated_at = (now() AT TIME ZONE 'UTC')
        WHERE token_prefix = 'secret-t' OR id = '{test_node_uuid}';
    """)

    print("3. Xác minh tính toàn vẹn của dữ liệu sau nâng cấp:")
    post_node = run_sql(f"SELECT id, name, is_token_revoked FROM nodes WHERE id = '{test_node_uuid}';")
    assert node_name in post_node, "Node bị mất sau migration!"
    assert "| t" in post_node or "| true" in post_node.lower(), "Cờ is_token_revoked chưa được bật!"

    post_metrics = run_sql(f"SELECT COUNT(*) FROM metrics_history WHERE node_id = '{test_node_uuid}';").splitlines()[2].strip()
    post_alerts = run_sql(f"SELECT COUNT(*) FROM alerts WHERE node_id = '{test_node_uuid}';").splitlines()[2].strip()
    post_audit = run_sql(f"SELECT COUNT(*) FROM audit_logs WHERE node_id = '{test_node_uuid}';").splitlines()[2].strip()

    assert int(post_metrics) >= 1, f"LỖI: Metrics history bị mất! ({post_metrics})"
    assert int(post_alerts) >= 1, f"LỖI: Alerts bị mất! ({post_alerts})"
    assert int(post_audit) >= 1, f"LỖI: Audit logs bị mất! ({post_audit})"
    print(f"✅ [FK INTEGRITY PASS] 100% dữ liệu lịch sử được bảo toàn: Metrics={post_metrics}, Alerts={post_alerts}, Audit={post_audit}!")

    print("\n4. Kiểm tra các luồng xác thực Telemetry Ingest API:")

    # 4a. Thiếu header
    cmd_missing = ["node", "-e", """
        const http = require('http');
        const req = http.request({
            hostname: '127.0.0.1', port: 3000, path: '/api/telemetry/beacon', method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => console.log(JSON.stringify({ status: res.statusCode, body: JSON.parse(data) })));
        });
        req.write(JSON.stringify({ cpu_usage: 10.0, memory_usage: 20.0 }));
        req.end();
    """]
    code, stdout, stderr = run_in_gateway(cmd_missing)
    res = json.loads(stdout.strip())
    assert res["status"] == 401 and res["body"]["code"] == "MISSING_NODE_TOKEN"
    print(f"✅ 4a. Thiếu token -> 401 MISSING_NODE_TOKEN (PASS)")

    # 4b. Token không tồn tại
    cmd_invalid = ["node", "-e", """
        const http = require('http');
        const req = http.request({
            hostname: '127.0.0.1', port: 3000, path: '/api/telemetry/beacon', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Node-Token': 'non_existent_fake_token_99999' }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => console.log(JSON.stringify({ status: res.statusCode, body: JSON.parse(data) })));
        });
        req.write(JSON.stringify({ cpu_usage: 10.0, memory_usage: 20.0 }));
        req.end();
    """]
    code, stdout, stderr = run_in_gateway(cmd_invalid)
    res = json.loads(stdout.strip())
    assert res["status"] == 401 and res["body"]["code"] == "INVALID_NODE_TOKEN"
    print(f"✅ 4b. Token giả mạo -> 401 INVALID_NODE_TOKEN (PASS)")

    # 4c. Token mẫu đã bị thu hồi
    cmd_revoked = ["node", "-e", f"""
        const http = require('http');
        const req = http.request({{
            hostname: '127.0.0.1', port: 3000, path: '/api/telemetry/beacon', method: 'POST',
            headers: {{ 'Content-Type': 'application/json', 'X-Node-Token': '{raw_default_token}' }}
        }}, res => {{
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => console.log(JSON.stringify({{ status: res.statusCode, body: JSON.parse(data) }})));
        }});
        req.write(JSON.stringify({{ cpu_usage: 10.0, memory_usage: 20.0 }}));
        req.end();
    """]
    code, stdout, stderr = run_in_gateway(cmd_revoked)
    res = json.loads(stdout.strip())
    assert res["status"] == 401 and res["body"]["code"] == "REVOKED_NODE_TOKEN"
    print(f"✅ 4c. Token bị thu hồi -> 401 REVOKED_NODE_TOKEN (PASS)")

    # 4d. Cấp token mới hợp lệ cho node -> Ingest thành công
    new_valid_token = f"valid-new-token-{test_node_uuid[:8]}-{time.time_ns()}"
    new_prefix = new_valid_token[:8]
    new_hash = hashlib.sha256(new_valid_token.encode()).hexdigest()

    run_sql(f"""
        UPDATE nodes
        SET token_hash = '{new_hash}', token_prefix = '{new_prefix}', is_token_revoked = FALSE, updated_at = (now() AT TIME ZONE 'UTC')
        WHERE id = '{test_node_uuid}';
    """)

    cmd_valid = ["node", "-e", f"""
        const http = require('http');
        const req = http.request({{
            hostname: '127.0.0.1', port: 3000, path: '/api/telemetry/beacon', method: 'POST',
            headers: {{ 'Content-Type': 'application/json', 'X-Node-Token': '{new_valid_token}' }}
        }}, res => {{
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => console.log(JSON.stringify({{ status: res.statusCode, body: data ? JSON.parse(data) : {{}} }})));
        }});
        req.write(JSON.stringify({{
            node_id: '{node_name}',
            timestamp: Date.now(),
            cpu: {{ percent: 22.4, load_avg: [0.5, 0.4, 0.3] }},
            memory: {{ total_bytes: 2147483648, used_bytes: 1073741824, percent: 50.0 }},
            disk: {{ total_bytes: 21474836480, used_bytes: 10737418240, percent: 50.0 }},
            network: {{ rx_bytes: 4096, tx_bytes: 8192 }},
            uptime_seconds: 3600
        }}));
        req.end();
    """]
    code, stdout, stderr = run_in_gateway(cmd_valid)
    res = json.loads(stdout.strip())
    assert res["status"] in (200, 204), f"Ingest với token mới thất bại: {res}"
    print(f"✅ 4d. Token mới hợp lệ -> HTTP {res['status']} Ingest thành công (PASS)")

    print("\n🎉 [TEST N04 HOÀN TẤT] Nâng cấp DB và phân loại Ingest API đạt 100%!")

if __name__ == "__main__":
    test_db_upgrade_and_fk_preservation()
