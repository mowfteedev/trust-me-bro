#!/usr/bin/env python3
"""Prepare/register an additional VM peer without replacing the Docker demo node."""
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
import subprocess

ROOT = Path(__file__).resolve().parents[2]
KEYS = ROOT / 'keys'


def run(command, **kwargs):
    # Native failure output may contain configuration; keep it out of console/logs.
    result = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        raise RuntimeError('Command failed; configuration and secrets were not printed. Check service readiness.')
    return result.stdout


def key(value):
    try:
        if len(base64.b64decode(value, validate=True)) == 32:
            return value
    except (ValueError, TypeError):
        pass
    raise ValueError('Invalid WireGuard public key.')


def write_private(path, contents):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
        stream.write(contents)


def peer_check(configuration, public, address):
    """Reject overlapping peers instead of silently moving an existing peer."""
    exact = False
    for section in re.split(r'(?m)^\[Peer\]\s*$', configuration)[1:]:
        values = dict(re.findall(r'(?m)^\s*([A-Za-z]+)\s*=\s*([^#\r\n]+)', section))
        peer_key = values.get('PublicKey', '').strip()
        networks = [ipaddress.ip_network(part.strip(), strict=False)
                    for part in values.get('AllowedIPs', '').split(',') if part.strip()]
        same = peer_key == public
        if same and networks != [ipaddress.ip_network(address + '/32')]:
            raise ValueError('This public key already has different AllowedIPs; existing peer preserved.')
        if any(ipaddress.ip_address(address) in network for network in networks):
            if not same:
                raise ValueError('VPN address overlaps an existing peer; existing peer preserved.')
            exact = True
    return exact


def host_fingerprint(path):
    parts = path.read_text(encoding='utf-8').strip().split()
    if len(parts) < 2 or parts[0] != 'ssh-ed25519':
        raise ValueError('Use the trusted Windows ssh_host_ed25519_key.pub file, never a private key.')
    blob = base64.b64decode(parts[1], validate=True)
    expected = b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20'
    if len(blob) != len(expected) + 32 or not blob.startswith(expected):
        raise ValueError('Malformed Ed25519 host public key.')
    return 'SHA256:' + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip('=')


