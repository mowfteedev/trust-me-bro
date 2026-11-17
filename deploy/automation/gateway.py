#!/usr/bin/env python3
"""Install/check one Gateway; generate a private, single-use Worker invitation."""
import argparse
import base64
from datetime import datetime, timezone
import fcntl
import getpass
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import socket
import ssl
import sys
import time
import urllib.request

from gateway_support import (InstallError, atomic_write, endpoint, guarded_path, json_output,
                             private_read, public_url, read_env, run, write_new)

ROOT = Path(__file__).resolve().parents[2]
CORE = ['postgres', 'gateway', 'proxy', 'wireguard_gateway']


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise InstallError('Registration origin redirects are refused; provide its final trusted HTTPS origin.')


def image_compatible(image):
    raw = run(['docker', 'image', 'inspect', image, '--format',
               '{"os":{{json .Os}},"architecture":{{json .Architecture}}}'], ROOT)
    info = json_output(raw)
    architecture = {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    return isinstance(info, dict) and info.get('os') == 'linux' and info.get('architecture') == architecture


def ingress_available(project, subnet):
    candidate = ipaddress.ip_network(subnet, strict=True)
    if candidate.version != 4:
        return False
    identifiers = run(['docker', 'network', 'ls', '-q'], ROOT).decode().split()
    if not identifiers:
        return True
    networks = json_output(run(['docker', 'network', 'inspect', *identifiers], ROOT))
    if not isinstance(networks, list):
        return False
    for network in networks:
        if (network.get('Labels') or {}).get('com.docker.compose.project') == project:
            continue
        for config in network.get('IPAM', {}).get('Config') or []:
            if config.get('Subnet'):
                existing = ipaddress.ip_network(config['Subnet'], strict=False)
                if existing.version == candidate.version and candidate.overlaps(existing):
                    return False
    return True


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['preflight', 'install', 'check', 'invite', 'revoke'])
    p.add_argument('--project', default='zt_auto')
    p.add_argument('--env-file', type=Path, default=ROOT / 'keys/automation.env')
    p.add_argument('--endpoint', help='Reachable Gateway IPv4:UDP-port, supplied by the administrator.')
    p.add_argument('--public-url', help='Existing verified HTTPS registration origin.')
    p.add_argument('--admin-user', default='admin')
    p.add_argument('--password-stdin', action='store_true', help='Read {"password":"..."} from stdin instead of the hidden prompt.')
    p.add_argument('--build', action='store_true', help='Explicitly build images here; default requires prebuilt images.')
    p.add_argument('--skip-collector', action='store_true', help='Isolated lab only; host metrics remain NOT_RUN.')
    p.add_argument('--ca-file', type=Path, help='Trusted registration HTTPS CA; TLS verification is never disabled.')
    p.add_argument('--http-port', type=int, default=8080)
    p.add_argument('--https-port', type=int, default=8443)
    p.add_argument('--wg-port', type=int, default=51820)
    p.add_argument('--gateway-image', default='zt-serverops-gateway:automation-local')
    p.add_argument('--proxy-image', default='zt-serverops-proxy:automation-local')
    p.add_argument('--wireguard-image', default='zt-serverops-wireguard:automation-local')
    p.add_argument('--node-name')
    p.add_argument('--node-type', choices=['VM', 'BARE_METAL'], default='VM')
    p.add_argument('--worker-os', choices=['linux', 'windows'])
    p.add_argument('--ssh-user', default='ztuser')
    p.add_argument('--expires-minutes', type=int, default=15)
    p.add_argument('--output', type=Path, help='New private invitation JSON; never printed to the terminal.')
    p.add_argument('--invitation-id')
    return p


def paths(args):
    env = guarded_path(args.env_file)
    keys = guarded_path(ROOT / 'keys')
    if not env.is_relative_to(keys) or env == keys:
        raise InstallError('Gateway environment must be under this checkout keys/.')
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{1,47}', args.project):
        raise InstallError('Invalid Compose project name.')
    return env, keys, guarded_path(env.with_suffix('.state.json'))


