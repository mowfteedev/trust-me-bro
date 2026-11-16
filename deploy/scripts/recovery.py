#!/usr/bin/env python3
"""Private Compose PostgreSQL/config backup; restore only to a NEW isolated container.

No existing container/database is modified. Archives contain secrets: keep them
outside Git on a private, encrypted disk. No passwords appear in argv/output.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
FILES = ('database.dump', 'config.tar')
REQUIRED_TABLES = ('users', 'nodes', 'alerts', 'audit_logs', 'schema_migrations')


def trusted(path):
    path = path.absolute()
    if any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError('Symlink paths are not accepted.')
    return path


def private_dir(path):
    path = trusted(path)
    if path.is_relative_to(ROOT):
        raise ValueError('Private recovery material must be outside the repository.')
    path.mkdir(mode=0o700, parents=False, exist_ok=False)
    return path


def run(command, *, data=None, output=None):
    result = subprocess.run(command, input=data, stdout=output or subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=ROOT)
    if result.returncode:
        raise ValueError('Recovery command failed; native output was suppressed to protect secrets.')
    return result.stdout


def checksum(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def protect_file(path, mode='wb', file_mode=0o600):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, file_mode), mode)


def validate_bundle(directory):
    directory = trusted(directory)
    if directory.stat().st_mode & 0o077:
        raise ValueError('Backup directory must have mode 0700.')
    manifest_path = trusted(directory / 'manifest.json')
    if manifest_path.stat().st_mode & 0o077:
        raise ValueError('Manifest must have mode 0600.')
    manifest = json.loads(manifest_path.read_text())
    if not isinstance(manifest, dict) or manifest.get('format_version') != 1 or not isinstance(manifest.get('checksums'), dict) or set(manifest['checksums']) != set(FILES):
        raise ValueError('Unsupported or incomplete backup manifest.')
    for name in FILES:
        path = trusted(directory / name)
        if not path.is_file() or path.stat().st_mode & 0o077 or checksum(path) != manifest['checksums'][name]:
            raise ValueError('Backup checksum/type/permissions failed.')
    # Check all members before creating any destination. No links, devices or traversal.
    with tarfile.open(directory / 'config.tar', 'r:') as archive:
        for entry in archive.getmembers():
            parts = PurePosixPath(entry.name)
            if parts.is_absolute() or '..' in parts.parts or not entry.isfile():
                raise ValueError('Unsafe config archive member.')
    return manifest


def backup(args):
    config = trusted(args.config_dir)
    if not config.is_dir() or config.stat().st_mode & 0o077:
        raise ValueError('Config directory missing or not private (0700).')
    if not trusted(args.env_file).is_relative_to(config):
        raise ValueError('Selected environment file must be inside the backed-up config directory.')
    # Validate input tree before writing any recovery bundle.
    config_files = []
    for path in sorted(config.rglob('*')):
        trusted(path)
        if path.is_file():
            config_files.append(path)
        elif not path.is_dir():
            raise ValueError('Only regular configuration files/directories are accepted.')
    if not config_files:
        raise ValueError('Configuration directory is empty.')
    directory = private_dir(args.output)
    try:
        compose = ['docker', 'compose', '-f', str(trusted(args.compose_file)), '--env-file', str(trusted(args.env_file)), '-p', args.project]
        # pg_dump is one consistent DB snapshot; PostgreSQL credentials stay inside its container.
        with protect_file(directory / 'database.dump') as output:
            run(compose + ['exec', '-T', 'postgres', 'sh', '-ec',
                'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom'], output=output)
        with protect_file(directory / 'config.tar') as output:
            with tarfile.open(fileobj=output, mode='w:') as archive:
                for path in config_files:
                    name = path.relative_to(config).as_posix()
                    # Only private archive copies are normalized; original files stay unchanged.
                    entry = tarfile.TarInfo(name)
                    content = path.read_bytes()
                    entry.size = len(content)
                    entry.mode = 0o600 if path.stat().st_mode & 0o200 else 0o400
                    archive.addfile(entry, io.BytesIO(content))
        manifest = {'format_version': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
                    'checksums': {name: checksum(directory / name) for name in FILES},
                    'config_files': len(config_files), 'database_format': 'pg_dump-custom',
                    'source_commit': run(['git', 'rev-parse', 'HEAD']).decode().strip(),
                    'source_dirty': bool(run(['git', 'status', '--porcelain']).strip())}
        with protect_file(directory / 'manifest.json', 'w') as output:
            json.dump(manifest, output, indent=2)
        validate_bundle(directory)
    except Exception:
        shutil.rmtree(directory)
        raise
    print('Private backup created and checksums verified. Copy it to a protected disk outside this machine.')


def restore(args):
    validate_bundle(args.backup)
    if not re.fullmatch(r'zt_recovery_[a-z0-9_-]{3,45}', args.container):
        raise ValueError('Target must have prefix zt_recovery_ and be a NEW container.')
    exists = subprocess.run(['docker', 'container', 'inspect', args.container], capture_output=True)
    if exists.returncode == 0:
        raise ValueError('Target already exists; recovery will never overwrite it.')
    output = private_dir(args.output_config)
    started = False
    try:
        with tarfile.open(args.backup / 'config.tar', 'r:') as archive:
            for entry in archive.getmembers():
                destination = output / entry.name
                destination.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
                with protect_file(destination, file_mode=0o600 if entry.mode & 0o200 else 0o400) as target:
                    shutil.copyfileobj(archive.extractfile(entry), target)
        run(['docker', 'run', '-d', '--name', args.container,
             '--label', 'io.zt-serverops.recovery=true', '--network', 'none',
             '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=zt_admin',
             '-e', 'POSTGRES_DB=zt_serverops', args.image])
        started = True
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            probe = subprocess.run(['docker', 'exec', args.container, 'pg_isready', '-h', '127.0.0.1', '-U', 'zt_admin'], capture_output=True)
            if probe.returncode == 0:
                break
            time.sleep(.2)
        else:
            raise ValueError('Recovery PostgreSQL did not become ready.')
        run(['docker', 'exec', '-i', args.container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'zt_admin', '-d', 'zt_serverops'],
            data=b'CREATE ROLE zt_app NOLOGIN; CREATE ROLE zt_maintenance NOLOGIN;')
        with (args.backup / 'database.dump').open('rb') as stream:
            result = subprocess.run(['docker', 'exec', '-i', args.container, 'pg_restore', '-U', 'zt_admin',
                                     '-d', 'zt_serverops', '--exit-on-error', '--no-owner'],
                                    stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            raise ValueError('Database restore failed; original backup and running services were untouched.')
        counts = {}
        for table in REQUIRED_TABLES:
            raw = run(['docker', 'exec', args.container, 'psql', '-XAt', '-U', 'zt_admin', '-d', 'zt_serverops',
                       '-c', 'SELECT count(*) FROM public.' + table])
            counts[table] = int(raw.strip())
        report = {'evidence': 'isolated_postgresql_runtime', 'tables': counts,
                  'network': 'none', 'published_ports': [], 'config_restored': True,
                  'application_login_verified': False, 'roles': 'zt_app/zt_maintenance NOLOGIN; run normal provisioner before cutover'}
        with protect_file(output / 'RESTORE-RESULT.json', 'w') as stream:
            json.dump(report, stream, indent=2)
        print(json.dumps(report, ensure_ascii=False))
    except Exception:
        shutil.rmtree(output)
        raise
    finally:
        if started and not args.keep_container:
            run(['docker', 'rm', '-fv', args.container])
    if args.keep_container:
        print('Isolated recovered container kept. It has no network, published port or application access. Do not expose it with trust auth.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    b = sub.add_parser('backup')
    b.add_argument('--project', required=True)
    b.add_argument('--env-file', type=Path, required=True)
    b.add_argument('--compose-file', type=Path, default=ROOT / 'docker-compose.yml')
    b.add_argument('--config-dir', type=Path, required=True)
    b.add_argument('--output', type=Path, required=True)
    r = sub.add_parser('restore')
    r.add_argument('--backup', type=Path, required=True)
    r.add_argument('--output-config', type=Path, required=True)
    r.add_argument('--container', default='zt_recovery_' + uuid.uuid4().hex[:12])
    r.add_argument('--image', default='postgres:16-alpine')
    r.add_argument('--keep-container', action='store_true')
    v = sub.add_parser('verify')
    v.add_argument('--backup', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.action == 'backup':
            backup(args)
        elif args.action == 'restore':
            restore(args)
        else:
            validate_bundle(args.backup)
            print('Backup checksums, permissions and config members verified; database restore is a separate runtime check.')
    except (OSError, ValueError, KeyError, tarfile.TarError, json.JSONDecodeError):
        parser.exit(1, 'Recovery refused or failed: check paths, mode 0700/0600, checksums, Docker and NEW target. No native output or secrets printed.\n')


if __name__ == '__main__':
    main()
