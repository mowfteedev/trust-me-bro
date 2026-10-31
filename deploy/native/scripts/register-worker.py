#!/usr/bin/env python3
"""Prepare and register a pinned native Worker without Docker or key rotation."""
import argparse
import base64
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import stat
import subprocess
from urllib.parse import urlsplit


def read_env(path):
    """Parse generated EnvironmentFile values without evaluating a shell."""
    result = {}
    for raw in Path(path).read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        name, separator, value = line.partition('=')
        if not separator or not re.fullmatch(r'[A-Z_][A-Z0-9_]*', name) or name in result:
            raise ValueError('Invalid or duplicate environment setting.')
        value = value.strip()
        if value.startswith(('"', "'")):
            fields = shlex.split(value, comments=False, posix=True)
            if len(fields) != 1:
                raise ValueError('Invalid quoted environment value.')
            value = fields[0]
        elif any(character.isspace() for character in value):
            raise ValueError('Unquoted whitespace in environment value.')
        if '\x00' in value or '\n' in value or '\r' in value:
            raise ValueError('Invalid environment value.')
        result[name] = value
    return result


def private_file(path, mode=0o600):
    path = Path(path)
    details = path.lstat()
    if not stat.S_ISREG(details.st_mode) or stat.S_IMODE(details.st_mode) != mode:
        raise ValueError('A protected regular file has incorrect permissions.')
    return path


def load_install(config_dir):
    config_dir = Path(config_dir).resolve(strict=True)
    path = config_dir / 'install.json'
    if path.is_symlink() or not path.is_file():
        raise ValueError('Missing regular installation record.')
    value = json.loads(path.read_text(encoding='utf-8'))
    required = ('node_path', 'gateway_dir', 'wg_config', 'wg_interface', 'wg_ip', 'api_port', 'wg_port')
    if not isinstance(value, dict) or any(name not in value for name in required):
        raise ValueError('Incomplete installation record.')
    if not re.fullmatch(r'[A-Za-z0-9_=+.-]{1,15}', value['wg_interface']):
        raise ValueError('Invalid WireGuard interface.')
    gateway_ip = ipaddress.ip_address(value['wg_ip'])
    if gateway_ip.version != 4:
        raise ValueError('Only the existing IPv4 overlay is supported.')
    for name in ('api_port', 'wg_port'):
        if isinstance(value[name], bool) or not isinstance(value[name], int) or not 1 <= value[name] <= 65535:
            raise ValueError('Invalid installation port.')
    for name in ('node_path', 'gateway_dir', 'wg_config'):
        if not Path(value[name]).is_absolute():
            raise ValueError('Installation paths must be absolute.')
    return value, config_dir