def compose(args):
    env, _, _ = paths(args)
    return ['docker', 'compose', '-f', str(ROOT / 'docker-compose.yml'), '-f',
            str(ROOT / 'deploy/automation/compose.enrollment.yml'), '--env-file', str(env), '-p', args.project]


def call(args, rest, data=None, timeout=60):
    return run(compose(args) + rest, ROOT, data=data, timeout=timeout)


def journal(args):
    _, _, path = paths(args)
    if not path.exists():
        return None
    state = json_output(private_read(path))
    if state.get('version') != 1 or state.get('project') != args.project or state.get('root') != str(ROOT):
        raise InstallError('Installation state belongs to another project/path; no changes made.')
    return state


def save(args, phase, state):
    _, _, path = paths(args)
    state.update(phase=phase, updated_at=int(time.time()))
    atomic_write(path, json.dumps(state, indent=2) + '\n')


def bound_port(host, port, udp=False):
    if not 1 <= port <= 65535:
        return False
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM if udp else socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False


def restore_collector_mode(args, state):
    if state and 'skip_collector' in state:
        if not isinstance(state['skip_collector'], bool):
            raise InstallError('Stored collector mode is invalid; installation state preserved.')
        args.skip_collector = state['skip_collector']


def collector_path_supported():
    return re.search(r'[\s%]', str(ROOT)) is None


