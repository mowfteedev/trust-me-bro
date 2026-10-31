#!/usr/bin/env python3
"""Own and clean only the native WireGuard service's current start attempt."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

RUNTIME = Path('/run/zt-native-wireguard')
MARKER = RUNTIME / 'owner.json'
FIREWALL = Path(__file__).resolve().with_name('firewall.sh')
INTERFACE = 'ztgw0'


def run(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise RuntimeError(f'{Path(command[0]).name} failed (exit {result.returncode}); project state retained for inspection.')
    return result.stdout


def identity(config, api_port, gateway_ip):
    invocation = os.environ.get('INVOCATION_ID', '')
    if not re.fullmatch(r'[0-9a-f]{32}', invocation):
        raise RuntimeError('Run this helper through the native systemd unit; INVOCATION_ID is required.')
    if not config.is_absolute() or config.name != INTERFACE + '.conf' or config.resolve() != config:
        raise RuntimeError('Unexpected WireGuard configuration path.')
    if not 1024 <= api_port <= 65535:
        raise RuntimeError('Invalid API port.')
    return {'invocation_id': invocation, 'config': str(config), 'interface': INTERFACE,
            'api_port': api_port, 'gateway_ip': str(ipaddress.IPv4Address(gateway_ip))}


def private_path(path, directory=False):
    info = path.lstat()
    expected = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not expected or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError('Service ownership path has unexpected owner, permissions or file type.')


def links():
    return json.loads(run(['ip', '-j', '-d', 'link', 'show']))


def prepare(expected):
    private_path(RUNTIME, directory=True)
    if MARKER.exists() or MARKER.is_symlink():
        raise RuntimeError('An ownership marker already exists; refusing to replace an earlier attempt.')
    if any(link.get('ifname') == INTERFACE for link in links()):
        raise RuntimeError('Interface ztgw0 already exists; leaving it untouched.')
    for table, names in (('filter', ('ZTNATIVE_IN', 'ZTNATIVE_FW')), ('mangle', ('ZTNATIVE_PRE',))):
        rules = run(['iptables', '-w', '5', '-t', table, '-S'])
        for name in names:
            if any(line.split()[:2] == ['-N', name] for line in rules.splitlines()):
                raise RuntimeError(f'Chain {name} already exists; leaving it untouched.')
    # ExecStopPost has the same INVOCATION_ID as ExecStartPre, including failed starts.
    # Record ownership only after proving that this attempt starts with no project state.
    fd = os.open(MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(expected, stream)
        stream.write('\n')


def cleanup(expected):
    private_path(RUNTIME, directory=True)
    if not MARKER.exists() and not MARKER.is_symlink():
        return
    private_path(MARKER)
    owned = json.loads(MARKER.read_text())
    if owned != expected:
        raise RuntimeError('Ownership marker belongs to a different start attempt; no cleanup performed.')
    current = next((link for link in links() if link.get('ifname') == INTERFACE), None)
    if current is not None:
        if current.get('linkinfo', {}).get('info_kind') != 'wireguard':
            raise RuntimeError('Interface ztgw0 is not WireGuard; no cleanup performed.')
        run(['ip', 'link', 'delete', 'dev', INTERFACE])
    # wg-quick's failed-up trap removes its interface, but does not execute PostDown.
    # The firewall helper removes only this project's jumps and chains and is idempotent.
    run([str(FIREWALL), 'down', INTERFACE, str(expected['api_port'])])
    MARKER.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'cleanup'))
    parser.add_argument('config', type=Path)
    parser.add_argument('api_port', type=int)
    parser.add_argument('gateway_ip')
    args = parser.parse_args()
    try:
        if os.geteuid() != 0:
            raise RuntimeError('The native WireGuard service must run this helper as root.')
        expected = identity(args.config, args.api_port, args.gateway_ip)
        (prepare if args.action == 'prepare' else cleanup)(expected)
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print('WireGuard lifecycle: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