def run(command, *, input=None, cwd=None, env=None, timeout=20):
    try:
        completed = subprocess.run(command, input=input, cwd=cwd, env=env,
                                   capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError('Command unavailable or timed out; secret output was suppressed.') from None
    if completed.returncode:
        raise RuntimeError('Command failed; secret output was suppressed.')
    return completed.stdout


def wg_key(value):
    try:
        if isinstance(value, str) and len(base64.b64decode(value, validate=True)) == 32:
            return value
    except (ValueError, TypeError):
        pass
    raise ValueError('Invalid WireGuard key.')


def write_private(path, contents):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
        stream.write(contents)
        stream.flush()
        os.fsync(stream.fileno())


def fingerprint(path):
    parts = Path(path).read_text(encoding='utf-8').strip().split()
    if len(parts) < 2 or parts[0] != 'ssh-ed25519':
        raise ValueError('Provide a trusted Ed25519 host PUBLIC key.')
    try:
        blob = base64.b64decode(parts[1], validate=True)
    except ValueError:
        raise ValueError('Malformed host PUBLIC key.') from None
    prefix = b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20'
    if len(blob) != len(prefix) + 32 or not blob.startswith(prefix):
        raise ValueError('Malformed host PUBLIC key.')
    return 'SHA256:' + base64.b64encode(hashlib.sha256(blob).digest()).decode('ascii').rstrip('=')


def validate_fingerprint(value):
    if not re.fullmatch(r'SHA256:[A-Za-z0-9+/]{43}', value or ''):
        raise ValueError('Expected a trusted SHA256 Ed25519 host fingerprint.')
    if len(base64.b64decode(value[7:] + '=', validate=True)) != 32:
        raise ValueError('Invalid host fingerprint.')
    return value


def peer_check(configuration, public, address):
    exact = False
    for section in re.split(r'(?m)^\s*\[Peer\]\s*$', configuration)[1:]:
        values = dict(re.findall(r'(?m)^\s*([A-Za-z]+)\s*=\s*([^#\r\n]+)', section))
        same = values.get('PublicKey', '').strip() == public
        networks = [ipaddress.ip_network(part.strip(), strict=False)
                    for part in values.get('AllowedIPs', '').split(',') if part.strip()]
        expected = ipaddress.ip_network(address + '/32')
        if same and networks != [expected]:
            raise ValueError('Public key already belongs to different AllowedIPs.')
        if any(ipaddress.ip_address(address) in network for network in networks):
            if not same:
                raise ValueError('Worker IP overlaps an existing peer.')
            exact = True
    return exact


def live_peer_check(output, public, address):
    configuration = ''
    for line in output.splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[1] != '(none)':
            configuration += f'[Peer]\nPublicKey = {parts[0]}\nAllowedIPs = {parts[1]}\n'
    return peer_check(configuration, public, address)


def gateway_public(configuration):
    interface = re.split(r'(?m)^\s*\[Peer\]\s*$', configuration)[0]
    values = re.findall(r'(?m)^\s*PrivateKey\s*=\s*([^#\r\n]+)', interface)
    if len(values) != 1:
        raise ValueError('Gateway configuration must have one private key.')
    private = wg_key(values[0].strip())
    return wg_key(run(['wg', 'pubkey'], input=(private + '\n').encode('ascii')).decode('ascii').strip())


def worker_ip(value, install):
    address = ipaddress.ip_address(value)
    network = ipaddress.ip_network(install.get('wg_address', install['wg_ip'] + '/24'), strict=False)
    if address.version != 4 or address not in network or address in (
            network.network_address, network.broadcast_address, ipaddress.ip_address(install['wg_ip'])):
        raise ValueError('Worker requires an unused host IP in the configured overlay.')
    return str(address)


def endpoint(value):
    host, separator, port = value.rpartition(':')
    try:
        valid = separator and ipaddress.ip_address(host).version == 4 and port.isdecimal() and 1 <= int(port) <= 65535
    except ValueError:
        valid = False
    if not valid:
        raise ValueError('Gateway endpoint must be a reachable IPv4:UDP-port.')
    return f'{host}:{int(port)}'


def validate_name(name):
    if not re.fullmatch(r'[A-Za-z0-9_-]{3,64}', name or ''):
        raise ValueError('Node name must have 3–64 letters, digits, underscores or dashes.')
    return name


def prepare(args, install, config_dir):
    name = validate_name(args.node_name)
    address = worker_ip(args.node_ip, install)
    remote = endpoint(args.gateway_endpoint)
    if not re.fullmatch(r'[A-Za-z0-9_=+.-]{1,15}', args.worker_interface):
        raise ValueError('Invalid Worker interface name.')
    if not 576 <= args.mtu <= 1420:
        raise ValueError('Invalid IPv4 WireGuard MTU.')
    configuration = private_file(install['wg_config']).read_text(encoding='utf-8')
    private = wg_key(run(['wg', 'genkey']).decode('ascii').strip())
    public = wg_key(run(['wg', 'pubkey'], input=(private + '\n').encode('ascii')).decode('ascii').strip())
    gateway_key = gateway_public(configuration)
    peer_check(configuration, public, address)
    bastion = Path(install['bastion_key'])
    private_file(bastion, 0o400)
    # Derive only the public key; never copy the Gateway private key into a bundle.
    public_bastion = run(['ssh-keygen', '-y', '-f', str(bastion)]).decode('ascii').strip()
    if not public_bastion.startswith('ssh-ed25519 '):
        raise ValueError('Gateway Bastion key is not Ed25519.')
    token = secrets.token_urlsafe(48)
    bundle = args.bundle.absolute()
    bundle.mkdir(mode=0o700, parents=False, exist_ok=False)
    metadata = {'version': 1, 'node_name': name, 'node_ip': address, 'node_type': args.node_type,
                'worker_os': args.worker_os, 'wireguard_public_key': public,
                'gateway_public_key': gateway_key, 'gateway_endpoint': remote,
                'gateway_ip': install['wg_ip'], 'api_port': install['api_port'],
                'tunnel_name': args.worker_interface, 'mtu': args.mtu}
    write_private(bundle / 'metadata.json', json.dumps(metadata, indent=2) + '\n')
    write_private(bundle / 'node.token', token + '\n')
    agent = {'GATEWAY_URL': f'http://{install["wg_ip"]}:{install["api_port"]}',
             'NODE_ID': name, 'NODE_TOKEN': token, 'NETWORK_INTERFACE': args.worker_interface,
             'DISK_MOUNT_POINT': 'C:\\' if args.worker_os == 'windows' else '/',
             'BEACON_INTERVAL_SECONDS': '3.0', 'MAX_BACKOFF_SECONDS': '30.0',
             'HTTP_TIMEOUT_SECONDS': '3.0', 'JITTER_RATIO': '0.0'}
    write_private(bundle / 'agent-config.json', json.dumps(agent, indent=2) + '\n')
    write_private(bundle / (args.worker_interface + '.conf'),
                  f'[Interface]\nPrivateKey = {private}\nAddress = {address}/32\nMTU = {args.mtu}\n\n'
                  f'[Peer]\nPublicKey = {gateway_key}\nEndpoint = {remote}\n'
                  f'AllowedIPs = {install["wg_ip"]}/32\nPersistentKeepalive = 25\n')
    write_private(bundle / 'bastion_id_ed25519.pub', public_bastion + '\n')
    print(f'Prepared protected Worker bundle: {bundle}')
    print('No DB or Gateway peer changes. Transfer privately, configure the Worker, then register with a trusted host PUBLIC key.')


def registration_payload(metadata, token, trusted_fingerprint, ssh_user, install):
    name = validate_name(metadata['node_name'])
    address = worker_ip(metadata['node_ip'], install)
    if metadata.get('version') != 1 or metadata.get('node_type') not in ('VM', 'BARE_METAL', 'DOCKER'):
        raise ValueError('Invalid Worker metadata.')
    if metadata.get('gateway_ip') != install['wg_ip'] or metadata.get('api_port') != install['api_port']:
        raise ValueError('Bundle belongs to another Gateway configuration.')
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', token):
        raise ValueError('Invalid Worker token.')
    if ssh_user is not None and not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,31}', ssh_user):
        raise ValueError('Invalid local SSH username.')
    result = {'node_name': name, 'node_ip': address, 'node_type': metadata['node_type'],
              'node_token': token, 'host_key_fingerprint': validate_fingerprint(trusted_fingerprint)}
    if ssh_user is not None:
        result['ssh_username'] = ssh_user
    return result


