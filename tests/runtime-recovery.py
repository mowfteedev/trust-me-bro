#!/usr/bin/env python3
"""Explicit isolated PostgreSQL migration -> backup -> restore drill.

Creates its own containers with network=none and no published ports. Never
selects an existing Compose project, Worker, production DB or real credentials.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='New private directory outside repository.')
    args = parser.parse_args()
    work = args.output.absolute()
    if work.is_relative_to(ROOT) or any(p.is_symlink() for p in [work, *work.parents]):
        parser.error('Use a new real private directory outside the repo.')
    work.mkdir(mode=0o700, parents=False, exist_ok=False)
    project = 'zt_recovery_fixture_' + uuid.uuid4().hex[:10]
    compose = work / 'compose.yaml'
    compose.write_text('services:\n  postgres:\n    image: postgres:16-alpine\n    network_mode: none\n    environment:\n      POSTGRES_USER: zt_admin\n      POSTGRES_DB: zt_serverops\n      POSTGRES_HOST_AUTH_METHOD: trust\n')
    compose.chmod(0o600)
    config = work / 'config'
    config.mkdir(mode=0o700)
    env = config / 'fixture.env'
    env.write_text('')
    env.chmod(0o600)
    fixture = config / 'identity-fixture'
    fixture.write_text('fixture-only-identity-preserved\n')
    fixture.chmod(0o400)
    cmd = ['docker', 'compose', '-f', str(compose), '--env-file', str(env), '-p', project]

    def run(command, data=None):
        result = subprocess.run(command, cwd=ROOT, input=data, capture_output=True)
        if result.returncode:
            raise RuntimeError('Isolated recovery command failed; inspect the lab locally. Native output suppressed.')
        return result.stdout

    psql = cmd + ['exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'zt_admin', '-d', 'zt_serverops']
    report = {'evidence': 'isolated_postgresql_runtime', 'production_modified': False, 'status': 'FAIL'}
    try:
        run(cmd + ['up', '-d'])
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            probe = subprocess.run(cmd + ['exec', '-T', 'postgres', 'pg_isready', '-h', '127.0.0.1', '-U', 'zt_admin'], capture_output=True)
            if probe.returncode == 0:
                break
            time.sleep(.2)
        else:
            raise RuntimeError('Isolated PG readiness timeout.')
        run(psql, b'CREATE ROLE zt_app NOLOGIN; CREATE ROLE zt_maintenance NOLOGIN; CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now());')
        migrations = sorted((ROOT / 'gateway/migrations').glob('*.sql'))
        for migration in migrations:
            if not re.fullmatch(r'[A-Za-z0-9_]+\.sql', migration.name):
                raise RuntimeError('Unexpected migration filename.')
            sql = 'BEGIN;\n' + migration.read_text() + "\nINSERT INTO schema_migrations(name) VALUES ('" + migration.name + "');\nCOMMIT;"
            run(psql, sql.encode())
        run(psql, b"INSERT INTO users(username,password_hash,role) VALUES ('recovery-fixture','fixture-only-hash','ADMIN');\nINSERT INTO nodes(name,ip_address,node_type,token_hash,token_prefix) VALUES ('recovery-fixture','10.100.0.250','VM',repeat('a',64),'aaaaaaaa');\nINSERT INTO alerts(node_id,severity,message) SELECT id,'WARNING','CPU_HIGH: recovery fixture' FROM nodes WHERE name='recovery-fixture';\nINSERT INTO audit_logs(action,target) VALUES ('RECOVERY_FIXTURE','isolated-db');")
        run(['python3', 'deploy/scripts/recovery.py', 'backup', '--project', project, '--compose-file', str(compose), '--env-file', str(env), '--config-dir', str(config), '--output', str(work / 'backup')])
        run(['python3', 'deploy/scripts/recovery.py', 'restore', '--backup', str(work / 'backup'), '--output-config', str(work / 'restored')])
        restored = json.loads((work / 'restored/RESTORE-RESULT.json').read_text())
        if any(restored['tables'][table] != 1 for table in ('users', 'nodes', 'alerts', 'audit_logs')):
            raise RuntimeError('Restored fixture row count differs.')
        if restored['tables']['schema_migrations'] != len(migrations) or (work / 'restored/identity-fixture').read_text() != fixture.read_text():
            raise RuntimeError('Restored migration count/config differs.')
        if (work / 'restored/identity-fixture').stat().st_mode & 0o777 != 0o400:
            raise RuntimeError('Read-only identity permission was not preserved.')
        if (work / 'restored/identity-fixture').stat().st_mode & 0o777 != 0o400:
            raise RuntimeError('Read-only config permissions changed.')
        report.update(status='PASS', migrations=[m.name for m in migrations], tables=restored['tables'],
                      config_preserved=True, config_permissions_preserved=True, application_login_verified=False,
                      time=datetime.now(timezone.utc).isoformat())
    finally:
        cleanup = subprocess.run(cmd + ['down', '-v'], capture_output=True)
        report['cleanup_verified'] = cleanup.returncode == 0
        if cleanup.returncode:
            report['status'] = 'FAIL'
        path = work / 'result.json'
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(report, stream, indent=2)
    if report['status'] != 'PASS':
        raise RuntimeError('Recovery lab incomplete or cleanup failed; inspect private result.')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
