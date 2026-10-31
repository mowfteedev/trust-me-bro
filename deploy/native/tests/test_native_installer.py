#!/usr/bin/env python3
"""Failure-path units with mocked host probes; no system installation is run."""
import argparse
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_installer', ROOT / 'scripts/install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerFailurePaths(unittest.TestCase):
    def exercise(self, *, failed_table=None, enforce='0', existing_chain=False, existing_runtime=False):
        with tempfile.TemporaryDirectory(prefix='zt-installer-preflight-unit-') as directory:
            root = Path(directory)
            # The source checkout intentionally does not contain vendor binaries or
            # built applications. Only file-presence probes use this tiny fixture;
            # SHA verification and executable/version probes are mocked below.
            kit = root / 'kit'
            files = [
                'runtime/node/bin/node', 'runtime/caddy/caddy',
                'runtime/postgres/usr/lib/postgresql/16/bin/postgres',
                'runtime/postgres/usr/lib/postgresql/16/bin/initdb',
                'runtime/postgres/usr/lib/postgresql/16/bin/pg_isready',
                'runtime/postgres/usr/share/postgresql/16/extension/pgcrypto.control',
                'app/gateway/dist/server.js', 'app/gateway/node_modules/pg/package.json',
                'app/dashboard/index.html',
            ]
            for name in files:
                path = kit / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('UNIT_FIXTURE\n')
            (kit / 'SHA256SUMS').write_text('0' * 64 + '  app/dashboard/index.html\n')
            args = argparse.Namespace(install_dir=root / 'program', config_dir=root / 'config',
                                      data_dir=root / 'data', wg_address='10.231.0.1/24',
                                      wg_port=51820, api_port=3100, db_port=55432,
                                      web_port=8443, preflight_only=False)
            original_read = Path.read_text
            original_exists = Path.exists
            original_is_dir = Path.is_dir

            def read(path, *positional, **keywords):
                if str(path) == '/etc/os-release':
                    return 'ID=debian\nVERSION_ID="12"\n'
                if str(path) == '/sys/fs/selinux/enforce':
                    return enforce + '\n'
                return original_read(path, *positional, **keywords)

            def exists(path):
                if str(path) == '/sys/fs/selinux/enforce':
                    return True
                if existing_runtime and str(path) == '/run/zt-native-wireguard':
                    return True
                return original_exists(path)

            def is_dir(path):
                if str(path) == '/run/systemd/system':
                    return True
                return original_is_dir(path)

            def run(command, **kwargs):
                if command[0] == 'sha256sum':
                    return ''
                if command[0] == 'iptables':
                    table = command[command.index('-t') + 1]
                    if table == failed_table:
                        raise installer.InstallError('Fixture firewall backend unavailable')
                    if table == 'filter' and existing_chain:
                        return '-P INPUT ACCEPT\n-N ZTNATIVE_IN\n'
                    return '-P INPUT ACCEPT\n'
                if command[:3] == ['ip', '-j', '-4']:
                    return '[]'
                if command[-1] == '--version' and command[0].endswith('/node'):
                    return 'v22.23.4\n'
                if command[-1] == '--version' and command[0].endswith('/postgres'):
                    return 'postgres (PostgreSQL) 16.15\n'
                if command[-1] == 'version' and command[0].endswith('/caddy'):
                    return 'v2.11.7\n'
                raise AssertionError('Unexpected host probe: ' + repr(command))

            def absent_probe(command, **kwargs):
                # The former chain-only probe treated this backend error as absence.
                return subprocess.CompletedProcess(command, 1, stdout='', stderr='backend unavailable')

            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(installer, 'KIT', kit))
                stack.enter_context(patch.object(installer, 'arguments', return_value=args))
                stack.enter_context(patch.object(installer.platform, 'machine', return_value='aarch64'))
                stack.enter_context(patch.object(Path, 'read_text', autospec=True, side_effect=read))
                stack.enter_context(patch.object(Path, 'exists', autospec=True, side_effect=exists))
                stack.enter_context(patch.object(Path, 'is_dir', autospec=True, side_effect=is_dir))
                stack.enter_context(patch.object(installer.shutil, 'which', side_effect=lambda name: '/usr/bin/' + name))
                stack.enter_context(patch.object(installer.pwd, 'getpwnam', side_effect=KeyError))
                stack.enter_context(patch.object(installer.grp, 'getgrnam', side_effect=KeyError))
                stack.enter_context(patch.object(installer, 'run', side_effect=run))
                stack.enter_context(patch.object(installer.subprocess, 'run', side_effect=absent_probe))
                stack.enter_context(patch.object(installer, 'check_port'))
                stack.enter_context(patch.object(installer.shutil, 'disk_usage',
                                               return_value=type('Disk', (), {'free': 10 * 1024**3})()))
                install = stack.enter_context(patch.object(installer, 'install'))
                stdout, stderr = io.StringIO(), io.StringIO()
                stack.enter_context(contextlib.redirect_stdout(stdout))
                stack.enter_context(contextlib.redirect_stderr(stderr))
                status = installer.main()
                return status, install.call_count, stderr.getvalue()

    def test_filter_backend_error_stops_before_any_installation(self):
        status, mutations, error = self.exercise(failed_table='filter')
        self.assertEqual((status, mutations), (1, 0))
        self.assertIn('backend unavailable', error)

    def test_mangle_backend_error_stops_before_any_installation(self):
        status, mutations, error = self.exercise(failed_table='mangle')
        self.assertEqual((status, mutations), (1, 0))
        self.assertIn('backend unavailable', error)

    def test_enforcing_selinux_stops_before_any_installation(self):
        status, mutations, error = self.exercise(enforce='1')
        self.assertEqual((status, mutations), (1, 0))
        self.assertIn('SELinux', error)

    def test_existing_project_firewall_is_not_overwritten(self):
        status, mutations, error = self.exercise(existing_chain=True)
        self.assertEqual((status, mutations), (1, 0))
        self.assertIn('ZTNATIVE_IN', error)

    def test_supported_host_reaches_installation_once(self):
        status, mutations, error = self.exercise()
        self.assertEqual((status, mutations, error), (0, 1, ''))

    def test_existing_runtime_directory_stops_before_installation(self):
        status, mutations, error = self.exercise(existing_runtime=True)
        self.assertEqual((status, mutations), (1, 0))
        self.assertIn('/run/zt-native-wireguard', error)


if __name__ == '__main__':
    unittest.main(verbosity=2)
