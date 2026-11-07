#!/usr/bin/env python3
"""Real PostgreSQL migration/rollback/restore test in an owned, networkless container."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = '010_normalize_alert_resolution.sql'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', required=True)
    parser.add_argument('--postgres-image', default='postgres:16-alpine')
    args = parser.parse_args()
    evidence = Path(args.evidence_dir).resolve()
    evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
    evidence.chmod(0o700)
    name = 'zt-alert-normalization-' + uuid.uuid4().hex[:12]
    checks = []

    def run(command, data=None, check=True):
        result = subprocess.run(command, input=data, capture_output=True, timeout=60)
        if check and result.returncode:
            raise RuntimeError(result.stderr.decode(errors='replace'))
        return result

    def save(filename, data):
        destination = evidence / filename
        with destination.open('wb') as stream:
            os.chmod(destination, 0o600)
            stream.write(data)

    def sql(statement, database='zt_serverops', check=True, transaction=False):
        command = ['docker', 'exec', '-i', name, 'psql', '-X', '-q', '-A', '-t',
                   '-v', 'ON_ERROR_STOP=1', '-U', 'zt_admin', '-d', database]
        if transaction:
            command.append('--single-transaction')
        return run(command, statement.encode(), check=check)

    def scalar(statement, database='zt_serverops'):
        return sql(statement, database).stdout.decode().strip()

    def snapshot(database='zt_serverops', strip_resolved=True):
        # Full fixture row values are compared in memory, never printed.
        fields = []
        for table in ('users', 'nodes', 'metrics_history', 'alerts', 'audit_logs',
                      'system_settings', 'bastion_session_leases', 'schema_migrations'):
            value = "to_jsonb(t)-'resolved'" if table == 'alerts' and strip_resolved else 'to_jsonb(t)'
            predicate = f" WHERE name <> '{MIGRATION}'" if table == 'schema_migrations' else ''
            fields.append(f"'{table}',(SELECT jsonb_agg({value} ORDER BY {value}::text) FROM {table} t{predicate})")
        return json.loads(scalar('SELECT jsonb_build_object(' + ','.join(fields) + ');', database))

    def apply_010():
        body = (ROOT / 'gateway/migrations' / MIGRATION).read_text()
        return sql(body + f"\nINSERT INTO schema_migrations(name) VALUES ('{MIGRATION}');", transaction=True)

    def column_exists():
        return scalar("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' "
                      "AND table_name='alerts' AND column_name='resolved';") == '1'

    def index_definition():
        return scalar("SELECT pg_get_indexdef('public.ix_alerts_node_unresolved'::regclass);")

    def passed(description):
        checks.append(description)
        print('PASS ' + description, flush=True)

    try:
        run(['docker', 'run', '--detach', '--rm', '--name', name, '--network', 'none',
             '--tmpfs', '/var/lib/postgresql/data:rw', '-e', 'POSTGRES_USER=zt_admin',
             '-e', 'POSTGRES_DB=zt_serverops', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
             args.postgres_image])
        deadline = time.monotonic() + 30
        # initdb briefly exposes a temporary Unix socket before creating the DB.
        while run(['docker', 'exec', name, 'pg_isready', '-q', '-h', '127.0.0.1',
                   '-U', 'zt_admin', '-d', 'zt_serverops'], check=False).returncode:
            if time.monotonic() > deadline:
                raise RuntimeError('Isolated PostgreSQL did not become ready')
            time.sleep(0.1)
        sql('CREATE TABLE schema_migrations(name VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());')
        for migration in sorted((ROOT / 'gateway/migrations').glob('*.sql')):
            if migration.name >= MIGRATION:
                continue
            sql(migration.read_text() + f"\nINSERT INTO schema_migrations(name) VALUES ('{migration.name}');",
                transaction=True)
        sql("""
            INSERT INTO users(id,username,password_hash,role)
                VALUES ('11111111-1111-4111-8111-111111111111','normalization-fixture','not-a-login-hash','VIEWER');
            INSERT INTO nodes(id,name,ip_address,token_hash,token_prefix)
                VALUES ('22222222-2222-4222-8222-222222222222','normalization-fixture','10.100.0.95','normalization-fixture-hash','fixture-');
            INSERT INTO metrics_history(node_id,cpu_percent,ram_used_bytes,ram_total_bytes,disk_used_bytes,
                disk_total_bytes,network_rx_bytes,network_tx_bytes,uptime_seconds,recorded_at)
                VALUES ('22222222-2222-4222-8222-222222222222',12,40,100,25,100,123,456,789,now());
            INSERT INTO alerts(node_id,message,resolved,resolved_at) VALUES
                ('22222222-2222-4222-8222-222222222222','fixture-open',false,NULL),
                ('22222222-2222-4222-8222-222222222222','fixture-closed',true,now()),
                ('22222222-2222-4222-8222-222222222222','fixture-closed-same-time',true,now());
            INSERT INTO audit_logs(user_id,node_id,action,details) VALUES
                ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','NORMALIZATION_FIXTURE','{}');
            INSERT INTO system_settings(key,value) VALUES ('normalization-fixture','fixture-value');
            INSERT INTO bastion_session_leases(session_id,user_id,node_id,instance_id,lease_expires_at)
                VALUES ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',
                    '22222222-2222-4222-8222-222222222222','fixture-instance',now()+interval '10 seconds');
        """)
        assert column_exists()
        assert scalar('SELECT count(*) FROM schema_migrations;') == '9'
        passed('009 fixture contains open and resolved incidents plus referenced business data')

        migration_sql = (ROOT / 'gateway/migrations' / MIGRATION).read_text()
        for label, message, wrong, correct in (
            ('true-without-timestamp', 'fixture-open', 'true', 'false'),
            ('false-with-timestamp', 'fixture-closed', 'false', 'true'),
        ):
            sql(f"UPDATE alerts SET resolved={wrong} WHERE message='{message}';")
            before_bad = snapshot(strip_resolved=False)
            rejected = sql(migration_sql, check=False, transaction=True)
            save(label + '.stderr.txt', rejected.stderr)
            assert rejected.returncode != 0 and b'Alert resolution is inconsistent' in rejected.stderr
            assert snapshot(strip_resolved=False) == before_bad
            assert column_exists() and 'resolved = false' in index_definition()
            assert scalar('SELECT count(*) FROM schema_migrations;') == '9'
            sql(f"UPDATE alerts SET resolved={correct} WHERE message='{message}';")
            passed('010 rejects ' + label + ' and transaction preserves rows/column/index/history')

        before = snapshot()
        before_full = snapshot(strip_resolved=False)
        foreign_keys = scalar("SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint "
                              "WHERE contype='f' AND connamespace='public'::regnamespace;")
        backup = run(['docker', 'exec', name, 'pg_dump', '-U', 'zt_admin', '-d', 'zt_serverops', '-Fc']).stdout
        save('fixture-before-010.dump', backup)
        apply_010()
        assert not column_exists()
        assert 'resolved_at IS NULL' in index_definition()
        assert snapshot() == before
        assert scalar("SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint "
                      "WHERE contype='f' AND connamespace='public'::regnamespace;") == foreign_keys
        assert scalar('SELECT count(*) FROM schema_migrations;') == '10'
        sql(migration_sql, transaction=True)
        assert snapshot() == before
        passed('010 removes only derived flag, preserves all rows/FKs/timestamps, builds NULL partial index and reruns safely')

        # A rollback must also preserve incidents written by the new application.
        sql("""INSERT INTO alerts(node_id,message) VALUES
            ('22222222-2222-4222-8222-222222222222','fixture-created-after-010');
            UPDATE alerts SET resolved_at=now() WHERE message='fixture-open';""")
        after_writes = snapshot()
        rollback = (ROOT / 'deploy/db/rollback-010-normalize-alert-resolution.sql').read_text()
        sql(rollback)
        assert column_exists() and 'resolved = false' in index_definition()
        assert scalar('SELECT count(*) FROM alerts WHERE resolved IS DISTINCT FROM (resolved_at IS NOT NULL);') == '0'
        assert scalar('SELECT count(*) FROM schema_migrations;') == '9'
        assert snapshot() == after_writes
        sql(rollback)
        assert snapshot() == after_writes
        passed('rollback reconstructs old flag/default/index/history without losing post-010 incidents; rerun is safe')
        apply_010()
        assert not column_exists() and snapshot() == after_writes
        passed('roll forward after rollback preserves all business rows')

        sql('CREATE DATABASE zt_restored009;')
        run(['docker', 'exec', '-i', name, 'pg_restore', '-U', 'zt_admin', '-d', 'zt_restored009',
             '--exit-on-error', '--single-transaction'], backup)
        assert snapshot('zt_restored009', strip_resolved=False) == before_full
        assert scalar("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' "
                      "AND table_name='alerts' AND column_name='resolved';", 'zt_restored009') == '1'
        assert 'resolved = false' in scalar("SELECT pg_get_indexdef('public.ix_alerts_node_unresolved'::regclass);",
                                             'zt_restored009')
        passed('real pg_dump custom backup restores schema/index/flags and all eight table snapshots in separate database')
        result = {'passed': len(checks), 'checks': checks, 'postgres_version': scalar('SHOW server_version;'),
                  'network': 'none', 'host_ports': [], 'fixture_only': True,
                  'backup_sha256': hashlib.sha256(backup).hexdigest(), 'production_changes': False}
        save('result.json', (json.dumps(result, indent=2) + '\n').encode())
    finally:
        run(['docker', 'rm', '-f', name], check=False)


if __name__ == '__main__':
    main()
