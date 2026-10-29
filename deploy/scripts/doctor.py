#!/usr/bin/env python3
"""Read-only demo checks; no credentials bootstrap, login/logout or Telegram calls."""
import argparse
import ipaddress
import json
from pathlib import Path
import shutil
import stat
import subprocess
import time
from demo_http import gateway_ready

ROOT = Path(__file__).resolve().parents[2]

# Import pg alone: importing server.js would start application workers. Never
# return passwords, tokens, private keys, fingerprints or connection strings.
GATEWAY_CHECK = r"""
const fs = require('node:fs');
const net = require('node:net');
const { Client } = require('pg');
(async () => {
  const result = { database: false, key: false, nodes: [] };
  try {
    const path = process.env.BASTION_SSH_KEY_PATH || './keys/bastion_id_ed25519';
    fs.accessSync(path, fs.constants.R_OK);
    result.key = (fs.statSync(path).mode & 0o777) === 0o400;
  } catch {}
  const client = new Client({ connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000, statement_timeout: 3000 });
  try {
    await client.connect();
    const rows = await client.query(`SELECT name, host(ip_address) AS ip,
      node_type, status, EXTRACT(EPOCH FROM NOW()-last_seen)::float AS age,
      host_key_fingerprint IS NOT NULL AS pinned
      FROM nodes WHERE NOT is_token_revoked ORDER BY name LIMIT 50`);
    result.database = true;
    result.nodes = await Promise.all(rows.rows.map(async node => {
      if (net.isIP(node.ip) !== 4 || !node.ip.startsWith('10.100.0.'))
        return { ...node, ssh: false };
      const ssh = await new Promise(resolve => {
        const socket = net.createConnection({ host: node.ip, port: 22 });
        let banner = '';
        const finish = value => { socket.destroy(); resolve(value); };
        socket.setTimeout(2000, () => finish(false));
        socket.on('error', () => finish(false));
        socket.on('end', () => finish(false));
        socket.on('data', data => {
          banner += data.toString('ascii');
          if (banner.includes('\n') || banner.length > 1024)
            finish(banner.startsWith('SSH-2.0-'));
        });
      });
      return { ...node, ssh };
    }));
  } catch {} finally { await client.end().catch(() => {}); }
  console.log(JSON.stringify(result));
})().catch(() => { console.log(JSON.stringify({ database: false, key: false, nodes: [] })); });
"""


def json_rows(output):
    """Compose versions return either an array or one JSON object per line."""
    try:
        value = json.loads(output)
        return value if isinstance(value, list) else [value]
    except json.JSONDecodeError:
        return [json.loads(line) for line in output.splitlines() if line.strip()]