def register(args, install, config_dir):
    bundle = args.bundle.absolute()
    if bundle.is_symlink() or not bundle.is_dir() or stat.S_IMODE(bundle.stat().st_mode) != 0o700:
        raise ValueError('Worker bundle must be a protected regular directory (0700).')
    metadata = json.loads(private_file(bundle / 'metadata.json').read_text(encoding='utf-8'))
    token = private_file(bundle / 'node.token').read_text(encoding='utf-8').strip()
    trusted = fingerprint(args.host_public_key) if args.host_public_key else validate_fingerprint(args.host_fingerprint)
    data = registration_payload(metadata, token, trusted, args.ssh_user, install)
    public = wg_key(metadata['wireguard_public_key'])
    settings = read_env(private_file(config_dir / 'gateway.env'))
    database = urlsplit(settings.get('DATABASE_URL', ''))
    if database.scheme not in ('postgres', 'postgresql') or database.username != 'zt_app' or database.hostname != '127.0.0.1':
        raise ValueError('Registration must use the local runtime DB role, never admin credentials.')
    child_env = {'PATH': os.defpath, 'NODE_ENV': 'production', 'DATABASE_URL': settings['DATABASE_URL']}
    if install.get('pg_lib_dirs'):
        child_env['LD_LIBRARY_PATH'] = ':'.join(install['pg_lib_dirs'])
    path = private_file(install['wg_config'])
    with path.open('r+', encoding='utf-8') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        configuration = stream.read()
        if wg_key(metadata['gateway_public_key']) != gateway_public(configuration):
            raise ValueError('Bundle belongs to another Gateway WireGuard identity.')
        exists = peer_check(configuration, public, data['node_ip'])
        live = run(['wg', 'show', install['wg_interface'], 'allowed-ips']).decode('ascii')
        live_peer_check(live, public, data['node_ip'])
        # One identity-checked, transaction-protected CLI call. No privilege grants.
        output = run([install['node_path'], 'dist/scripts/register-node.js'],
                     input=json.dumps(data).encode('utf-8'), cwd=install['gateway_dir'], env=child_env)
        registered = json.loads(output)
        if not isinstance(registered.get('created'), bool) or not isinstance(registered.get('node_id'), str):
            raise RuntimeError('Unexpected registration acknowledgement.')
        if not exists:
            backup = config_dir / ('wireguard.before-' + data['node_name'] + '.conf')
            if not backup.exists():
                write_private(backup, configuration)
            stream.seek(0, os.SEEK_END)
            stream.write(f'\n# Native Worker: {data["node_name"]}\n[Peer]\n'
                         f'PublicKey = {public}\nAllowedIPs = {data["node_ip"]}/32\n')
            stream.flush()
            os.fsync(stream.fileno())
        run(['wg', 'set', install['wg_interface'], 'peer', public, 'allowed-ips', data['node_ip'] + '/32'])
    print(f'Registered {data["node_name"]} ({data["node_ip"]}) with a trusted SSH host pin.')
    print('Existing identities were preserved. A partial failure is safe to retry with the same bundle and host pin.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config-dir', type=Path, default=Path('/etc/zt-serverops-native'))
    actions = parser.add_subparsers(dest='action', required=True)
    create = actions.add_parser('prepare', help='Create a new protected Worker bundle; no DB/peer mutation.')
    create.add_argument('--node-name', required=True)
    create.add_argument('--node-ip', required=True)
    create.add_argument('--gateway-endpoint', required=True, help='Reachable IPv4:UDP-port, including a tailnet IPv4.')
    create.add_argument('--bundle', type=Path, required=True, help='New private directory under an existing parent.')
    create.add_argument('--worker-os', choices=('linux', 'windows'), default='linux')
    create.add_argument('--worker-interface', default='zt-worker')
    create.add_argument('--node-type', choices=('VM', 'BARE_METAL', 'DOCKER'), default='VM')
    create.add_argument('--mtu', type=int, default=1200, help='IPv4 overlay MTU; default 1200 for the Tailscale trial.')
    enroll = actions.add_parser('register', help='Register one pinned identity and append/apply its peer.')
    enroll.add_argument('--bundle', type=Path, required=True)
    trust = enroll.add_mutually_exclusive_group(required=True)
    trust.add_argument('--host-public-key', type=Path, help='Trusted Ed25519 PUBLIC key obtained from Worker console.')
    trust.add_argument('--host-fingerprint', help='Ed25519 SHA256 fingerprint verified through a trusted channel.')
    enroll.add_argument('--ssh-user', default='ztuser')
    args = parser.parse_args()
    install, config_dir = load_install(args.config_dir)
    if args.action == 'prepare':
        prepare(args, install, config_dir)
    else:
        register(args, install, config_dir)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, RuntimeError):
        raise SystemExit('Worker operation stopped; secret output was suppressed. Check protected paths, input, conflicts and readiness. If partially applied, retry the same bundle and host pin.') from None