def preflight(args):
    env, keys, _ = paths(args)
    state = journal(args)
    restore_collector_mode(args, state)
    checks = []
    add = lambda name, ok: checks.append({'check': name, 'ok': bool(ok)})
    add('Linux x86_64/ARM64', sys.platform == 'linux' and platform.machine() in ('x86_64', 'aarch64', 'arm64'))
    add('Root installation privileges', os.geteuid() == 0)
    add('Python >=3.9', sys.version_info >= (3, 9))
    total = next((int(x.split()[1]) * 1024 for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemTotal:')), 0)
    add('Physical RAM >=512MiB (not a capacity guarantee)', total >= 512 * 1024 * 1024)
    add('Disk free >=1GiB', shutil.disk_usage(ROOT).free >= 1024 ** 3)
    for binary in ['docker', 'openssl', 'ssh-keygen']:
        add(binary + ' executable', shutil.which(binary) is not None)
    try:
        run(['docker', 'compose', 'version'], ROOT)
        run(['docker', 'info', '--format', '{{.ServerVersion}}'], ROOT)
        add('Docker daemon and Compose', True)
    except InstallError:
        add('Docker daemon and Compose', False)
    module = Path('/sys/module/wireguard').exists()
    if not module and shutil.which('modprobe'):
        try:
            run(['modprobe', '-n', 'wireguard'], ROOT)
            module = True
        except InstallError:
            pass
    add('Kernel WireGuard support', module)
    add('Enrollment Compose overlay present', (ROOT / 'deploy/automation/compose.enrollment.yml').is_file())
    if state is None and shutil.which('docker'):
        for kind, command in [('containers', ['docker', 'ps', '-aq']), ('volumes', ['docker', 'volume', 'ls', '-q']), ('networks', ['docker', 'network', 'ls', '-q'])]:
            try:
                existing = run(command + ['--filter', 'label=com.docker.compose.project=' + args.project], ROOT)
                add('No unmanaged project ' + kind, not existing.strip())
            except InstallError:
                add('Project resource inventory ' + kind, False)
    if state and not env.exists() and state.get('phase') not in ('initializing',):
        add('Managed environment retained (restore it rather than regenerate secrets)', False)
    if env.exists():
        add('Existing install is managed by this installer', state is not None)
        read_env(env)
    elif state is None:
        add('No unmanaged Gateway identity in keys/', not any((keys / name).exists() for name in ['wg0-gateway.conf', 'bastion_id_ed25519', 'wireguard_gateway_private.key']))
    values = read_env(env) if env.exists() else {}
    try:
        add('Ingress subnet does not overlap another project', ingress_available(args.project, values.get('INGRESS_SUBNET', '172.30.88.0/24')))
    except (InstallError, ValueError, KeyError, AttributeError):
        add('Ingress network inventory/configuration valid', False)
    if state is None:
        for label, host, port, udp in [('HTTPS loopback port', '127.0.0.1', args.https_port, False), ('HTTP loopback port', '127.0.0.1', args.http_port, False), ('WireGuard UDP port', '0.0.0.0', args.wg_port, True)]:
            add(label, bound_port(host, port, udp))
    if not args.skip_collector:
        add('Collector source path supports systemd', collector_path_supported())
        add('systemd running for host collector', shutil.which('systemctl') is not None and Path('/run/systemd/system').is_dir())
        add('Collector supports HTTPS8443', int(values.get('HTTPS_PORT', args.https_port)) == 8443)
    for key, image in [('ZT_GATEWAY_IMAGE', args.gateway_image), ('ZT_PROXY_IMAGE', args.proxy_image), ('ZT_WIREGUARD_IMAGE', args.wireguard_image)]:
        image = values.get(key, image)
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./:@-]{0,200}', image):
            raise InstallError('Invalid runtime image reference.')
        if not args.build:
            try:
                add('Compatible prebuilt image ' + key, image_compatible(image))
            except InstallError:
                add('Compatible prebuilt image ' + key, False)
    try:
        add('Compatible PostgreSQL image available', image_compatible('postgres:16-alpine'))
    except InstallError:
        add('PostgreSQL image available (pull postgres:16-alpine first)', False)
    result = {'ok': all(c['ok'] for c in checks), 'checks': checks, 'existing_install': state is not None,
              'host_collector': 'NOT_RUN' if args.skip_collector else 'planned', 'internet_wireguard': 'NOT_RUN'}
    return result


def generate(args, state):
    env_path, keys, _ = paths(args)
    endpoint_value = endpoint(args.endpoint or '')
    origin = public_url(args.public_url or '')
    if env_path.exists():
        values = read_env(env_path)
        if values.get('ENROLLMENT_PUBLIC_URL') != origin or values.get('ENROLLMENT_ENDPOINT') != endpoint_value:
            raise InstallError('Existing endpoint/origin differs; installer will not silently change identity.')
        return values
    private = guarded_path(keys / 'wireguard_gateway_private.key')
    public = guarded_path(keys / 'wireguard_gateway_public.key')
    if not private.exists():
        pem = run(['openssl', 'genpkey', '-algorithm', 'X25519'], ROOT)
        der = run(['openssl', 'pkey', '-outform', 'DER'], ROOT, data=pem)
        pub = run(['openssl', 'pkey', '-pubout', '-outform', 'DER'], ROOT, data=pem)
        write_new(private, base64.b64encode(der[-32:]).decode() + '\n')
        write_new(public, base64.b64encode(pub[-32:]).decode() + '\n', 0o644)
    raw_private = base64.b64decode(private_read(private).strip(), validate=True)
    if len(raw_private) != 32:
        raise InstallError('Existing Gateway private identity is malformed; preserved for inspection.')
    # Recover a missing public file after interruption without rotating the private key.
    public_der = run(['openssl', 'pkey', '-inform', 'DER', '-pubout', '-outform', 'DER'], ROOT,
                     data=bytes.fromhex('302e020100300506032b656e04220420') + raw_private)
    expected_public = base64.b64encode(public_der[-32:]).decode()
    if public.exists() and public.read_text().strip() != expected_public:
        raise InstallError('Gateway public/private identity differs; existing files preserved.')
    if not public.exists():
        write_new(public, expected_public + '\n', 0o644)
    bastion = guarded_path(keys / 'bastion_id_ed25519')
    if not bastion.exists():
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(bastion)], ROOT)
    os.chmod(bastion, 0o400)
    # Runtime UID1000 must read its own key; parent keys/ remains private to root.
    os.chown(bastion, 1000, 1000)
    bastion_pub = run(['ssh-keygen', '-y', '-f', str(bastion)], ROOT).decode().strip()
    atomic_write(Path(str(bastion) + '.pub'), bastion_pub + '\n', 0o644)
    conf = keys / 'wg0-gateway.conf'
    if not conf.exists():
        template = (ROOT / 'deploy/wireguard/wg0-gateway.conf').read_text().split('[Peer]', 1)[0]
        write_new(conf, template.replace('GATEWAY_PRIVATE_KEY_PLACEHOLDER', private_read(private).strip()))
    state_root = guarded_path(keys / 'enrollment')
    state_root.mkdir(mode=0o755, exist_ok=True)
    os.chmod(state_root, 0o755)
    for child, mode, uid in [('requests', 0o700, 1000), ('acks', 0o755, 0)]:
        directory = guarded_path(state_root / child)
        directory.mkdir(mode=mode, exist_ok=True)
        os.chown(directory, uid, uid)
        os.chmod(directory, mode)
    host_dir = guarded_path(keys / 'host-monitor') if args.skip_collector else Path('/run/zt-' + args.project + '-monitor')
    host_dir.mkdir(mode=0o755, exist_ok=True)
    admin_password = secrets.token_hex(24)
    values = {'POSTGRES_PASSWORD': admin_password,
              'MIGRATION_DATABASE_URL': 'postgresql://zt_admin:' + admin_password + '@postgres:5432/zt_serverops',
              'DATABASE_URL': 'postgresql://zt_app:' + secrets.token_hex(24) + '@postgres:5432/zt_serverops',
              'MAINTENANCE_DATABASE_URL': 'postgresql://zt_maintenance:' + secrets.token_hex(24) + '@postgres:5432/zt_serverops',
              'JWT_SECRET': secrets.token_hex(32), 'TELEGRAM_MODE': 'disabled', 'TELEGRAM_PAIR_OTP': f'{secrets.randbelow(1000000):06d}',
              'ZT_GATEWAY_IMAGE': args.gateway_image, 'ZT_PROXY_IMAGE': args.proxy_image,
              'ZT_WIREGUARD_IMAGE': args.wireguard_image, 'PROXY_BIND_IP': '127.0.0.1',
              'HTTP_PORT': str(args.http_port), 'HTTPS_PORT': str(args.https_port), 'WG_HOST_PORT': str(args.wg_port),
              'HOST_MONITOR_DIR': str(host_dir), 'ENROLLMENT_STATE_DIR': str(state_root),
              'ENROLLMENT_ENABLED': 'true', 'ENROLLMENT_GATEWAY_ID': 'sha256:' + hashlib.sha256(base64.b64decode(public.read_text().strip())).hexdigest(),
              'ENROLLMENT_PUBLIC_URL': origin, 'ENROLLMENT_ENDPOINT': endpoint_value,
              'ENROLLMENT_GATEWAY_PUBLIC_KEY': public.read_text().strip(), 'ENROLLMENT_BASTION_PUBLIC_KEY': bastion_pub}
    template = (ROOT / '.env.example').read_text()
    rendered = []
    for line in template.splitlines():
        name, separator, _ = line.partition('=')
        rendered.append(name + '=' + values[name] if separator and name in values else line)
    known = {line.split('=', 1)[0] for line in template.splitlines() if '=' in line and not line.startswith('#')}
    rendered += [name + '=' + value for name, value in values.items() if name not in known]
    write_new(env_path, '\n'.join(rendered) + '\n')
    return read_env(env_path)


