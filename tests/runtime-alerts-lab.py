#!/usr/bin/env python3
"""Run alert queue/incident integration in a NEW private PostgreSQL lab, fake Telegram."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    work = args.output.absolute()
    if work.is_relative_to(ROOT) or any(p.is_symlink() for p in [work, *work.parents]):
        parser.error('Use a NEW private directory outside repo.')
    work.mkdir(mode=0o700, parents=False, exist_ok=False)
    project = 'zt_alert_fixture_' + secrets.token_hex(6)
    compose = work / 'compose.yaml'
    compose.write_text('services:\n  postgres:\n    image: postgres:16-alpine\n    ports: ["127.0.0.1::5432"]\n    environment:\n      POSTGRES_USER: zt_admin\n      POSTGRES_DB: zt_serverops\n      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}\n')
    compose.chmod(0o600)
    owner_password = secrets.token_hex(24)
    app_password = secrets.token_hex(24)
    env = work / 'fixture.env'
    env.write_text('POSTGRES_PASSWORD=' + owner_password + '\n')
    env.chmod(0o600)
    cmd = ['docker', 'compose', '-f', str(compose), '--env-file', str(env), '-p', project]
    result = {'status': 'FAIL', 'evidence': 'isolated_postgresql_runtime', 'telegram': 'FAKE FETCH ONLY', 'production_modified': False}
    def run(command, data=None):
        reply = subprocess.run(command, cwd=ROOT, input=data, capture_output=True)
        if reply.returncode:
            raise RuntimeError('Alert lab command failed; native output suppressed.')
        return reply.stdout
    try:
        run(cmd + ['up', '-d'])
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            probe = subprocess.run(cmd + ['exec', '-T', 'postgres', 'pg_isready', '-h', '127.0.0.1', '-U', 'zt_admin'], capture_output=True)
            if probe.returncode == 0:
                break
            time.sleep(.2)
        else:
            raise RuntimeError('PG readiness timeout.')
        psql = cmd + ['exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'zt_admin', '-d', 'zt_serverops']
        sql = "CREATE ROLE zt_app LOGIN PASSWORD '" + app_password + "'; CREATE ROLE zt_maintenance NOLOGIN; CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now());"
        run(psql, sql.encode())
        migrations = sorted((ROOT / 'gateway/migrations').glob('*.sql'))
        for migration in migrations:
            if not re.fullmatch(r'[A-Za-z0-9_]+\.sql', migration.name):
                raise RuntimeError('Unexpected migration filename.')
            sql = 'BEGIN;\n' + migration.read_text() + "\nINSERT INTO schema_migrations(name) VALUES ('" + migration.name + "');\nCOMMIT;"
            run(psql, sql.encode())
        port = run(cmd + ['port', 'postgres', '5432']).decode().strip().split(':')[-1]
        environment = {**os.environ, 'ZT_ALLOW_ISOLATED_DB_TEST': '1', 'TELEGRAM_MODE': 'disabled',
                       'ALERT_TEST_DATABASE_URL': f'postgresql://zt_app:{app_password}@127.0.0.1:{port}/zt_serverops',
                       'ALERT_TEST_ADMIN_DATABASE_URL': f'postgresql://zt_admin:{owner_password}@127.0.0.1:{port}/zt_serverops'}
        fd = os.open(work / 'alert-delivery.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as log:
            reply = subprocess.run(['node', 'tests/runtime-alert-delivery.cjs'], cwd=ROOT, env=environment,
                                   stdout=log, stderr=subprocess.STDOUT, timeout=120)
        if reply.returncode:
            raise RuntimeError('Alert integration failed; inspect private lab log.')
        result.update(status='PASS', migrations=len(migrations), created_at=datetime.now(timezone.utc).isoformat())
    finally:
        cleanup = subprocess.run(cmd + ['down', '-v'], capture_output=True)
        result['cleanup_verified'] = cleanup.returncode == 0
        if cleanup.returncode:
            result['status'] = 'FAIL'
        fd = os.open(work / 'result.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(result, stream, indent=2)
        # No credentials are needed once the disposable PostgreSQL has been removed.
        if cleanup.returncode == 0:
            env.unlink(missing_ok=True)
    if result['status'] != 'PASS':
        raise RuntimeError('Alert lab incomplete or cleanup failed; inspect private result.')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
