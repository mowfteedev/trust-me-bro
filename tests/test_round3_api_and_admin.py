#!/usr/bin/env python3
import json
import os
import subprocess
import urllib.request
import urllib.error
import stat
import hashlib

GATEWAY_URL = "http://127.0.0.1:3000"

def run_in_gateway(cmd_list):
    full_cmd = ["docker", "exec", "zt_gateway"] + cmd_list
    res = subprocess.run(full_cmd, capture_output=True, text=True)
    return res.returncode, res.stdout, res.stderr

def test_bootstrap_admin_cli_security():
    print("🧪 [TEST ADMIN] 1. Kiểm tra chặn cờ --password qua CLI (chống lộ trong ps aux)...")
    code, stdout, stderr = run_in_gateway(["node", "dist/scripts/bootstrap-admin.js", "--username", "testadmin", "--password", "PlainPassword123!"])
    assert code != 0, f"Mong đợi exit code != 0 khi dùng cờ --password, nhận được: {code}"
    assert "SECURITY VIOLATION" in stderr, f"Mong đợi SECURITY VIOLATION trong stderr, nhận: {stderr}"
    print("✅ [TEST ADMIN PASS] Đã chặn thành công cờ --password nguy hiểm!")

    print("🧪 [TEST ADMIN] 2. Kiểm tra tự sinh mật khẩu ngẫu nhiên lưu vào tệp bí mật chmod 600...")
    code, stdout, stderr = run_in_gateway(["node", "dist/scripts/bootstrap-admin.js", "--username", "secadmin"])
    assert code == 0, f"Lỗi bootstrap admin: {stderr}\n{stdout}"
    assert "PlainPassword" not in stdout, "Mật khẩu không được phép in thô ra stdout"
    assert "bootstrap_admin.secret" in stdout, f"Mong đợi thông báo lưu tệp bí mật, nhận: {stdout}"

    # Kiểm tra phân quyền file trong container
    check_code, check_stdout, _ = run_in_gateway(["stat", "-c", "%a", "/app/keys/bootstrap_admin.secret"])
    assert check_code == 0, "Không đọc được phân quyền file bootstrap_admin.secret"
    file_perm = check_stdout.strip()
    assert file_perm == "600", f"Mong đợi phân quyền 600, nhận: {file_perm}"
    print(f"✅ [TEST ADMIN PASS] Tệp mật khẩu được sinh với phân quyền chặt chẽ: {file_perm} (chmod 600)!")