def admin_command(args, action, payload):
    values = read_env(paths(args)[0])
    variables = ['ENROLLMENT_ENABLED', 'ENROLLMENT_GATEWAY_ID', 'ENROLLMENT_PUBLIC_URL', 'ENROLLMENT_ENDPOINT',
                 'ENROLLMENT_GATEWAY_PUBLIC_KEY', 'ENROLLMENT_BASTION_PUBLIC_KEY']
    # Only public metadata is placed in argv. DB credentials stay in Compose env.
    options = [part for name in variables for part in ['-e', name + '=' + values[name]]]
    raw = call(args, ['run', '--rm', '-T', '--no-deps', *options, 'migrator', 'node', 'dist/scripts/enrollment.js', action], json.dumps(payload).encode())
    return json_output(raw)


def password(args):
    if args.password_stdin:
        raw = sys.stdin.buffer.read(4097)
        if len(raw) > 4096:
            raise InstallError('Password input too large.')
        value = json_output(raw)
        if not isinstance(value, dict) or set(value) != {'password'}:
            raise InstallError('Expected stdin JSON with password only.')
        secret = value['password']
    else:
        if not sys.stdin.isatty():
            raise InstallError('Interactive hidden password prompt unavailable; use --password-stdin JSON.')
        secret = getpass.getpass('Admin password: ')
        if secret != getpass.getpass('Confirm Admin password: '):
            raise InstallError('Passwords do not match.')
    if not isinstance(secret, str) or not 12 <= len(secret) <= 256 or any(x in secret for x in '\r\n\0'):
        raise InstallError('Admin password must be12–256characters, without newlines.')
    return secret


