"""Switch only the selected, existing Debian Worker; preserve a local rollback copy."""
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

BUNDLE = Path('/root/debian12-worker')
BACKUP = Path('/root/zt-before-tvbox')
WG = Path('/etc/wireguard/wg0.conf')
BIN = Path('/opt/zt-serverops/agent/zt-agent')
CONFIG = BIN.parent / 'tvbox-config.json'
DROPIN = Path('/etc/systemd/system/zt-agent.service.d/30-tvbox.conf')
SERVICES = ['wg-quick@wg0', 'ssh', 'zt-agent']


def run(args, data=None):
    result = subprocess.run([str(a) for a in args], input=data, capture_output=True, timeout=40)
    if result.returncode:
        raise RuntimeError(Path(str(args[0])).name + ' failed; secret output suppressed')
    return result.stdout


def regular(path):
    if not stat.S_ISREG(path.lstat().st_mode):
        raise RuntimeError('Expected a regular file: ' + str(path))


def copy_private(source, destination, mode=0o600, uid=0, gid=0):
    with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.zt-tvbox-', delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(source.read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), mode)
            os.fchown(stream.fileno(), uid, gid)
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)


def checks():
    if os.geteuid() != 0 or run(['hostname']).decode().strip() != 'node-linux-01':
        raise RuntimeError('Run as root only inside the selected Debian Worker')
    if BACKUP.exists() or BACKUP.is_symlink():
        raise RuntimeError('Backup already exists; inspect previous attempt instead of repeating')
    for path in (CONFIG, DROPIN):
        if path.exists() or path.is_symlink():
            raise RuntimeError('Destination exists; refusing overwrite: ' + str(path))
    for name in ('wg0.conf', 'agent-config.json', 'node.token', 'metadata.json', 'bastion_id_ed25519.pub'):
        path = BUNDLE / name
        regular(path)
        if path.stat().st_uid != 0 or stat.S_IMODE(path.stat().st_mode) != 0o600:
            raise RuntimeError('Bundle file owner/mode mismatch')
    meta = json.loads((BUNDLE / 'metadata.json').read_text())
    cfg = json.loads((BUNDLE / 'agent-config.json').read_text())
    expected = {'node_name': 'node-linux-01', 'node_ip': '10.100.0.4', 'tunnel_name': 'wg0',
                'gateway_endpoint': '100.78.198.50:51820', 'gateway_ip': '10.100.0.1', 'api_port': 3100}
    if any(meta.get(k) != v for k, v in expected.items()):
        raise RuntimeError('Bundle does not belong to this migration')
    if cfg.get('GATEWAY_URL') != 'http://10.100.0.1:3100' or cfg.get('NETWORK_INTERFACE') != 'wg0':
        raise RuntimeError('Agent settings mismatch')
    if cfg.get('NODE_TOKEN') != (BUNDLE / 'node.token').read_text().strip():
        raise RuntimeError('Agent token files disagree')
    tunnel = (BUNDLE / 'wg0.conf').read_text()
    values = dict(line.split('=', 1) for line in tunnel.splitlines() if '=' in line)
    values = {k.strip(): v.strip() for k, v in values.items()}
    if (values.get('Address') != '10.100.0.4/32' or values.get('Endpoint') != expected['gateway_endpoint']
            or values.get('PublicKey') != meta['gateway_public_key']):
        raise RuntimeError('WireGuard settings mismatch')
    derived = run(['wg', 'pubkey'], (values['PrivateKey'] + '\n').encode()).decode().strip()
    if derived != meta['wireguard_public_key']:
        raise RuntimeError('WireGuard key pair mismatch')
    run(['wg-quick', 'strip', BUNDLE / 'wg0.conf'])
    run([BIN, '--config', BUNDLE / 'agent-config.json', '--validate-config'])
    run(['ssh-keygen', '-lf', BUNDLE / 'bastion_id_ed25519.pub'])
    run(['/usr/sbin/sshd', '-t'])
    run(['systemctl', 'is-active', *SERVICES])
    user = pwd.getpwnam('ztuser')
    authorized = Path(user.pw_dir) / '.ssh/authorized_keys'
    regular(authorized)
    regular(WG)
    return authorized


