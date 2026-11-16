#!/usr/bin/env python3
"""Repeatable local checks with explicit evidence class; never runs production E2E."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def agent_command():
    if shutil.which('go'):
        return ['go', '-C', 'agent', 'test', './...']
    if shutil.which('docker'):
        # Test the CURRENT mounted source, not stale tests baked into an old image.
        image = 'golang:1.27-alpine'
        probe = subprocess.run(['docker', 'image', 'inspect', image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode == 0:
            return ['docker', 'run', '--rm', '--network', 'none', '--mount', f'type=bind,src={ROOT / "agent"},dst=/src,readonly',
                    '--tmpfs', '/tmp', '-e', 'GOCACHE=/tmp/go-cache', '-w', '/src', image, 'go', 'test', '-mod=readonly', './...']
    return None


def run_check(name, command, evidence, output, environment=None, skip_reason=None):
    if command is None:
        return {'check': name, 'evidence': evidence, 'exit_code': None, 'status': 'SKIP',
                'reason': skip_reason or 'Required tool is unavailable; this check is not verified.'}
    log = output / (name + '.log')
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        try:
            result = subprocess.run(command, cwd=ROOT, env=environment, stdout=stream, stderr=subprocess.STDOUT, timeout=600)
            code = result.returncode
        except (OSError, subprocess.TimeoutExpired):
            code = 127
    return {'check': name, 'evidence': evidence, 'exit_code': code, 'status': 'PASS' if code == 0 else 'FAIL'}


def overall_status(results):
    if any(item['status'] == 'FAIL' for item in results):
        return 'FAIL'
    return 'INCOMPLETE' if any(item['status'] == 'SKIP' for item in results) else 'PASS'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='NEW private evidence directory outside repo.')
    parser.add_argument('--docker', action='store_true', help='Use make test Docker builders for Node/Go unit checks.')
    parser.add_argument('--runtime-labs', action='store_true', help='Also run disposable real-PG accounts, recovery and fake-Telegram queue labs; requires host Node dependencies.')
    args = parser.parse_args()
    output = args.output.absolute()
    if output.is_relative_to(ROOT) or any(p.is_symlink() for p in [output, *output.parents]):
        parser.error('Evidence must use a new real directory outside the repository.')
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    checks = [('source-python', [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], 'source_and_mock'),
              ('native-python', [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'deploy/native/tests', '-p', 'test_*.py'], 'source_and_mock')]
    if args.docker:
        checks = [('make-test', ['make', 'test'], 'source_and_mock'), checks[1]]
        if args.runtime_labs:
            checks.append(('gateway-runtime-build', ['npm', '--prefix', 'gateway', 'run', 'build'], 'compile'))
    else:
        checks += [('gateway-build', ['npm', '--prefix', 'gateway', 'run', 'build'], 'compile'),
                   ('gateway-unit', ['npm', '--prefix', 'gateway', 'test'], 'mock_unit'),
                   ('dashboard-build', ['npm', '--prefix', 'dashboard', 'run', 'build'], 'compile'),
                   ('dashboard-unit', ['npm', '--prefix', 'dashboard', 'test'], 'source_and_mock'),
                   ('agent-unit', agent_command(), 'unit')]
    results = []
    for name, command, evidence in checks:
        item = run_check(name, command, evidence, output)
        results.append(item)
        print(name + ': ' + item['status'], flush=True)
    if args.runtime_labs:
        gateway_built = any(item['check'] in ('gateway-build', 'gateway-runtime-build') and item['status'] == 'PASS' for item in results)
        labs = [('accounts-runtime', ['node', 'tests/runtime-accounts.cjs']),
                ('recovery-runtime', [sys.executable, 'tests/runtime-recovery.py', '--output', str(output / 'recovery-lab')]),
                ('alerts-runtime', [sys.executable, 'tests/runtime-alerts-lab.py', '--output', str(output / 'alerts-lab')])]
        environment = {**os.environ, 'ZT_ACCOUNT_EVIDENCE_PATH': str(output / 'accounts-evidence.json')}
        for name, command in labs:
            ready = gateway_built or name == 'recovery-runtime'
            item = run_check(name, command if ready else None, 'isolated_postgresql_runtime', output,
                             environment=environment, skip_reason='Gateway build failed; do not run a stale compiled runtime.')
            results.append(item)
            print(name + ': ' + item['status'], flush=True)
    status = overall_status(results)
    report = {'created_at': datetime.now(timezone.utc).isoformat(), 'status': status, 'checks': results,
              'not_verified': ['real_vm_windows_linux', 'internet_firewall', 'reboot', 'live_telegram', 'real_web_ssh', 'resource_budget'],
              'telegram_runtime_transport': 'fake_only' if args.runtime_labs else 'not_run',
              'production_modified': False}
    fd = os.open(output / 'result.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(report, stream, indent=2)
    return {'PASS': 0, 'FAIL': 1, 'INCOMPLETE': 2}[status]


if __name__ == '__main__':
    raise SystemExit(main())
