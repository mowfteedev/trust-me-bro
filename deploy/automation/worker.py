#!/usr/bin/env python3
"""Install/check an explicitly dedicated Debian Linux Worker, with resumable enrollment."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import pwd
import grp
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request

from worker_support import (InstallError, NoRedirect, assert_no_symlinks, claim,
                            invite_fingerprint, read_private_json, ssh_public_key,
                            validate_invite, wireguard_key, write_private)

ROOT = Path(__file__).resolve().parents[2]
STATE = Path('/var/lib/zt-serverops/enrollment')
JOURNAL = STATE / 'state.json'
TUNNEL = Path('/etc/wireguard/zt-worker.conf')
SSH_CONFIG = Path('/etc/ssh/sshd_config')
HOST_KEY = Path('/etc/ssh/ssh_host_ed25519_key')
SSH_PUBLIC = Path('/etc/ssh/zt-worker/authorized_keys')
SSH_UNIT = Path('/etc/systemd/system/ssh.service.d/zt-worker.conf')
FIREWALL = Path('/etc/zt-serverops/worker-firewall.nft')
FIREWALL_UNIT = Path('/etc/systemd/system/zt-worker-firewall.service')
AGENT_ENV = Path('/opt/zt-serverops/agent/.env')
AGENT_DIR = Path('/opt/zt-serverops/agent')
AGENT_UNIT = Path('/etc/systemd/system/zt-agent.service')
NEEDED = {'wg': 'wireguard-tools', 'wg-quick': 'wireguard-tools',
          'sshd': 'openssh-server', 'ssh-keygen': 'openssh-client',
          'nft': 'nftables', 'ip': 'iproute2', 'ss': 'iproute2'}


def run(command: list[str], *, data: bytes | None = None, env: dict | None = None,
        timeout: int = 35, check: bool = True, label: str = 'Worker command') -> bytes:
    input_options = {'input': data} if data is not None else {'stdin': subprocess.DEVNULL}
    result = subprocess.run(command, env=env, capture_output=True, timeout=timeout, **input_options)
    if check and result.returncode:
        # Native diagnostics may include private config. Do not echo them.
        raise InstallError(label + ' failed; the saved identity can be reused on retry.')
    return result.stdout if result.returncode == 0 else b''


def active(service: str) -> bool:
    return run(['systemctl', 'is-active', service], check=False).strip() == b'active'


def enabled(service: str) -> bool:
    return run(['systemctl', 'is-enabled', service], check=False).strip() == b'enabled'


def check_binary(path: Path, digest: str) -> str:
    assert_no_symlinks(path)
    if not re.fullmatch(r'[a-fA-F0-9]{64}', digest) or not path.is_file():
        raise InstallError('Provide a trusted local Agent binary and its SHA256 digest.')
    content = path.read_bytes()
    if hashlib.sha256(content).hexdigest() != digest.lower():
        raise InstallError('Agent SHA256 does not match; nothing was installed.')
    expected = {'x86_64': 62, 'aarch64': 183}.get(platform.machine())
    if len(content) < 20 or content[:6] != b'\x7fELF\x02\x01' or int.from_bytes(content[18:20], 'little') != expected:
        raise InstallError('Agent binary does not match this supported 64-bit Linux architecture.')
    return digest.lower()


def state() -> dict | None:
    if not JOURNAL.exists():
        return None
    value = read_private_json(JOURNAL)
    if value.get('version') != 1 or value.get('kind') != 'zt-worker-automation':
        raise InstallError('Existing Worker state is not recognized; no changes were made.')
    return value


def save(value: dict) -> None:
    value['updated_at'] = int(time.time())
    write_private(JOURNAL, value)


def preflight(invite: dict, binary: Path, digest: str, *, install: bool = False,
              dedicated: bool = False, allow_packages: bool = True) -> dict:
    errors, notes = [], []
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'aarch64'):
        errors.append('A 64-bit Linux amd64/arm64 Worker is required.')
    os_release = Path('/etc/os-release').read_text() if Path('/etc/os-release').exists() else ''
    if not re.search(r'(?m)^(?:ID|ID_LIKE)=.*(?:debian|ubuntu)', os_release):
        errors.append('Automatic package setup supports Debian/Ubuntu only.')
    if not shutil.which('systemctl') or not Path('/run/systemd/system').is_dir():
        errors.append('A running systemd is required; container demos use their own fixture.')
    if install and os.geteuid() != 0:
        errors.append('Run install as root at the dedicated Worker console.')
    if install and not dedicated:
        errors.append('Install requires --dedicated-worker after reviewing the plan at the local console.')
    if install and os.environ.get('SSH_CONNECTION'):
        errors.append('Network changes require the local/VM console; do not run install through SSH.')
    check_binary(binary, digest)
    memory = re.search(r'(?m)^MemTotal:\s+(\d+) kB$', Path('/proc/meminfo').read_text())
    if not memory or int(memory[1]) < 120 * 1024:
        errors.append('At least 128 MB nominal RAM is required for this small Linux Worker.')
    if shutil.disk_usage('/').free < 128 * 1024 * 1024:
        errors.append('At least 128 MiB of free disk space is required.')
    missing = sorted({package for name, package in NEEDED.items() if not shutil.which(name)})
    if missing and (not allow_packages or not shutil.which('apt-get')):
        errors.append('Required WireGuard/OpenSSH/nftables tools are missing.')
    previous = state()
    if previous and previous.get('invite_fingerprint') != invite_fingerprint(invite):
        errors.append('Worker already belongs to another invitation; its identity is preserved.')
    if previous and previous.get('agent_sha256') != digest.lower():
        errors.append('Agent differs from the saved install; use the established upgrade procedure.')
    for managed in (STATE, TUNNEL, SSH_CONFIG, HOST_KEY, SSH_PUBLIC, SSH_UNIT, FIREWALL, FIREWALL_UNIT, AGENT_ENV, AGENT_DIR, AGENT_UNIT):
        assert_no_symlinks(managed)
    if not previous:
        if any(path.exists() for path in (TUNNEL, SSH_PUBLIC, SSH_UNIT, FIREWALL, FIREWALL_UNIT, AGENT_ENV, AGENT_DIR, AGENT_UNIT)):
            errors.append('Existing Worker configuration has no automation ownership state; preserve it and review manually.')
        if shutil.which('ip') and run(['ip', 'link', 'show', 'zt-worker'], check=False):
            errors.append('An existing zt-worker interface is not owned by this installer.')
        if shutil.which('nft') and os.geteuid() == 0 and run(['nft', 'list', 'table', 'inet', 'zt_worker_auto'], check=False):
            errors.append('An existing zt_worker_auto firewall table is not owned by this installer.')
    try:
        account = pwd.getpwnam(invite['ssh_username'])
        groups = {grp.getgrgid(account.pw_gid).gr_name}
        groups.update(group.gr_name for group in grp.getgrall() if invite['ssh_username'] in group.gr_mem)
        if account.pw_uid == 0 or groups & {'sudo', 'wheel', 'docker', 'root'}:
            errors.append('The existing SSH account has administrator/Docker privileges; use an ordinary dedicated account.')
    except KeyError:
        pass  # A fresh ordinary account is created only after the invitation is accepted.
    notes.append('Dedicated install restricts host SSH to the Worker VPN address and backs up its previous configuration.')
    notes.append('No router/Cloudflare/security-group changes. Independent Internet and reboot checks remain separate.')
    return {'scope': 'read_only_preflight', 'can_install': not errors, 'issues': errors,
            'packages_to_install': missing, 'node_name': invite['node_name'],
            'gateway_id': invite['gateway_id'], 'agent_sha256': digest.lower(),
            'existing_install': bool(previous), 'notes': notes}


def prepare(invite: dict, binary: Path, digest: str) -> dict:
    previous = state()
    if previous:
        staged = STATE / 'zt-agent'
        if not staged.exists() or hashlib.sha256(staged.read_bytes()).hexdigest() != digest:
            content = binary.read_bytes()
            if hashlib.sha256(content).hexdigest() != digest:
                raise InstallError('Agent changed while staging; no enrollment was sent.')
            write_private(staged, content)
            staged.chmod(0o700)
        return previous
    assert_no_symlinks(STATE)
    STATE.mkdir(parents=True, mode=0o700, exist_ok=True)
    if STATE.stat().st_uid != 0 or STATE.stat().st_mode & 0o077:
        raise InstallError('Managed Worker state must be root-owned with mode0700.')
    (STATE / 'backup').mkdir(mode=0o700, exist_ok=True)
    value = {'version': 1, 'kind': 'zt-worker-automation', 'phase': 'preparing',
             'invite_fingerprint': invite_fingerprint(invite), 'agent_sha256': digest,
             'managed': {}, 'gateway_id': invite['gateway_id'], 'node_name': invite['node_name'],
             'original_services': {name: {'active': active(name), 'enabled': enabled(name)}
                for name in ('ssh', 'wg-quick@zt-worker', 'zt-agent', 'zt-worker-firewall')}}
    save(value)
    # Copy first, then verify the private staged copy to close a mutable-source race.
    content = binary.read_bytes()
    if hashlib.sha256(content).hexdigest() != digest:
        raise InstallError('Agent changed while staging; no enrollment was sent.')
    write_private(STATE / 'zt-agent', content)
    (STATE / 'zt-agent').chmod(0o700)
    return value


def identity(invite: dict, value: dict, read_only: bool = False) -> dict:
    private = STATE / 'wireguard.private'
    token = STATE / 'node.token'
    if value.get('identity_fingerprint') and (not private.exists() or not token.exists() or not HOST_KEY.exists()):
        raise InstallError('Saved Worker identity files are missing; restore them instead of generating replacements.')
    if not private.exists():
        if read_only:
            raise InstallError('Worker identity is not prepared.')
        write_private(private, run(['wg', 'genkey']))
    if not token.exists():
        write_private(token, secrets.token_urlsafe(48) + '\n')
    public = wireguard_key(run(['wg', 'pubkey'], data=private.read_bytes()).decode().strip())
    # The system host identity is preserved. Generate only when absent.
    if not HOST_KEY.exists():
        if read_only:
            raise InstallError('Worker SSH host key is missing.')
        HOST_KEY.parent.mkdir(parents=True, exist_ok=True)
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(HOST_KEY)], label='Host key creation')
    if HOST_KEY.stat().st_uid != 0 or HOST_KEY.stat().st_mode & 0o077:
        raise InstallError('SSH host private key must be root-owned and private.')
    host_public = ssh_public_key(run(['ssh-keygen', '-y', '-f', str(HOST_KEY)]).decode().strip())
    payload = {'invitation_id': invite['invitation_id'], 'wireguard_public_key': public,
               'ssh_host_public_key': host_public, 'node_token': token.read_text().strip()}
    fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    if value.get('identity_fingerprint') and value['identity_fingerprint'] != fingerprint:
        raise InstallError('Saved Worker keys changed; refusing to consume another identity.')
    if not read_only:
        value['identity_fingerprint'] = fingerprint
        if value['phase'] in ('preparing', 'prepared', 'rolled_back'):
            value['phase'] = 'prepared'
        save(value)
    return payload


def wait_enrollment(invite: dict, payload: dict, ca_file: Path | None, seconds: int,
                    full: bool = False) -> dict:
    deadline = time.monotonic() + seconds
    while True:
        assignment = claim(invite, payload, ca_file)
        if assignment['peer_ready'] and (not full or all(assignment['verification'].values())):
            return assignment
        if time.monotonic() >= deadline:
            raise InstallError('Gateway has not confirmed the required enrollment checks; retry preserves the same identity.')
        time.sleep(3.2)


def managed_write(path: Path, content: str, value: dict, mode: int = 0o600) -> None:
    assert_no_symlinks(path)
    encoded = content.encode()
    key = str(path)
    after = hashlib.sha256(encoded).hexdigest()
    old = value['managed'].get(key)
    if old:
        current = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
        if current not in (old['before_hash'], old['after_hash']):
            raise InstallError('Managed file changed outside the installer; no overwrite was performed.')
        if old['after_hash'] != after:
            raise InstallError('Saved install plan differs from this installer; review before upgrading.')
    else:
        previous = path.read_bytes() if path.exists() else None
        backup = STATE / 'backup' / hashlib.sha256(key.encode()).hexdigest()
        if previous is not None:
            write_private(backup, previous)
        old = {'before_hash': hashlib.sha256(previous).hexdigest() if previous is not None else None,
               'after_hash': after, 'backup': str(backup),
               'before_mode': (path.stat().st_mode & 0o777) if previous is not None else None}
        value['managed'][key] = old
        save(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path == SSH_PUBLIC:
        path.parent.chmod(0o755)
    # Atomic replace also handles a public SSH key, whose directory contains no secrets.
    if path.exists() and path.stat().st_mode & 0o077:
        descriptor, temporary = __import__('tempfile').mkstemp(dir=path.parent, prefix='.zt-')
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    else:
        write_private(path, encoded)
        path.chmod(mode)


def firewall_text(gateway: str, transport: str) -> str:
    if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', transport):
        raise InstallError('Transport interface name is invalid.')
    return f'''add table inet zt_worker_auto
delete table inet zt_worker_auto
table inet zt_worker_auto {{
 chain input {{
  type filter hook input priority -10; policy drop;
  iifname "lo" accept
  ct state established,related accept
  ct state invalid drop
  iifname "zt-worker" ip saddr {gateway} tcp dport 22 accept
  iifname "{transport}" udp sport 67 udp dport 68 accept
  ip6 saddr fe80::/10 ip6 hoplimit 255 icmpv6 type {{ nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert }} accept
 }}
 chain forward {{ type filter hook forward priority -10; policy drop; }}
}}
'''


def configure(invite: dict, assignment: dict, value: dict, transport: str | None) -> None:
    gateway, address = assignment['gateway_vpn_ip'], assignment['node_ip']
    if not transport:
        endpoint = invite['wireguard_endpoint'].rsplit(':', 1)[0]
        route = json.loads(run(['ip', '-j', 'route', 'get', endpoint]))
        transport = route[0].get('dev') if route else None
    if not transport or transport in ('lo', 'zt-worker'):
        raise InstallError('Cannot determine a safe transport interface; specify --transport-interface.')
    user = invite['ssh_username']
    try:
        account = pwd.getpwnam(user)
    except KeyError:
        run(['useradd', '-m', '-s', '/bin/bash', user], label='SSH account creation')
        run(['usermod', '-p', '*', user])
        account = pwd.getpwnam(user)
    groups = {grp.getgrgid(account.pw_gid).gr_name}
    groups.update(group.gr_name for group in grp.getgrall() if user in group.gr_mem)
    if account.pw_uid == 0 or groups & {'sudo', 'wheel', 'docker', 'root'}:
        raise InstallError('The dedicated SSH account must not have administrator/Docker privileges.')
    private = (STATE / 'wireguard.private').read_text().strip()
    managed_write(TUNNEL, f'''[Interface]
PrivateKey = {private}
Address = {address}/32

[Peer]
PublicKey = {invite['wireguard_public_key']}
Endpoint = {invite['wireguard_endpoint']}
AllowedIPs = {gateway}/32
PersistentKeepalive = 25
''', value)
    managed_write(SSH_PUBLIC, ssh_public_key(invite['bastion_public_key']) + '\n', value, 0o644)
    managed_write(SSH_CONFIG, f'''Port 22
AddressFamily inet
ListenAddress {address}
HostKey {HOST_KEY}
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
AuthorizedKeysFile {SSH_PUBLIC}
AllowUsers {user}@{gateway}
DisableForwarding yes
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
PermitTTY yes
''', value)
    managed_write(SSH_UNIT, '''[Unit]
Wants=wg-quick@zt-worker.service zt-worker-firewall.service
After=wg-quick@zt-worker.service zt-worker-firewall.service
''', value)
    managed_write(FIREWALL, firewall_text(gateway, transport), value)
    managed_write(FIREWALL_UNIT, f'''[Unit]
Description=ZT dedicated Worker inbound guard
Before=ssh.service wg-quick@zt-worker.service
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f {FIREWALL}
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
''', value)
    run(['sshd', '-t'], label='SSH configuration validation')
    run(['nft', '-c', '-f', str(FIREWALL)], label='Firewall validation')
    value['phase'] = 'config_written'
    value['transport_interface'] = transport
    save(value)
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'zt-worker-firewall.service'], label='Worker firewall activation')
    run(['systemctl', 'enable', '--now', 'wg-quick@zt-worker.service'], label='WireGuard startup')
    run(['systemctl', 'restart', 'ssh.service'], label='VPN-only SSH startup')
    run(['systemctl', 'enable', 'ssh.service'])
    value['phase'] = 'network_active'
    save(value)


def install_agent(invite: dict, value: dict) -> None:
    environment = dict(os.environ)
    environment.update({'NODE_TOKEN': (STATE / 'node.token').read_text().strip(),
                        'NODE_ID': invite['node_name'], 'NETWORK_INTERFACE': 'zt-worker',
                        'DISK_MOUNT_POINT': '/', 'GATEWAY_URL': 'http://10.100.0.1:3000',
                        'ZT_AGENT_BINARY': str(STATE / 'zt-agent')})
    if AGENT_ENV.exists():
        old = dict(line.split('=', 1) for line in AGENT_ENV.read_text().splitlines() if '=' in line)
        for key in ('NODE_TOKEN', 'NODE_ID', 'NETWORK_INTERFACE', 'DISK_MOUNT_POINT', 'GATEWAY_URL'):
            if old.get(key) != environment[key]:
                raise InstallError('Existing Agent identity differs from the saved enrollment; no changes were made.')
    run(['bash', str(ROOT / 'agent/install.sh')], env=environment, timeout=90, label='Agent installation')
    value['phase'] = 'agent_active'
    save(value)


def local_checks(assignment: dict) -> dict:
    services = {name: active(name) for name in ('zt-agent', 'ssh', 'wg-quick@zt-worker', 'zt-worker-firewall')}
    handshakes = run(['wg', 'show', 'zt-worker', 'latest-handshakes'], check=False).decode().splitlines()
    fresh = any(len(line.split()) == 2 and line.split()[1].isdigit() and
                0 < time.time() - int(line.split()[1]) < 180 for line in handshakes)
    ready = False
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))
    try:
        with opener.open('http://10.100.0.1:3000/readyz', timeout=5) as response:
            data = json.loads(response.read(16384))
            ready = response.status == 200 and data.get('status') == 'READY'
    except Exception:
        pass
    listeners = run(['ss', '-H', '-lnt', 'sport', '=', ':22'], check=False).decode().splitlines()
    ssh_only_vpn = bool(listeners) and all(len(line.split()) >= 4 and
        line.split()[3] == assignment['node_ip'] + ':22' for line in listeners)
    guard = bool(run(['nft', 'list', 'table', 'inet', 'zt_worker_auto'], check=False))
    return {'services': services, 'wireguard_handshake_recent': fresh,
            'gateway_ready': ready, 'ssh_only_vpn': ssh_only_vpn, 'inbound_guard_present': guard}


def rollback(value: dict) -> bool:
    """Restore only files/services recorded by this install; never flush host rules."""
    complete = True
    for service in ('zt-agent', 'ssh', 'wg-quick@zt-worker', 'zt-worker-firewall'):
        run(['systemctl', 'stop', service], check=False)
    run(['nft', 'delete', 'table', 'inet', 'zt_worker_auto'], check=False)
    for name, info in reversed(list(value.get('managed', {}).items())):
        path = Path(name)
        try:
            assert_no_symlinks(path)
            current = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
            if current == info['before_hash']:
                continue
            if current != info['after_hash']:
                complete = False
                continue
            if info['before_hash'] is None:
                path.unlink(missing_ok=True)
            else:
                backup = Path(info['backup'])
                if backup.parent != STATE / 'backup' or hashlib.sha256(backup.read_bytes()).hexdigest() != info['before_hash']:
                    complete = False
                    continue
                path.write_bytes(backup.read_bytes())
                path.chmod(info['before_mode'])
        except OSError:
            complete = False
    run(['systemctl', 'daemon-reload'], check=False)
    for service, old in value['original_services'].items():
        run(['systemctl', 'enable' if old['enabled'] else 'disable', service], check=False)
        if old['active']:
            run(['systemctl', 'start', service], check=False)
    # Restoration commands can fail without changing files (for example sshd
    # refusing to start). Observe the final state before reporting recovery.
    for service, old in value['original_services'].items():
        try:
            observed = subprocess.run(
                ['systemctl', 'show', service, '--property=LoadState,ActiveState,UnitFileState', '--no-pager'],
                stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
            properties = dict(line.split('=', 1) for line in observed.stdout.decode().splitlines() if '=' in line)
            if properties.get('LoadState') == 'not-found':
                restored = not old['active'] and not old['enabled'] and properties.get('ActiveState') == 'inactive'
            else:
                active_restored = properties.get('ActiveState') == 'active' if old['active'] else properties.get('ActiveState') in ('inactive', 'failed')
                enabled_restored = properties.get('UnitFileState') == 'enabled' if old['enabled'] else properties.get('UnitFileState') in ('disabled', 'static', 'indirect', 'masked', 'masked-runtime', 'alias', 'generated', 'transient')
                restored = observed.returncode == 0 and properties.get('LoadState') in ('loaded', 'masked') and active_restored and enabled_restored
            complete = complete and restored
        except (OSError, UnicodeError, subprocess.TimeoutExpired):
            complete = False
    try:
        tables = run(['nft', 'list', 'tables'], label='Firewall rollback verification').decode()
        if re.search(r'(?m)^table\s+inet\s+zt_worker_auto\s*$', tables):
            complete = False
    except (InstallError, OSError, UnicodeError, subprocess.TimeoutExpired):
        complete = False
    value['phase'] = 'rolled_back' if complete else 'rollback_needs_review'
    value['rollback_complete'] = complete
    save(value)
    return complete


def install(args) -> dict:
    if os.geteuid() != 0:
        raise InstallError('Install requires root at the dedicated Worker console.')
    previous = state()
    invite = validate_invite(read_private_json(args.invite), 'linux', allow_expired=bool(previous))
    plan = preflight(invite, args.agent_binary, args.agent_sha256, install=True,
                     dedicated=args.dedicated_worker, allow_packages=not args.no_install_prerequisites)
    if not plan['can_install']:
        raise InstallError(' '.join(plan['issues']))
    if not STATE.exists():
        STATE.mkdir(parents=True, mode=0o700)
    assert_no_symlinks(STATE)
    if STATE.stat().st_uid != 0 or STATE.stat().st_mode & 0o077:
        raise InstallError('Worker state directory must be root-owned and private.')
    lock = STATE / '.lock'
    assert_no_symlinks(lock)
    with lock.open('a+b') as stream:
        os.chmod(lock, 0o600)
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise InstallError('Another Worker installation is already running.') from None
        if plan['packages_to_install']:
            run(['apt-get', 'update'], timeout=180, label='Package index refresh')
            run(['apt-get', 'install', '-y', '--no-install-recommends', *plan['packages_to_install']],
                timeout=240, env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'}, label='Worker prerequisite installation')
        value = prepare(invite, args.agent_binary, plan['agent_sha256'])
        if value['phase'] == 'rollback_needs_review':
            raise InstallError('A previous rollback needs console review before retrying.')
        payload = identity(invite, value)
        assignment = wait_enrollment(invite, payload, args.ca_file, args.wait_seconds)
        if value['phase'] == 'complete':
            local = local_checks(assignment)
            if (all(local['services'].values()) and all(local[x] for x in local if x != 'services') and
                    all(assignment['verification'].values())):
                return {'ok': True, 'already_installed': True, 'node_name': invite['node_name'],
                        'node_ip': assignment['node_ip'], 'gateway_id': invite['gateway_id'],
                        'checks': local, 'gateway_verification': assignment['verification'],
                        'still_required': ['Independent Internet firewall probe', 'Reboot verification'],
                        'state_file': str(JOURNAL)}
        value['assignment'] = assignment
        value['phase'] = 'enrolled'
        save(value)
        changed = False
        try:
            changed = True
            configure(invite, assignment, value, args.transport_interface)
            install_agent(invite, value)
            deadline = time.monotonic() + args.wait_seconds
            while True:
                local = local_checks(assignment)
                if (all(local['services'].values()) and local['wireguard_handshake_recent'] and
                        local['gateway_ready'] and local['ssh_only_vpn'] and local['inbound_guard_present']):
                    break
                if time.monotonic() >= deadline:
                    raise InstallError('Local VPN/Agent/SSH checks did not complete; managed changes will be rolled back.')
                time.sleep(3.2)
            verified = wait_enrollment(invite, payload, args.ca_file, args.wait_seconds, full=True)
            value['phase'] = 'complete'
            value['assignment'] = verified
            value['checks'] = local
            value['verification'] = verified['verification']
            save(value)
            return {'ok': True, 'node_name': invite['node_name'], 'node_ip': verified['node_ip'],
                    'gateway_id': invite['gateway_id'], 'checks': local,
                    'gateway_verification': verified['verification'],
                    'still_required': ['Independent Internet firewall probe', 'Reboot verification'],
                    'state_file': str(JOURNAL)}
        except Exception:
            if changed and value['managed']:
                rollback(value)
            raise


def status(args) -> dict:
    value = state()
    if not value or 'assignment' not in value:
        raise InstallError('No assigned automation Worker exists on this machine.')
    checks = local_checks(value['assignment'])
    verification = None
    if args.invite:
        invite = validate_invite(read_private_json(args.invite), 'linux', allow_expired=True)
        if invite_fingerprint(invite) != value['invite_fingerprint']:
            raise InstallError('Invitation differs from the installed Worker.')
        payload = identity(invite, value, read_only=True)
        verification = claim(invite, payload, args.ca_file)['verification']
    return {'ok': all(checks['services'].values()) and all(checks[x] for x in checks if x != 'services') and
                  verification is not None and all(verification.values()),
            'scope': 'local_checks_and_authenticated_gateway' if verification else 'local_checks_only',
            'phase': value['phase'], 'checks': checks, 'gateway_verification': verification,
            'state_file': str(JOURNAL)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('check', 'install', 'status'))
    parser.add_argument('--invite', type=Path, help='Private invitation JSON from the chosen Gateway.')
    parser.add_argument('--agent-binary', type=Path)
    parser.add_argument('--agent-sha256')
    parser.add_argument('--ca-file', type=Path, help='Trusted Gateway CA when using a private HTTPS certificate.')
    parser.add_argument('--dedicated-worker', action='store_true')
    parser.add_argument('--transport-interface')
    parser.add_argument('--no-install-prerequisites', action='store_true')
    parser.add_argument('--wait-seconds', type=int, default=120)
    args = parser.parse_args()
    if args.action != 'status' and (not args.invite or not args.agent_binary or not args.agent_sha256):
        parser.error('check/install require --invite, --agent-binary and --agent-sha256.')
    if not 15 <= args.wait_seconds <= 600:
        parser.error('--wait-seconds must be between15 and600.')
    if args.ca_file:
        assert_no_symlinks(args.ca_file)
    os.umask(0o077)
    try:
        if args.action == 'check':
            invite = validate_invite(read_private_json(args.invite), 'linux', allow_expired=bool(state()))
            result = preflight(invite, args.agent_binary, args.agent_sha256,
                               allow_packages=not args.no_install_prerequisites)
            code = 0 if result['can_install'] else 2
        elif args.action == 'install':
            result, code = install(args), 0
        else:
            result = status(args)
            code = 0 if result['ok'] else 2
        print(json.dumps(result, ensure_ascii=False))
        return code
    except InstallError as error:
        print(json.dumps({'ok': False, 'error': str(error), 'state_file': str(JOURNAL)}, ensure_ascii=False), file=sys.stderr)
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
        print(json.dumps({'ok': False, 'error': 'Worker operation stopped; inspect prerequisites and protected state. No secret was printed.', 'state_file': str(JOURNAL)}), file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