def wait_gateway():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 35
    while True:
        try:
            with opener.open('http://10.100.0.1:3100/readyz', timeout=2) as response:
                if response.status == 200 and json.load(response).get('status') == 'READY':
                    return
        except (OSError, ValueError):
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError('New Gateway did not become reachable over WireGuard')
        time.sleep(1)


def activate(authorized):
    BACKUP.mkdir(mode=0o700)
    modes = {str(p): (stat.S_IMODE(p.stat().st_mode), p.stat().st_uid, p.stat().st_gid)
             for p in (WG, authorized)}
    copy_private(WG, BACKUP / 'wg0.conf')
    copy_private(authorized, BACKUP / 'authorized_keys')
    copy_private(BIN.parent / '.env', BACKUP / 'agent-old.env')
    switched = False
    try:
        agent = pwd.getpwnam('zt-agent')
        copy_private(BUNDLE / 'agent-config.json', CONFIG, 0o640, 0, agent.pw_gid)
        run(['runuser', '-u', 'zt-agent', '--', BIN, '--config', CONFIG, '--validate-config'])
        content = '[Service]\nEnvironmentFile=\nExecStart=\nExecStart=' + str(BIN) + ' --config ' + str(CONFIG) + '\n'
        DROPIN.parent.mkdir(exist_ok=True)
        with DROPIN.open('x') as stream:
            stream.write(content)
        DROPIN.chmod(0o644)
        public = (BUNDLE / 'bastion_id_ed25519.pub').read_text().strip()
        if not public.startswith('ssh-ed25519 ') or '\n' in public:
            raise RuntimeError('Invalid Bastion public key')
        with authorized.open('a') as stream:
            stream.write('\nfrom="10.100.0.1",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ' + public + '\n')
        copy_private(BUNDLE / 'wg0.conf', WG)
        run(['systemctl', 'daemon-reload'])
        switched = True
        print('Backup saved. Switching this Worker to the TV-box Gateway...', flush=True)
        run(['systemctl', 'stop', 'zt-agent', 'wg-quick@wg0'])
        run(['systemctl', 'start', 'wg-quick@wg0'])
        wait_gateway()
        run(['systemctl', 'start', 'ssh', 'zt-agent'])
        run(['systemctl', 'is-active', *SERVICES])
    except Exception:
        print('Migration stopped; restoring the previous Worker configuration.', flush=True)
        if switched:
            subprocess.run(['systemctl', 'stop', 'zt-agent', 'wg-quick@wg0'], capture_output=True, timeout=40)
        for source, target in ((BACKUP / 'wg0.conf', WG), (BACKUP / 'authorized_keys', authorized)):
            mode, uid, gid = modes[str(target)]
            copy_private(source, target, mode, uid, gid)
        DROPIN.unlink(missing_ok=True)
        CONFIG.unlink(missing_ok=True)
        run(['systemctl', 'daemon-reload'])
        if switched:
            run(['systemctl', 'start', *SERVICES])
        raise
    (BACKUP / 'result.json').write_text(json.dumps({'switched': True, 'gateway_ready': True,
        'node': 'node-linux-01', 'tvbox': '100.78.198.50', 'overlay_ip': '10.100.0.4'}) + '\n')
    print('SUCCESS: WireGuard reaches TV box; SSH and Agent services are active.', flush=True)
    print('Previous configuration is preserved in /root/zt-before-tvbox.', flush=True)


if __name__ == '__main__':
    try:
        os.umask(0o077)
        authorized = checks()
        if sys.argv[1:] == ['--check']:
            print('CHECK OK: bundle, keys, Agent compatibility, SSH and current services; no configuration changed.')
        elif not sys.argv[1:]:
            activate(authorized)
        else:
            raise RuntimeError('Expected no options or --check')
    except Exception as error:
        print('STOP: ' + str(error), file=sys.stderr)
        sys.exit(1)