def diagnose(env_path, project):
    errors = []

    def check(ok, label, remedy):
        print(f"[{'OK' if ok else 'LỖI'}] {label}")
        if not ok:
            errors.append(label)
            print(f'  → {remedy}')

    print(f'Chẩn đoán chỉ đọc: {project}. Không thay dữ liệu hoặc phiên đăng nhập.')
    if not env_path.is_file():
        check(False, 'Chưa có env của cụm', 'Chọn đúng --env-file; dùng make up nếu cài lần đầu.')
        return 1
    if not shutil.which('docker'):
        check(False, 'Không tìm thấy Docker', 'Cài Docker Engine và Compose v2 trong môi trường Linux.')
        return 1
    env = dict(line.split('=', 1) for line in env_path.read_text().splitlines()
               if '=' in line and not line.lstrip().startswith('#'))
    check(stat.S_IMODE(env_path.stat().st_mode) == 0o600, 'Env chỉ chủ sở hữu được đọc/ghi (0600)',
          'Kiểm tra owner, filesystem Linux và chmod 600 cho env; doctor không tự sửa.')
    compose = ['docker', 'compose', '--env-file', str(env_path), '-p', project, '--profile', 'demo']

    def inspect(args, script=None):
        try:
            result = subprocess.run(compose + args, cwd=ROOT, input=script, text=True,
                                    capture_output=True, timeout=15)
            return result.stdout if result.returncode == 0 else None
        except (OSError, subprocess.TimeoutExpired):
            return None  # Do not echo native output that might contain secrets.

    output = inspect(['ps', '--all', '--format', 'json'])
    try:
        services = {row['Service']: row for row in json_rows(output or '')}
    except (ValueError, KeyError, TypeError):
        services = {}
    check(bool(services), 'Đọc được trạng thái Docker Compose',
          'Kiểm tra quyền Docker, daemon, --project/--env-file; doctor không tạo container.')
    for name in ('postgres', 'gateway', 'wireguard_gateway', 'dashboard', 'proxy'):
        row = services.get(name, {})
        check(row.get('State') == 'running' and row.get('Health') not in ('unhealthy', 'starting'),
              f'Dịch vụ {name} đang chạy', f'Xem make status/make logs với cùng PROJECT/ENV_FILE: {name}.')
    for name in ('migrator', 'provisioner'):
        row = services.get(name, {})
        check(row.get('State') == 'exited' and row.get('ExitCode') == 0,
              f'{name} hoàn tất thành công', 'Xem log dịch vụ này; không xóa volume để chữa lỗi.')

    ready = gateway_ready(env, timeout=4)
    check(ready, 'HTTPS /readyz qua Caddy và DB sẵn sàng (CA demo)',
          'Kiểm tra PROXY_BIND_IP/HTTPS_PORT, proxy và PostgreSQL; cần tự tin cậy CA trên browser.')

    handshakes = inspect(['exec', '-T', 'wireguard_gateway', 'wg', 'show', 'wg0', 'latest-handshakes'])
    allowed = inspect(['exec', '-T', 'wireguard_gateway', 'wg', 'show', 'wg0', 'allowed-ips'])
    try:
        handshake_by_key = {key: int(at) for key, at in (line.split() for line in (handshakes or '').splitlines())}
        peer_by_ip = {}
        for line in (allowed or '').splitlines():
            parts = line.split(None, 1)
            if len(parts) != 2:
                continue
            for address in parts[1].replace(',', ' ').split():
                if address != '(none)':
                    peer_by_ip[str(ipaddress.ip_interface(address).ip)] = parts[0]
    except ValueError:
        handshake_by_key, peer_by_ip = {}, {}
    check(bool(peer_by_ip), 'WireGuard wg0 có peer được cấu hình',
          'Kiểm tra helper và cấu hình peer; không dùng wg showconf vì có private key.')
    raw = inspect(['exec', '-T', 'gateway', 'node', '-'], GATEWAY_CHECK)
    try:
        result = json.loads(raw or '{}')
    except ValueError:
        result = {}
    check(result.get('database') is True, 'Runtime role đọc được danh sách node từ PostgreSQL',
          'Kiểm tra DB/migration/quyền runtime; không đổi mật khẩu hay chạy lại init.')
    check(result.get('key') is True, 'Gateway đọc được Bastion key với quyền 0400',
          'Kiểm tra owner UID1000, đường dẫn BASTION_SSH_KEY_PATH và bind mount.')
    nodes = result.get('nodes', [])
    check(bool(nodes), 'Có node chưa bị thu hồi trong DB', 'Chuẩn bị node demo hoặc đăng ký Worker bằng CLI hiện có.')
    stale = int(env.get('NODE_STALE_THRESHOLD_SECONDS', '15'))
    for node in nodes:
        name = ''.join(c for c in str(node['name']) if c.isprintable())[:64]
        age = node['age']
        check(isinstance(age, (int, float)) and 0 <= age < stale,
              f'{name}: heartbeat mới ({round(age, 1) if isinstance(age, (int, float)) else "chưa có"} giây)',
              'Kiểm tra Agent, tunnel và token; Offline chỉ nói rằng Gateway thiếu heartbeat.')
        at = handshake_by_key.get(peer_by_ip.get(node['ip']), 0)
        check(at > 0 and 0 <= time.time() - at <= 180,
              f'{name}: WireGuard đã handshake trong 180 giây', 'Kiểm tra endpoint, peer và đường UDP; doctor không sửa firewall.')
        check(node.get('pinned') is True and node.get('ssh') is True,
              f'{name}: có host fingerprint và SSH banner qua VPN',
              'Kiểm tra sshd, VPN và trusted host PUBLIC key; không tắt kiểm tra host key.')
    print('Phạm vi: kiểm tra trạng thái/heartbeat/TCP banner; CHƯA KIỂM CHỨNG SSH/PTY có xác thực,')
    print('Zero Inbound từ máy độc lập, Windows/reboot hoặc gửi Telegram. Dùng bài runtime riêng để nghiệm thu.')
    print(f'Kết quả: {len(errors)} vấn đề cần kiểm tra. Không thay đổi cấu hình/dữ liệu/phiên.')
    return 1 if errors else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, default=ROOT / 'keys/demo.env')
    parser.add_argument('--project', default='zt_demo')
    args = parser.parse_args()
    return diagnose(args.env_file.resolve(), args.project)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError):
        raise SystemExit('Không đọc được cấu hình/kết quả chẩn đoán; kiểm tra đường dẫn và định dạng. Không thay đổi dữ liệu.') from None