def live_peer_check(output, public, address):
    configuration = ''
    for line in output.splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[1] != '(none)':
            configuration += f'[Peer]\nPublicKey = {parts[0]}\nAllowedIPs = {parts[1]}\n'
    return peer_check(configuration, public, address)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, default=KEYS / 'demo.env')
    parser.add_argument('--project', default='zt_demo')
    commands = parser.add_subparsers(dest='action', required=True)
    prepare = commands.add_parser('prepare', help='Create secret bundle only; no DB or Gateway peer change.')
    prepare.add_argument('--node-name', default='node-windows-01')
    prepare.add_argument('--node-ip', default='10.100.0.3')
    prepare.add_argument('--gateway-endpoint', required=True, help='Reachable host IPv4:UDP-port, e.g. 192.168.1.10:51820')
    prepare.add_argument('--bundle', type=Path, default=KEYS / 'windows-worker-01')
    register = commands.add_parser('register', help='Insert VM identity and append/apply its peer; preserves existing nodes.')
    register.add_argument('--bundle', type=Path, default=KEYS / 'windows-worker-01')
    register.add_argument('--host-public-key', required=True, type=Path, help='Trusted copy from Windows console/shared folder, not ssh-keyscan over untrusted network.')
    args = parser.parse_args()
    env_file = args.env_file.resolve()
    if not env_file.is_file():
        parser.error('Gateway environment file is missing; start the existing demo first.')
    compose = ['docker', 'compose', '--env-file', str(env_file), '-p', args.project, '--profile', 'demo']
    bundle = args.bundle.resolve()
    # Generated credentials must stay under ignored keys/, never in a tracked path.
    if not bundle.is_relative_to(KEYS.resolve()) or bundle == KEYS.resolve():
        parser.error('Bundle must be a new subdirectory under ignored keys/.')
    gateway_config = KEYS / 'wg0-gateway.conf'
    if gateway_config.is_symlink():
        raise ValueError('Gateway configuration must be a regular file.')

    if args.action == 'prepare':
        if not re.fullmatch(r'[a-zA-Z0-9_-]{3,64}', args.node_name):
            parser.error('Node name must match [a-zA-Z0-9_-]{3,64}.')
        address = ipaddress.ip_address(args.node_ip)
        if address.version != 4 or address not in ipaddress.ip_network('10.100.0.0/24') or int(address.packed[-1]) in (0, 1, 2, 255):
            parser.error('Use an unused host in 10.100.0.3–10.100.0.254; .1/.2 stay unchanged.')
        host, separator, port = args.gateway_endpoint.rpartition(':')
        if not separator or ipaddress.ip_address(host).version != 4 or not port.isdigit() or not 1 <= int(port) <= 65535:
            parser.error('Gateway endpoint must be reachable IPv4:port.')
        private = run(compose + ['exec', '-T', 'wireguard_gateway', 'wg', 'genkey']).decode().strip()
        public = key(run(compose + ['exec', '-T', 'wireguard_gateway', 'wg', 'pubkey'], input=(private + '\n').encode()).decode().strip())
        gateway_public = key((KEYS / 'wireguard_gateway_public.key').read_text().strip())
        peer_check(gateway_config.read_text(), public, str(address))
        bundle.mkdir(mode=0o700, parents=False, exist_ok=False)
        metadata = {'node_name': args.node_name, 'node_ip': str(address), 'node_type': 'VM',
                    'wireguard_public_key': public, 'gateway_endpoint': args.gateway_endpoint,
                    'tunnel_name': 'zt-worker'}
        write_private(bundle / 'metadata.json', json.dumps(metadata, indent=2) + '\n')
        token = secrets.token_urlsafe(48)
        write_private(bundle / 'node.token', token + '\n')
        write_private(bundle / 'agent-config.json', json.dumps({
            'GATEWAY_URL': 'http://10.100.0.1:3000', 'NODE_ID': args.node_name,
            'NODE_TOKEN': token, 'NETWORK_INTERFACE': 'zt-worker',
            'DISK_MOUNT_POINT': 'C:\\', 'BEACON_INTERVAL_SECONDS': '3.0',
            'MAX_BACKOFF_SECONDS': '30.0', 'HTTP_TIMEOUT_SECONDS': '3.0',
            'JITTER_RATIO': '0.0',
        }, indent=2) + '\n')
        write_private(bundle / 'zt-worker.conf', f'[Interface]\nPrivateKey = {private}\nAddress = {address}/32\n\n[Peer]\nPublicKey = {gateway_public}\nEndpoint = {args.gateway_endpoint}\nAllowedIPs = 10.100.0.1/32\nPersistentKeepalive = 25\n')
        write_private(bundle / 'bastion_id_ed25519.pub', (KEYS / 'bastion_id_ed25519.pub').read_text())
        print(f'Prepared private bundle: {bundle}. No peer/DB changes. Transfer securely to the dedicated VM.')
        print('After Windows setup, copy its host PUBLIC key back and run register with --host-public-key.')
    else:
        if bundle.stat().st_mode & 0o077:
            raise ValueError('Bundle permissions must be 0700 on the Gateway.')
        metadata = json.loads((bundle / 'metadata.json').read_text())
        if not re.fullmatch(r'[a-zA-Z0-9_-]{3,64}', metadata['node_name']) or metadata['node_type'] != 'VM':
            raise ValueError('Invalid VM identity in bundle.')
        public = key(metadata['wireguard_public_key'])
        address = str(ipaddress.ip_address(metadata['node_ip']))
        if ipaddress.ip_address(address) not in ipaddress.ip_network('10.100.0.0/24') or address.rsplit('.', 1)[1] in ('0', '1', '2', '255'):
            raise ValueError('Refusing to replace Gateway or Docker demo addresses.')
        token = (bundle / 'node.token').read_text().strip()
        fingerprint = host_fingerprint(args.host_public_key)
        data = {name: metadata[name] for name in ('node_name', 'node_ip', 'node_type')}
        data.update(node_token=token, host_key_fingerprint=fingerprint)
        # Lock the existing inode: Docker bind mounts keep seeing the same file.
        with gateway_config.open('r+', encoding='utf-8') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            configuration = stream.read()
            exists = peer_check(configuration, public, address)
            live_peer_check(run(compose + ['exec', '-T', 'wireguard_gateway', 'wg', 'show', 'wg0', 'allowed-ips']).decode(), public, address)
            # The one-shot migrator already has migration credentials in its env.
            # No new grants to the long-lived Gateway application role (existing
            # migration 006 privileges remain unchanged).
            run(compose + ['run', '--rm', '-T', '--no-deps', 'migrator', 'node', 'dist/scripts/register-node.js'], input=json.dumps(data).encode())
            if not exists:
                # Keep a private original; no replacement/rotation of existing keys.
                # Gateway private configuration must NEVER enter the Worker bundle.
                backup = KEYS / ('wg0-gateway.before-' + metadata['node_name'] + '.conf')
                if not backup.exists():
                    write_private(backup, configuration)
                stream.seek(0, os.SEEK_END)
                stream.write(f'\n# Additional VM peer: {metadata["node_name"]}\n[Peer]\nPublicKey = {public}\nAllowedIPs = {address}/32\n')
                stream.flush()
                os.fsync(stream.fileno())
            # Only public key and address are argv; never a private key or token.
            run(compose + ['exec', '-T', 'wireguard_gateway', 'wg', 'set', 'wg0', 'peer', public, 'allowed-ips', address + '/32'])
        print(f'Registered {metadata["node_name"]} ({address}) with a pinned Ed25519 host key; existing nodes/users preserved.')
        print('A failed partial run is safe to retry with the same bundle and host key; identities are never overwritten.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        # Do not print exception input, JSON, keys or token material.
        raise SystemExit('Preparation/registration stopped; existing identities were preserved. Check paths, conflicts, permissions and service readiness.') from None