def collector(args, values):
    if args.skip_collector:
        return
    unit_name = 'zt-' + args.project + '-host-monitor'
    unit_dir = Path('/etc/systemd/system')
    output = values['HOST_MONITOR_DIR']
    exec_path = str(ROOT / 'deploy/ec2/host-monitor.py')
    if not collector_path_supported():
        raise InstallError('Collector source path must not contain spaces/control/systemd expansion characters.')
    service = f'''[Unit]\nDescription=ZT Gateway host snapshot ({args.project})\nAfter=docker.service\n\n[Service]\nType=oneshot\nUser=root\nExecStart=/usr/bin/python3 {exec_path} --project {args.project} --output-dir {output}\nRuntimeDirectory=zt-{args.project}-monitor\nRuntimeDirectoryMode=0755\nRuntimeDirectoryPreserve=yes\nTimeoutStartSec=10\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths={output}\nPrivateTmp=yes\n'''
    timer = f'''[Unit]\nDescription=ZT host snapshot timer ({args.project})\n\n[Timer]\nOnBootSec=5s\nOnUnitActiveSec=5s\nAccuracySec=1s\nUnit={unit_name}.service\n\n[Install]\nWantedBy=timers.target\n'''
    for suffix, data in [('service', service), ('timer', timer)]:
        target = guarded_path(unit_dir / (unit_name + '.' + suffix))
        if target.exists() and target.read_text() != data:
            raise InstallError('An unrelated collector unit already uses this name; existing unit preserved.')
        if not target.exists():
            write_new(target, data, 0o644)
    run(['systemctl', 'daemon-reload'], ROOT)
    run(['systemctl', 'enable', '--now', unit_name + '.timer'], ROOT)
    run(['systemctl', 'start', unit_name + '.service'], ROOT)


def verify_collector(args, values):
    if args.skip_collector:
        return {'status': 'NOT_RUN'}
    snapshot = guarded_path(Path(values['HOST_MONITOR_DIR']) / 'host.json')
    try:
        with snapshot.open('rb') as stream:
            body = stream.read(262145)
        if len(body) > 262144:
            raise ValueError('oversized')
        data = json.loads(body)
        sampled = datetime.fromisoformat(data['sampled_at'].replace('Z', '+00:00'))
        if sampled.tzinfo is None:
            raise ValueError('timezone missing')
        age = (datetime.now(timezone.utc) - sampled).total_seconds()
        services = data['services']
        if not -2 <= age < 15 or not isinstance(services, list) or len(services) != len(CORE):
            raise ValueError('stale or incomplete')
        if {item['id'] for item in services} != set(CORE) or any(item['state'] != 'healthy' for item in services):
            raise ValueError('core service unhealthy')
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        raise InstallError('Host collector snapshot is missing, stale or reports unhealthy core services.') from None
    unit = 'zt-' + args.project + '-host-monitor'
    run(['systemctl', 'is-active', '--quiet', unit + '.timer'], ROOT)
    outcome = run(['systemctl', 'show', unit + '.service', '--property=Result', '--value'], ROOT).decode().strip()
    if outcome != 'success':
        raise InstallError('Host collector service did not complete successfully.')
    return {'status': 'verified', 'snapshot_age_seconds': round(age, 2), 'core_healthy': len(CORE)}


