"""Bootstrap, kiểm tra và thao tác Compose cho CLI demo."""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
KEYS = ROOT / 'keys'


def read_env(path):
    return dict(line.split('=', 1) for line in path.read_text().splitlines()
                if '=' in line and not line.lstrip().startswith('#'))


def run(args, **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, **kwargs)


def credentials(create=False):
    path = KEYS / 'demo-login.env'
    if not path.exists():
        if not create:
            raise RuntimeError('Thiếu keys/demo-login.env; khôi phục đúng tệp tài khoản. Lệnh kiểm tra không tự tạo mật khẩu mới.')
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(f'DEMO_ADMIN_PASSWORD={secrets.token_urlsafe(24)}\n')
            stream.write(f'DEMO_VIEWER_PASSWORD={secrets.token_urlsafe(24)}\n')
    return read_env(path)


def setup_demo(compose, env, start=False):
    login = credentials(create=start)
    if start:
        run(compose + ['up', '-d', '--build', 'postgres', 'migrator', 'provisioner', 'gateway', 'wireguard_gateway', 'dashboard', 'proxy'])
        # Chờ readiness thực tế; deadline rõ ràng, không giả định thời gian boot.
        deadline = time.monotonic() + 90
        url = f'https://localhost:{env.get("HTTPS_PORT", "443")}/readyz'
        while True:
            try:
                with urllib.request.urlopen(url, context=ssl._create_unverified_context(), timeout=3) as response:
                    if response.status == 200:
                        break
            except (OSError, urllib.error.URLError):
                if time.monotonic() >= deadline:
                    raise RuntimeError('Gateway chưa ready sau 90s. Dùng demo.py logs để xem lỗi.')
                threading.Event().wait(0.5)
    pub = (KEYS / 'worker_ssh_host_ed25519.pub').read_text().split()[1]
    fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(base64.b64decode(pub)).digest()).decode().rstrip('=')
    setup = {
        'admin_password': login['DEMO_ADMIN_PASSWORD'],
        'viewer_password': login['DEMO_VIEWER_PASSWORD'],
        'node_token': env.get('NODE_TOKEN_01') or (KEYS / 'node_worker_01.token').read_text().strip(),
        'host_key_fingerprint': fingerprint,
    }
    run(compose + ['exec', '-T', 'gateway', 'node', 'dist/scripts/setup-demo.js'], input=json.dumps(setup), text=True)
    if start:
        # Existing tags otherwise keep an old Agent even after source changes.
        run(compose + ['up', '-d', '--build', 'node_worker_01'])
    print(f'Dashboard: https://localhost:{env.get("HTTPS_PORT", "443")}')
    print('Tài khoản: demo-admin / demo-viewer; mật khẩu riêng trong keys/demo-login.env (0600).')
    print(f'Telegram: {env.get("TELEGRAM_MODE", "dry-run")}. Cụm riêng, không sửa .env hay DB cũ.')


def check_demo(compose, env, action, argument_error):
    if action == 'check-telegram' and (env.get('TELEGRAM_MODE') != 'live' or not env.get('TELEGRAM_BOT_TOKEN')):
        argument_error('check-telegram cần TELEGRAM_MODE=live, token và chat đã ghép nối; bài này gửi một cảnh báo thử thật.')
    login = credentials()
    test_input = {'admin_password': login['DEMO_ADMIN_PASSWORD'], 'viewer_password': login['DEMO_VIEWER_PASSWORD'],
                  'migration_url': env['MIGRATION_DATABASE_URL'], 'app_url': env['DATABASE_URL']}
    binary_path = None
    try:
        if action == 'check-cpu':
            binary = run(compose + ['exec', '-T', 'node_worker_01', 'cat', '/usr/local/bin/zt-agent'], stdout=subprocess.PIPE).stdout
            binary_path = '/tmp/zt-agent-cpu-' + secrets.token_hex(6)
            write = 'require("node:fs").writeFileSync(process.argv[1],require("node:fs").readFileSync(0),{mode:0o700})'
            run(compose + ['exec', '-T', 'gateway', 'node', '-e', write, binary_path], input=binary)
            tests = ('runtime-cpu-live.cjs',)
        elif action == 'check-telegram':
            tests = ('runtime-telegram-live.cjs',)
        else:
            tests = ('demo-runtime.cjs', 'runtime-alerts.cjs', 'runtime-schema.cjs', 'runtime-audit.cjs', 'runtime-node-registration.cjs')
        for test in tests:
            script = 'const credentials = ' + json.dumps(test_input) + ';\n'
            if binary_path:
                script += 'process.env.ZT_AGENT_TEST_BINARY = ' + json.dumps(binary_path) + ';\n'
            script += (ROOT / 'tests' / test).read_text()
            run(compose + ['exec', '-T', 'gateway', 'node', '-'], input=script, text=True)
    finally:
        if binary_path:
            run(compose + ['exec', '-T', 'gateway', 'rm', '-f', binary_path])


def dispatch(action, env_path, project, argument_error):
    if action == 'doctor':
        run([sys.executable, str(ROOT / 'deploy/scripts/doctor.py'),
             '--env-file', str(env_path), '--project', project])
        return
    compose = ['docker', 'compose', '--env-file', str(env_path), '-p', project, '--profile', 'demo']
    if action == 'up':
        run(['bash', 'deploy/scripts/init-secrets.sh', '--env-file', str(env_path)])
    elif not env_path.is_file():
        argument_error('Chưa có env demo; chạy up trước.')
    env = read_env(env_path)
    if action in ('up', 'setup'):
        setup_demo(compose, env, start=action == 'up')
    elif action in ('check', 'check-cpu', 'check-telegram'):
        check_demo(compose, env, action, argument_error)
    elif action == 'down':
        # Bảo toàn volume và mật khẩu; không dùng -v.
        run(compose + ['down'])
    elif action == 'status':
        run(compose + ['ps', '-a'])
    else:
        run(compose + ['logs', '--tail', '80', 'gateway', 'wireguard_gateway', 'node_worker_01'])
