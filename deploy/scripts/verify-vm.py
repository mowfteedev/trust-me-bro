#!/usr/bin/env python3
"""Verify a registered live VM through the actual Gateway/API/SSH.

This logs demo-admin/demo-viewer out, revoking their sessions on the selected
Gateway. Run after Worker setup; it never creates a node or synthetic telemetry.
Does not prove external Internet isolation or hypervisor type.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def read_env(path):
    return dict(line.split('=', 1) for line in path.read_text().splitlines()
                if '=' in line and not line.lstrip().startswith('#'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, default=ROOT / 'keys/demo.env')
    parser.add_argument('--project', default='zt_demo')
    parser.add_argument('--node-name', default='node-windows-01')
    parser.add_argument('--shell', choices=['windows', 'linux'], default='windows')
    parser.add_argument('--ssh-user', default='ztuser', help='Expected OS account returned by the real terminal.')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9_-]{3,64}', args.node_name):
        parser.error('Invalid node name.')
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,31}', args.ssh_user):
        parser.error('Invalid SSH user.')
    if not args.env_file.is_file():
        parser.error('Gateway environment file is missing.')
    login = read_env(ROOT / 'keys/demo-login.env')
    credentials = {'admin_password': login['DEMO_ADMIN_PASSWORD'],
                   'viewer_password': login['DEMO_VIEWER_PASSWORD'],
                   'node_name': args.node_name, 'node_type': 'VM', 'shell': args.shell,
                   'ssh_user': args.ssh_user}
    # Secrets only enter child stdin, never argv, persisted fixture files or logs.
    script = 'const credentials = ' + json.dumps(credentials) + ';\n'
    script += (ROOT / 'tests/demo-runtime.cjs').read_text()
    command = ['docker', 'compose', '--env-file', str(args.env_file.resolve()),
               '-p', args.project, 'exec', '-T', 'gateway', 'node', '-']
    print('Live VM verification: real telemetry, Admin/Viewer, SSH command, audit and logout.', flush=True)
    print('This revokes demo-account sessions on the selected Gateway.', flush=True)
    subprocess.run(command, input=script, text=True, check=True, cwd=ROOT)


if __name__ == '__main__':
    try:
        main()
    except (OSError, KeyError, subprocess.CalledProcessError):
        raise SystemExit('VM verification failed; do not label this environment PASS. Check the preceding step, credentials and real Worker connection.') from None