def verify_origin(args, origin, expected_id=None):
    context = ssl.create_default_context(cafile=str(guarded_path(args.ca_file)) if args.ca_file else None)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context), NoRedirect())
    try:
        response = opener.open(urllib.request.Request(origin + '/readyz', headers={'User-Agent': 'ZT-ServerOps-Installer/1'}), timeout=8)
        body = response.read(4097)
        if response.status != 200 or len(body) > 4096 or json.loads(body).get('status') != 'READY':
            raise InstallError('Registration HTTPS origin is not READY.')
        if expected_id:
            with opener.open(origin + '/api/enrollment/info', timeout=8) as identity:
                raw = identity.read(4097)
                if identity.status != 200 or len(raw) > 4096 or json.loads(raw).get('gateway_id') != expected_id:
                    raise InstallError('HTTPS origin belongs to another Gateway.')
    except Exception:
        raise InstallError('Registration HTTPS origin could not be verified; check DNS, certificate trust and proxy. TLS verification remains enabled.') from None


def check(args):
    restore_collector_mode(args, journal(args))
    values = read_env(paths(args)[0])
    script = """(async()=>{try{const r=await fetch('http://127.0.0.1:3000/readyz',{signal:AbortSignal.timeout(3000)});const j=await r.json();console.log(JSON.stringify({ok:r.ok&&j.status==='READY'}));}catch{console.log(JSON.stringify({ok:false}));process.exitCode=1}})()"""
    ready = json_output(call(args, ['exec', '-T', 'gateway', 'node', '-e', script]))
    if not ready.get('ok'):
        raise InstallError('Gateway local readiness failed.')
    actual_key = call(args, ['exec', '-T', 'wireguard_gateway', 'wg', 'show', 'wg0', 'public-key']).decode().strip()
    if actual_key != values['ENROLLMENT_GATEWAY_PUBLIC_KEY']:
        raise InstallError('WireGuard public identity does not match the enrollment configuration.')
    status = admin_command(args, 'status', {})
    if status['active_admins'] < 1:
        raise InstallError('No active Admin account is available.')
    verify_origin(args, values['ENROLLMENT_PUBLIC_URL'], values['ENROLLMENT_GATEWAY_ID'])
    collector_result = verify_collector(args, values)
    return {'ok': True, 'gateway_ready': True, 'https_origin_verified': True,
            'admin_accounts': status['active_admins'], 'host_collector': collector_result['status'], 'collector': collector_result,
            'worker_handshake_heartbeat_ssh': 'NOT_RUN: verified after a Worker enrolls',
            'internet_raw_firewall': 'NOT_RUN'}


