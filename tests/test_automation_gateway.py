"""Installer guards and state preservation; mocks do not certify host installation."""
import argparse
import contextlib
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/automation'))
import gateway as gateway_install
from gateway_support import InstallError, atomic_write, endpoint, private_read, public_url, read_env, run


class GatewayAutomationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root_patch = patch.object(gateway_install, 'ROOT', self.root)
        self.root_patch.start()
        (self.root / 'keys').mkdir(mode=0o700)
        self.args = gateway_install.parser().parse_args(['preflight', '--skip-collector', '--env-file', str(self.root / 'keys/automation.env'), '--endpoint', '192.0.2.10:51820', '--public-url', 'https://gateway.example.com'])

    def tearDown(self):
        self.root_patch.stop()
        self.temp.cleanup()

    def test_tls_and_endpoint_validation(self):
        self.assertEqual(endpoint('192.0.2.10:51820'), '192.0.2.10:51820')
        self.assertEqual(public_url('https://gateway.example.com/'), 'https://gateway.example.com')
        for value in ['0.0.0.0:51820', '224.0.0.1:51820', 'example.com:51820', '192.0.2.1:0', '192.0.2.1:65536', '192.0.2.1:80\n']:
            with self.subTest(value=value), self.assertRaises(InstallError):
                endpoint(value)
        for value in ['http://gateway.example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?token=x', 'https://example.com/#x', 'https://example.com:wrong', 'https://example.com\\path']:
            with self.subTest(value=value), self.assertRaises(InstallError):
                public_url(value)

    def test_image_architecture_is_checked(self):
        for metadata, expected in [({'os': 'linux', 'architecture': 'amd64'}, True), ({'os': 'linux', 'architecture': 'arm64'}, False), ({'os': 'windows', 'architecture': 'amd64'}, False)]:
            with patch.object(gateway_install, 'run', return_value=json.dumps(metadata).encode()), patch.object(gateway_install.platform, 'machine', return_value='x86_64'):
                self.assertEqual(gateway_install.image_compatible('test-image'), expected)

    def test_ingress_overlap_preserves_other_projects(self):
        def network(owner, subnet):
            return {'Labels': {'com.docker.compose.project': owner}, 'IPAM': {'Config': [{'Subnet': subnet}]}}
        for inventory, expected in [([network('other', '172.30.88.0/24')], False), ([network('other', '172.30.0.0/16')], False), ([network('zt_auto', '172.30.88.0/24')], True), ([network('other', '172.31.0.0/16')], True)]:
            def fake(command, *_args, **_kwargs):
                return b'network-id\n' if command[:4] == ['docker', 'network', 'ls', '-q'] else json.dumps(inventory).encode()
            with patch.object(gateway_install, 'run', side_effect=fake):
                self.assertEqual(gateway_install.ingress_available('zt_auto', '172.30.88.0/24'), expected)

    def test_https_origin_redirect_is_refused(self):
        with self.assertRaises(InstallError):
            gateway_install.NoRedirect().redirect_request(None, None, 302, 'redirect', {}, 'http://other.example.com')
        with self.assertRaises(InstallError):
            gateway_install.NoRedirect().redirect_request(None, None, 307, 'redirect', {}, 'https://other.example.com')

    def test_verify_origin_sends_user_agent_and_checks_identity(self):
        calls = []

        class FakeResponse:
            def __init__(self, data, status=200):
                self._data = data
                self.status = status

            def read(self, limit):
                return self._data

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

        def fake_open(req, timeout=None):
            calls.append(req)
            if '/readyz' in req.full_url:
                return FakeResponse(b'{"status":"READY"}')
            if '/api/enrollment/info' in req.full_url:
                return FakeResponse(b'{"gateway_id":"gw-123"}')
            raise ValueError(f'Unexpected url {req.full_url}')

        with patch('urllib.request.OpenerDirector.open', side_effect=fake_open):
            gateway_install.verify_origin(self.args, 'https://gateway.example.com', expected_id='gw-123')

        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0].get_header('User-agent'), 'ZT-ServerOps/1.0')
        self.assertEqual(calls[1].get_header('User-agent'), 'ZT-ServerOps/1.0')
        self.assertTrue(calls[0].full_url.endswith('/readyz'))
        self.assertTrue(calls[1].full_url.endswith('/api/enrollment/info'))

    def test_private_file_symlink_and_mode_guards(self):
        path = self.root / 'keys/test.env'
        atomic_write(path, 'VALUE=secret\n')
        self.assertEqual(read_env(path), {'VALUE': 'secret'})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        path.chmod(0o644)
        with self.assertRaises(InstallError): private_read(path)
        path.chmod(0o600)
        link = self.root / 'link'
        link.symlink_to(path)
        with self.assertRaises(InstallError): private_read(link)
        with self.assertRaises(InstallError): atomic_write(link, 'replacement')
        self.assertEqual(path.read_text(), 'VALUE=secret\n')
        directory_link = self.root / 'linkedkeys'
        directory_link.symlink_to(self.root / 'keys', target_is_directory=True)
        with self.assertRaises(InstallError): atomic_write(directory_link / 'new', 'secret')

    def test_paths_refuse_external_environment_and_wrong_journal(self):
        self.args.env_file = self.root / 'outside.env'
        with self.assertRaises(InstallError): gateway_install.paths(self.args)
        self.args.env_file = self.root / 'keys/automation.env'
        state_path = self.args.env_file.with_suffix('.state.json')
        atomic_write(state_path, json.dumps({'version': 1, 'root': str(self.root), 'project': 'another'}))
        with self.assertRaises(InstallError): gateway_install.journal(self.args)

    def test_password_input_only_stdin_and_validated(self):
        self.args.password_stdin = True
        stdin = argparse.Namespace(buffer=io.BytesIO(json.dumps({'password': 'a strong private secret'}).encode()))
        with patch.object(sys, 'stdin', stdin):
            self.assertEqual(gateway_install.password(self.args), 'a strong private secret')
        for value in [{'password': 'short'}, {'password': 'x' * 257}, {'password': 'validlength\nsecret'}, {'password': 'long enough', 'other': 'field'}]:
            stdin = argparse.Namespace(buffer=io.BytesIO(json.dumps(value).encode()))
            with patch.object(sys, 'stdin', stdin), self.assertRaises(InstallError):
                gateway_install.password(self.args)

    def test_native_errors_do_not_echo_secret_or_argv(self):
        result = subprocess.CompletedProcess(['not-a-command'], 1, b'PASSWORD=never-display', b'database-url-with-secret')
        with patch('gateway_support.subprocess.run', return_value=result):
            with self.assertRaises(InstallError) as raised:
                run(['not-a-command', 'private-argument'], self.root)
        self.assertNotIn('never-display', str(raised.exception))
        self.assertNotIn('database-url', str(raised.exception))
        self.assertNotIn('private-argument', str(raised.exception))

    def test_real_child_cannot_consume_installer_password_stdin(self):
        fixture = b'private-password-input-for-parent-only'
        code = '''import json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from gateway_support import run
child = [sys.executable,'-c','import sys;print(len(sys.stdin.buffer.read()))']
empty = int(run(child,Path.cwd()).strip())
explicit = int(run(child,Path.cwd(),data=b'child-payload').strip())
print(json.dumps({'empty':empty,'explicit':explicit,'retained':len(sys.stdin.buffer.read())}))
'''
        result = subprocess.run([sys.executable, '-c', code, str(ROOT / 'deploy/automation')],
                                input=fixture, capture_output=True, check=True, timeout=10)
        self.assertEqual(json.loads(result.stdout), {'empty': 0, 'explicit': 13, 'retained': len(fixture)})

    def test_failed_preflight_has_no_install_side_effects(self):
        with patch.object(gateway_install, 'preflight', return_value={'ok': False, 'checks': []}), patch.object(gateway_install, 'generate') as generate, contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(InstallError): gateway_install.install(self.args)
        generate.assert_not_called()
        self.assertEqual(list((self.root / 'keys').iterdir()), [])

    def test_unmanaged_project_resources_are_rejected(self):
        def fake_run(command, *_args, **_kwargs):
            if command[:3] == ['docker', 'volume', 'ls']:
                return b'existing_project_pgdata\n'
            return b''
        with patch.object(gateway_install, 'run', side_effect=fake_run), patch.object(gateway_install.os, 'geteuid', return_value=0), patch.object(gateway_install.shutil, 'which', return_value='/tool'):
            report = gateway_install.preflight(self.args)
        check = next(x for x in report['checks'] if x['check'] == 'No unmanaged project volumes')
        self.assertFalse(check['ok'])
        self.assertFalse(report['ok'])

    def test_missing_managed_env_is_not_regenerated(self):
        state = {'version': 1, 'project': self.args.project, 'root': str(self.root), 'phase': 'database_ready'}
        atomic_write(self.args.env_file.with_suffix('.state.json'), json.dumps(state))
        with patch.object(gateway_install, 'run', return_value=b''), patch.object(gateway_install.os, 'geteuid', return_value=0), patch.object(gateway_install.shutil, 'which', return_value='/tool'):
            report = gateway_install.preflight(self.args)
        check = next(x for x in report['checks'] if x['check'].startswith('Managed environment retained'))
        self.assertFalse(check['ok'])

    @unittest.skipUnless(shutil.which('openssl') and shutil.which('ssh-keygen'), 'requires actual key generation binaries')
    def test_real_key_generation_and_resume_preserves_secrets(self):
        (self.root / '.env.example').write_text((ROOT / '.env.example').read_text())
        (self.root / 'deploy/wireguard').mkdir(parents=True)
        (self.root / 'deploy/wireguard/wg0-gateway.conf').write_text((ROOT / 'deploy/wireguard/wg0-gateway.conf').read_text())
        with patch.object(gateway_install.os, 'chown'):
            first = gateway_install.generate(self.args, {})
        before = {p.name: p.read_bytes() for p in (self.root / 'keys').iterdir() if p.is_file()}
        with patch.object(gateway_install.os, 'chown'):
            second = gateway_install.generate(self.args, {})
        self.assertEqual(first, second)
        self.assertEqual(before, {p.name: p.read_bytes() for p in (self.root / 'keys').iterdir() if p.is_file()})
        self.assertNotIn('[Peer]', (self.root / 'keys/wg0-gateway.conf').read_text())
        self.assertFalse((self.root / 'keys/demo-login.env').exists())
        self.assertFalse((self.root / 'keys/bootstrap_admin.secret').exists())
        self.assertFalse((self.root / 'keys/wireguard_node_01_private.key').exists())
        self.assertEqual(self.args.env_file.stat().st_mode & 0o777, 0o600)
        self.assertTrue(first['ENROLLMENT_GATEWAY_ID'].startswith('sha256:'))
        self.assertRegex(first['TELEGRAM_PAIR_OTP'], r'^\d{6}$')
        self.args.endpoint = '192.0.2.11:51820'
        with self.assertRaises(InstallError): gateway_install.generate(self.args, {})
        self.assertEqual(before, {p.name: p.read_bytes() for p in (self.root / 'keys').iterdir() if p.is_file()})

    def test_collector_mode_is_preserved_for_resume(self):
        self.args.skip_collector = False
        gateway_install.restore_collector_mode(self.args, {'skip_collector': True})
        self.assertTrue(self.args.skip_collector)
        gateway_install.restore_collector_mode(self.args, {'skip_collector': False})
        self.assertFalse(self.args.skip_collector)
        with self.assertRaises(InstallError):
            gateway_install.restore_collector_mode(self.args, {'skip_collector': 'true'})

    def test_collector_source_path_is_checked_before_install(self):
        self.args.skip_collector = False
        with patch.object(gateway_install, 'run', return_value=b''), patch.object(gateway_install, 'collector_path_supported', return_value=False), patch.object(gateway_install.os, 'geteuid', return_value=0), patch.object(gateway_install.shutil, 'which', return_value='/tool'):
            report = gateway_install.preflight(self.args)
        check = next(x for x in report['checks'] if x['check'] == 'Collector source path supports systemd')
        self.assertFalse(check['ok'])
        self.assertFalse(report['ok'])
        for path in ['/srv/path with space', '/srv/path%with-expand', '/srv/path\twith-control']:
            with patch.object(gateway_install, 'ROOT', Path(path)):
                self.assertFalse(gateway_install.collector_path_supported())

    def test_collector_checks_actual_snapshot_and_timer(self):
        self.args.skip_collector = False
        host_dir = self.root / 'keys/host-monitor'
        host_dir.mkdir()
        values = {'HOST_MONITOR_DIR': str(host_dir)}
        def snapshot(age=0, states=None):
            data = {'sampled_at': (datetime.now(timezone.utc) - timedelta(seconds=age)).isoformat(),
                    'services': states or [{'id': name, 'state': 'healthy'} for name in gateway_install.CORE]}
            (host_dir / 'host.json').write_text(json.dumps(data))
        def fake(command, *_args, **_kwargs):
            return b'success\n' if 'show' in command else b''
        snapshot()
        with patch.object(gateway_install, 'run', side_effect=fake) as execute:
            result = gateway_install.verify_collector(self.args, values)
        self.assertEqual(result['status'], 'verified')
        self.assertEqual(result['core_healthy'], 4)
        self.assertTrue(any('is-active' in call.args[0] for call in execute.call_args_list))
        for age in [16, -3]:
            snapshot(age)
            with self.assertRaises(InstallError):
                gateway_install.verify_collector(self.args, values)
        snapshot(states=[{'id': name, 'state': 'unhealthy' if name == 'gateway' else 'healthy'} for name in gateway_install.CORE])
        with self.assertRaises(InstallError):
            gateway_install.verify_collector(self.args, values)
        snapshot()
        with patch.object(gateway_install, 'run', side_effect=InstallError('Timer not active')), self.assertRaises(InstallError):
            gateway_install.verify_collector(self.args, values)
        with patch.object(gateway_install, 'run', return_value=b'failed'), self.assertRaises(InstallError):
            gateway_install.verify_collector(self.args, values)
        self.args.skip_collector = True
        with patch.object(gateway_install, 'guarded_path', side_effect=AssertionError('must not read skipped collector')):
            self.assertEqual(gateway_install.verify_collector(self.args, values), {'status': 'NOT_RUN'})

    def test_invite_never_overwrites_or_prints_code(self):
        self.args.node_name, self.args.worker_os = 'new-worker', 'linux'
        self.args.output = self.root / 'keys/invite.json'
        secret = 'private-join-code-never-console'
        with patch.object(gateway_install, 'admin_command', return_value={'join_token': secret}), contextlib.redirect_stdout(io.StringIO()) as output:
            gateway_install.invitation(self.args)
        self.assertNotIn(secret, output.getvalue())
        self.assertEqual(json.loads(private_read(self.args.output))['join_token'], secret)
        with self.assertRaises(InstallError): gateway_install.invitation(self.args)
        self.assertEqual(json.loads(private_read(self.args.output))['join_token'], secret)


if __name__ == '__main__':
    unittest.main()