def test_telemetry_token_remediation():
    print("🧪 [TEST TELEMETRY] 1. Kiểm tra thiếu header X-Node-Token...")
    req = urllib.request.Request(
        f"{GATEWAY_URL}/api/telemetry/beacon",
        data=json.dumps({"cpu_usage": 10.5}).encode(),
        headers={"Content-Type": "application/json"}
    )
    # Gửi qua docker exec zt_gateway wget hoặc python urllib nếu gateway expose hoặc qua docker exec
    # Gateway không export port ra host, nên thực hiện request từ bên trong container gateway
    cmd = [
        "node", "-e", """
        const http = require('http');
        const req = http.request({
            hostname: '127.0.0.1',
            port: 3000,
            path: '/api/telemetry/beacon',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                console.log(JSON.stringify({ status: res.statusCode, body: JSON.parse(data) }));
            });
        });
        req.write(JSON.stringify({ cpu_usage: 12.0 }));
        req.end();
        """
    ]
    code, stdout, stderr = run_in_gateway(cmd)
    assert code == 0, f"Lỗi gửi request: {stderr}"
    res_data = json.loads(stdout.strip())
    assert res_data["status"] == 401, f"Mong đợi 401, nhận: {res_data['status']}"
    assert res_data["body"]["code"] == "MISSING_NODE_TOKEN", f"Mong đợi MISSING_NODE_TOKEN, nhận: {res_data['body']}"
    print(f"✅ [TEST TELEMETRY PASS] Thiếu token trả về 401 MISSING_NODE_TOKEN: {res_data['body']}")

    print("🧪 [TEST TELEMETRY] 2. Kiểm tra token giả mạo (INVALID_NODE_TOKEN)...")
    cmd_invalid = [
        "node", "-e", """
        const http = require('http');
        const req = http.request({
            hostname: '127.0.0.1',
            port: 3000,
            path: '/api/telemetry/beacon',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Node-Token': 'totally_invalid_fake_token_12345'
            }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                console.log(JSON.stringify({ status: res.statusCode, body: JSON.parse(data) }));
            });
        });
        req.write(JSON.stringify({ cpu_usage: 15.0 }));
        req.end();
        """
    ]
    code, stdout, stderr = run_in_gateway(cmd_invalid)
    assert code == 0, f"Lỗi gửi request: {stderr}"
    res_data = json.loads(stdout.strip())
    assert res_data["status"] == 401, f"Mong đợi 401, nhận: {res_data['status']}"
    assert res_data["body"]["code"] == "INVALID_NODE_TOKEN", f"Mong đợi INVALID_NODE_TOKEN, nhận: {res_data['body']}"
    print(f"✅ [TEST TELEMETRY PASS] Token sai trả về 401 INVALID_NODE_TOKEN: {res_data['body']}")

    print("🧪 [TEST TELEMETRY] 3. Kiểm tra token đã thu hồi (REVOKED_NODE_TOKEN)...")
    # Thiết lập node test mang token đã bị thu hồi bằng exact hash
    test_node_id = "f0000000-0000-0000-0000-000000000001"
    token_str = "revoked_token_sample_12345"
    token_hash_val = hashlib.sha256(token_str.encode()).hexdigest()
    subprocess.run([
        "docker", "exec", "zt_postgres", "psql", "-U", "zt_admin", "-d", "zt_serverops", "-c",
        f"INSERT INTO nodes (id, name, ip_address, token_prefix, token_hash, status, is_token_revoked) VALUES ('{test_node_id}', 'test-revoked-node', '10.100.0.222', '{token_str[:8]}', '{token_hash_val}', 'OFFLINE', TRUE) ON CONFLICT (id) DO UPDATE SET token_hash = '{token_hash_val}', is_token_revoked = TRUE, status = 'OFFLINE';"
    ], check=True, capture_output=True)

    try:
        cmd_revoked = [
            "node", "-e", """
            const http = require('http');
            const req = http.request({
                hostname: '127.0.0.1',
                port: 3000,
                path: '/api/telemetry/beacon',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Node-Token': 'revoked_token_sample_12345'
                }
            }, res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    console.log(JSON.stringify({ status: res.statusCode, body: JSON.parse(data) }));
                });
            });
            req.write(JSON.stringify({ cpu_usage: 18.0 }));
            req.end();
            """
        ]
        code, stdout, stderr = run_in_gateway(cmd_revoked)
        assert code == 0, f"Lỗi gửi request: {stderr}"
        res_data = json.loads(stdout.strip())
        assert res_data["status"] == 401, f"Mong đợi 401, nhận: {res_data['status']}"
        assert res_data["body"]["code"] == "REVOKED_NODE_TOKEN", f"Mong đợi REVOKED_NODE_TOKEN, nhận: {res_data['body']}"
        print(f"✅ [TEST TELEMETRY PASS] Token thu hồi trả về 401 REVOKED_NODE_TOKEN: {res_data['body']}")
    finally:
        subprocess.run([
            "docker", "exec", "zt_postgres", "psql", "-U", "zt_admin", "-d", "zt_serverops", "-c",
            f"DELETE FROM nodes WHERE id = '{test_node_id}';"
        ], check=True, capture_output=True)

if __name__ == "__main__":
    print("=== BẮT ĐẦU KIỂM THỬ XÁC MINH RUNTIME ĐỢT 3 ===")
    test_bootstrap_admin_cli_security()
    test_telemetry_token_remediation()
    print("🎉 TOÀN BỘ CÁC MỤC KIỂM THỬ RUNTIME ĐỢT 3 ĐÃ ĐẠT 100%!")