def install(args):
    env_path, keys, _ = paths(args)
    if not env_path.exists() and (not args.endpoint or not args.public_url):
        raise InstallError('A fresh Gateway requires --endpoint and --public-url.')
    previous = journal(args)
    restore_collector_mode(args, previous)
    if previous:
        values = read_env(env_path) if env_path.exists() else {}
        args.endpoint = args.endpoint or values.get('ENROLLMENT_ENDPOINT') or previous.get('endpoint')
        args.public_url = args.public_url or values.get('ENROLLMENT_PUBLIC_URL') or previous.get('public_url')
    endpoint(args.endpoint or '')
    public_url(args.public_url or '')
    result = preflight(args)
    print(json.dumps(result, ensure_ascii=False))
    if not result['ok']:
        raise InstallError('Preflight failed before installation changes.')
    keys.mkdir(mode=0o700, exist_ok=True)
    os.chmod(keys, 0o700)
    lock = guarded_path(keys / '.automation.lock')
    with os.fdopen(os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600), 'w') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = journal(args) or {'version': 1, 'project': args.project, 'root': str(ROOT),
                                 'endpoint': args.endpoint, 'public_url': args.public_url}
        state.setdefault('skip_collector', args.skip_collector)
        if not state.get('phase'):
            save(args, 'initializing', state)
        values = generate(args, state)
        save(args, 'configured', state)
        if args.build:
            call(args, ['build', 'gateway', 'proxy', 'wireguard_gateway'], timeout=900)
        # Ordered one-shot jobs avoid seeding demo accounts or fixture Workers.
        call(args, ['up', '-d', 'postgres'], timeout=90)
        deadline = time.monotonic() + 40
        while True:
            try:
                call(args, ['exec', '-T', 'postgres', 'pg_isready', '-U', 'zt_admin', '-d', 'zt_serverops'])
                break
            except InstallError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.5)
        call(args, ['run', '--rm', '-T', '--no-deps', 'migrator'], timeout=90)
        call(args, ['run', '--rm', '-T', '--no-deps', 'provisioner'], timeout=90)
        save(args, 'database_ready', state)
        status = admin_command(args, 'status', {})
        if status['active_admins'] == 0:
            secret = password(args)
            output = call(args, ['run', '--rm', '-T', '--no-deps', 'migrator', 'node', 'dist/scripts/bootstrap-admin.js', '--stdin'],
                          json.dumps({'username': args.admin_user, 'password': secret}).encode())
            del secret
            if not json_output(output).get('created'):
                raise InstallError('Existing accounts were preserved; operator must resolve Admin access before continuing.')
        save(args, 'admin_ready', state)
        call(args, ['up', '-d', '--no-deps', 'gateway', 'wireguard_gateway', 'proxy'], timeout=90)
        collector(args, values)
        save(args, 'services_started', state)
        deadline = time.monotonic() + 35
        while True:
            try:
                result = check(args)
                break
            except InstallError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(1)
        save(args, 'complete', state)
        print(json.dumps(result, ensure_ascii=False))
        print('Gateway installation verified. Run invite to create one private Worker enrollment file; existing passwords are never reset.')


def invitation(args):
    if not args.node_name or not args.worker_os or not args.output:
        raise InstallError('invite requires --node-name, --worker-os and --output.')
    target = guarded_path(args.output)
    if target.exists():
        raise InstallError('Invitation output already exists; never overwrite a previously issued code.')
    if not target.parent.is_dir() or target.parent.stat().st_mode & 0o077:
        raise InstallError('Invitation output directory must exist with private0700permissions.')
    # Reserve the output first; a failed issue never loses a successfully-created code.
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        value = admin_command(args, 'issue', {'node_name': args.node_name, 'worker_os': args.worker_os,
                              'node_type': args.node_type, 'ssh_username': args.ssh_user,
                              'ttl_seconds': args.expires_minutes * 60})
        with os.fdopen(fd, 'w') as stream:
            fd = -1
            json.dump(value, stream, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    except Exception:
        if fd >= 0:
            os.close(fd)
        # A zero-byte reserved file marks an interrupted operation; never auto-reissue.
        raise
    print('Private Worker invitation saved to the requested file (0600); transfer privately. No code was printed.')


def main():
    os.umask(0o077)
    if any(arg == '--password' or arg.startswith('--password=') for arg in sys.argv[1:]):
        raise InstallError('Password command-line arguments are forbidden; use the hidden prompt or --password-stdin.')
    args = parser().parse_args()
    if args.action == 'preflight':
        result = preflight(args)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result['ok'] else 1
    if args.action == 'install':
        install(args)
    elif args.action == 'check':
        print(json.dumps(check(args), ensure_ascii=False))
    elif args.action == 'invite':
        invitation(args)
    else:
        if not args.invitation_id:
            raise InstallError('revoke requires --invitation-id.')
        print(json.dumps(admin_command(args, 'revoke', {'invitation_id': args.invitation_id})))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except InstallError as error:
        raise SystemExit(str(error)) from None
    except (OSError, ValueError, KeyError):
        # No driver output, arguments, config or secret-bearing exception values.
        raise SystemExit('Gateway operation stopped safely. Check preflight/service status and retained state; no password or enrollment code was printed.') from None
