#!/usr/bin/env python3
"""Contract/security units. WG/DB/systemd calls are mocked, not runtime PASS."""
import argparse
import base64
import contextlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


register = module('native_register', ROOT / 'scripts/register-worker.py')
doctor = module('native_doctor', ROOT / 'scripts/doctor.py')
GW_PRIVATE = base64.b64encode(b'A' * 32).decode()
GW_PUBLIC = base64.b64encode(b'B' * 32).decode()
WORKER_PRIVATE = base64.b64encode(b'C' * 32).decode()
WORKER_PUBLIC = base64.b64encode(b'D' * 32).decode()
OTHER_PUBLIC = base64.b64encode(b'E' * 32).decode()
PIN = 'SHA256:' + base64.b64encode(b'F' * 32).decode().rstrip('=')


class Helpers(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='zt-native-helper-unit-')
        self.root = Path(self.temp.name)
        self.config = self.root / 'config'
        self.config.mkdir(mode=0o700)
        self.wg = self.config / 'ztgw0.conf'
        register.write_private(self.wg, f'[Interface]\nPrivateKey = {GW_PRIVATE}\nAddress = 10.231.0.1/24\nListenPort = 51821\n')
        self.bastion = self.config / 'bastion'
        if not shutil.which('ssh-keygen'):
            self.skipTest('ssh-keygen is required for real Ed25519 public-key fixtures')
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(self.bastion)], check=True)
        self.bastion.chmod(0o400)
        self.original_wg = self.wg.read_text()
        self.install = {'install_dir': str(self.root), 'config_dir': str(self.config),
                        'data_dir': str(self.root / 'data'), 'node_path': '/fixture/node',
                        'gateway_dir': str(self.root / 'gateway'), 'wg_config': str(self.wg),
                        'wg_interface': 'ztgw0', 'wg_address': '10.231.0.1/24', 'wg_ip': '10.231.0.1',
                        'api_port': 3101, 'wg_port': 51821, 'bastion_key': str(self.bastion),
                        'pg_bin_dir': '/fixture/postgres', 'pg_lib_dirs': [], 'db_port': 55433,
                        'web_port': 8444, 'app_os_user': '__zt_fixture_user__',
                        'units': [f'zt-native-{name}.service' for name in ('wireguard', 'postgres', 'gateway', 'caddy')]}
        (self.config / 'install.json').write_text(json.dumps(self.install))
        register.write_private(self.config / 'gateway.env',
                               'DATABASE_URL=postgresql://zt_app:UNIT_SECRET@127.0.0.1:55433/zt_serverops\n')
        register.write_private(self.config / 'admin.env', 'MIGRATION_DATABASE_URL=UNIT_ADMIN_SECRET\n')
        register.write_private(self.config / 'login.json', '{}\n')
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def fake_run(self, command, **kwargs):
        self.calls.append((command, kwargs))
        if command == ['wg', 'genkey']:
            return (WORKER_PRIVATE + '\n').encode()
        if command == ['wg', 'pubkey']:
            private = kwargs['input'].decode().strip()
            return ((GW_PUBLIC if private == GW_PRIVATE else WORKER_PUBLIC) + '\n').encode()
        if command[:2] == ['ssh-keygen', '-y']:
            return subprocess.run(command, check=True, capture_output=True).stdout
        if command[:3] == ['wg', 'show', 'ztgw0']:
            return b''
        if command[0] == '/fixture/node':
            return b'{"node_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","created":true}\n'
        if command[:3] == ['wg', 'set', 'ztgw0']:
            return b''
        raise AssertionError('Unexpected fixture command')

    def prepare_bundle(self, name='native-worker'):
        args = argparse.Namespace(node_name=name, node_ip='10.231.0.2', gateway_endpoint='100.78.198.50:51821',
                                  worker_interface='zt-worker', mtu=1200, node_type='VM', worker_os='linux',
                                  bundle=self.root / name)
        with patch.object(register, 'run', side_effect=self.fake_run), contextlib.redirect_stdout(io.StringIO()):
            register.prepare(args, self.install, self.config)
        return args.bundle

    def registration_args(self, bundle):
        return argparse.Namespace(bundle=bundle, host_public_key=Path(str(self.bastion) + '.pub'),
                                  host_fingerprint=None, ssh_user='ztuser')

    def test_environment_is_data_not_shell_and_duplicate_is_rejected(self):
        trap = self.root / 'must-not-exist'
        path = self.root / 'env'
        path.write_text('VALUE="$(touch ' + str(trap) + ')"\nOTHER=literal#value\n')
        self.assertEqual(register.read_env(path)['OTHER'], 'literal#value')
        self.assertFalse(trap.exists())
        path.write_text('KEY=one\nKEY=two\n')
        with self.assertRaises(ValueError):
            register.read_env(path)
        path.write_text('export KEY=value\n')
        with self.assertRaises(ValueError):
            register.read_env(path)

    def test_environment_quotes_and_whitespace_contract(self):
        path = self.root / 'env'
        path.write_text("A='one two'\nB=plain\nC=\n")
        self.assertEqual(register.read_env(path), {'A': 'one two', 'B': 'plain', 'C': ''})
        for payload in ('A=one two\n', 'A="x" extra\n', 'bad-name=value\n', 'missing_equals\n'):
            path.write_text(payload)
            with self.assertRaises(ValueError):
                register.read_env(path)

    def test_protected_files_reject_symlinks_and_wrong_modes(self):
        target = self.root / 'secret'
        register.write_private(target, 'FIXTURE_SECRET')
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        alias = self.root / 'alias'
        alias.symlink_to(target)
        with self.assertRaises(ValueError):
            register.private_file(alias)
        target.chmod(0o644)
        with self.assertRaises(ValueError):
            register.private_file(target)
        with self.assertRaises(FileExistsError):
            register.write_private(alias, 'overwrite')
        self.assertEqual(target.read_text(), 'FIXTURE_SECRET')

    def test_host_pin_matches_real_ssh_keygen_and_rejects_private_key(self):
        public = Path(str(self.bastion) + '.pub')
        expected = subprocess.run(['ssh-keygen', '-lf', str(public), '-E', 'sha256'],
                                  check=True, capture_output=True, text=True).stdout.split()[1]
        self.assertEqual(register.fingerprint(public), expected)
        with self.assertRaises(ValueError):
            register.fingerprint(self.bastion)
        public.write_text('ssh-ed25519 ' + base64.b64encode(b'wrong-wire-format').decode())
        with self.assertRaises(ValueError):
            register.fingerprint(public)

    def test_overlay_profile_uses_installation_network_and_allows_first_worker(self):
        self.assertEqual(register.worker_ip('10.231.0.2', self.install), '10.231.0.2')
        for address in ('10.231.0.1', '10.231.0.0', '10.231.0.255', '10.100.0.2', '::1'):
            with self.assertRaises(ValueError):
                register.worker_ip(address, self.install)

    def test_endpoint_accepts_tailnet_ipv4_and_rejects_injection_or_bad_port(self):
        self.assertEqual(register.endpoint('100.78.198.50:51820'), '100.78.198.50:51820')
        for value in ('100.78.198.50:0', '100.78.198.50:65536', '::1:51820', 'host;touch x:51820', 'hostname:51820'):
            with self.assertRaises(ValueError):
                register.endpoint(value)

    def test_peer_collision_checks_network_overlap_and_public_key_reassignment(self):
        same = f'[Peer]\nPublicKey = {WORKER_PUBLIC}\nAllowedIPs = 10.231.0.2/32\n'
        self.assertTrue(register.peer_check(same, WORKER_PUBLIC, '10.231.0.2'))
        self.assertFalse(register.peer_check('', WORKER_PUBLIC, '10.231.0.2'))
        for config in (same.replace('10.231.0.2', '10.231.0.3'),
                       same.replace(WORKER_PUBLIC, OTHER_PUBLIC),
                       same.replace(WORKER_PUBLIC, OTHER_PUBLIC).replace('10.231.0.2/32', '10.231.0.0/24')):
            with self.assertRaises(ValueError):
                register.peer_check(config, WORKER_PUBLIC, '10.231.0.2')
        with self.assertRaises(ValueError):
            register.live_peer_check(OTHER_PUBLIC + '\t10.231.0.0/24\n', WORKER_PUBLIC, '10.231.0.2')

    def test_prepare_bundle_has_only_worker_secrets_no_bastion_or_admin_secret(self):
        bundle = self.prepare_bundle()
        self.assertEqual(self.wg.read_text(), self.original_wg)
        self.assertEqual(stat.S_IMODE(bundle.stat().st_mode), 0o700)
        self.assertEqual({path.name for path in bundle.iterdir()},
                         {'metadata.json', 'node.token', 'agent-config.json', 'zt-worker.conf', 'bastion_id_ed25519.pub'})
        for path in bundle.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            text = path.read_text()
            self.assertNotIn('OPENSSH PRIVATE KEY', text)
            self.assertNotIn(GW_PRIVATE, text)
            self.assertNotIn('UNIT_ADMIN_SECRET', text)
            self.assertNotIn('UNIT_SECRET', text)
        agent = json.loads((bundle / 'agent-config.json').read_text())
        self.assertEqual(agent['GATEWAY_URL'], 'http://10.231.0.1:3101')
        self.assertEqual(agent['NODE_TOKEN'], (bundle / 'node.token').read_text().strip())
        self.assertIn('MTU = 1200', (bundle / 'zt-worker.conf').read_text())
        self.assertFalse(any(command[0] == '/fixture/node' for command, _ in self.calls))

    def test_prepare_rejects_bad_bastion_before_creating_bundle(self):
        self.bastion.chmod(0o600)
        with self.assertRaises(ValueError):
            self.prepare_bundle()
        self.assertFalse((self.root / 'native-worker').exists())

    def test_registration_passes_only_runtime_db_role_and_host_pinned_payload(self):
        bundle = self.prepare_bundle()
        self.calls.clear()
        with patch.object(register, 'run', side_effect=self.fake_run), contextlib.redirect_stdout(io.StringIO()):
            register.register(self.registration_args(bundle), self.install, self.config)
            first = self.wg.read_text()
            register.register(self.registration_args(bundle), self.install, self.config)
        self.assertEqual(self.wg.read_text(), first)
        self.assertEqual(first.count('[Peer]'), 1)
        node_calls = [(command, options) for command, options in self.calls if command[0] == '/fixture/node']
        self.assertEqual(len(node_calls), 2)
        data = json.loads(node_calls[0][1]['input'])
        self.assertEqual(data['host_key_fingerprint'], register.fingerprint(Path(str(self.bastion) + '.pub')))
        self.assertEqual(data['ssh_username'], 'ztuser')
        self.assertEqual(set(data), {'node_name', 'node_ip', 'node_type', 'node_token', 'host_key_fingerprint', 'ssh_username'})
        self.assertEqual(set(node_calls[0][1]['env']), {'PATH', 'NODE_ENV', 'DATABASE_URL'})
        self.assertNotIn('UNIT_ADMIN_SECRET', str(node_calls))
        self.assertEqual((self.config / 'wireguard.before-native-worker.conf').read_text(), self.original_wg)

    def test_registration_refuses_conflicting_live_peer_before_db_or_config_write(self):
        bundle = self.prepare_bundle()
        self.calls.clear()
        original = self.fake_run
        def collision(command, **kwargs):
            if command[:3] == ['wg', 'show', 'ztgw0']:
                return (OTHER_PUBLIC + '\t10.231.0.2/32\n').encode()
            return original(command, **kwargs)
        with patch.object(register, 'run', side_effect=collision), self.assertRaises(ValueError):
            register.register(self.registration_args(bundle), self.install, self.config)
        self.assertEqual(self.wg.read_text(), self.original_wg)
        self.assertFalse(any(command[0] == '/fixture/node' for command, _ in self.calls))

    def test_registration_refuses_admin_db_url_and_untrusted_profile(self):
        bundle = self.prepare_bundle()
        env = self.config / 'gateway.env'
        env.write_text('DATABASE_URL=postgresql://zt_admin:UNIT_ADMIN_SECRET@127.0.0.1/zt_serverops\n')
        with self.assertRaises(ValueError):
            register.register(self.registration_args(bundle), self.install, self.config)
        metadata = json.loads((bundle / 'metadata.json').read_text())
        metadata['gateway_ip'] = '10.100.0.1'
        with self.assertRaises(ValueError):
            register.registration_payload(metadata, 'A' * 48, PIN, 'ztuser', self.install)
        metadata['gateway_ip'] = self.install['wg_ip']
        for name, value in (('node_token', 'short'), ('host_key_fingerprint', 'SHA256:unverified'), ('ssh_username', 'root; id')):
            arguments = [metadata, 'A' * 48, PIN, 'ztuser', self.install]
            arguments[{'node_token': 1, 'host_key_fingerprint': 2, 'ssh_username': 3}[name]] = value
            with self.assertRaises(ValueError):
                register.registration_payload(*arguments)

    def test_failed_command_suppresses_stderr_and_stdout_secrets(self):
        completed = subprocess.CompletedProcess(['fixture'], 1, b'UNIT_TOKEN_SECRET', b'UNIT_DB_SECRET')
        with patch.object(register.subprocess, 'run', return_value=completed):
            with self.assertRaises(RuntimeError) as context:
                register.run(['fixture'])
        self.assertNotIn('UNIT_', str(context.exception))

    def test_doctor_fails_closed_when_core_service_or_runtime_is_unavailable(self):
        with patch.object(doctor, 'inspect', return_value=None), patch.object(doctor, 'ready', return_value=False):
            report = doctor.diagnose(self.config)
        self.assertFalse(report['ok'])
        failed = [row['check'] for row in report['checks'] if not row['ok']]
        self.assertIn('Bundled Node 22 runs', failed)
        self.assertIn('zt-native-gateway.service is active', failed)
        self.assertIn('WireGuard listens on the configured UDP port', failed)
        self.assertIn('Gateway API /readyz confirms PostgreSQL healthy', failed)
        self.assertIn('Runtime role connects to PostgreSQL', failed)
        self.assertNotIn('UNIT_SECRET', json.dumps(report))

    def test_listener_requires_ipv4_loopback_and_rejects_any_wildcard(self):
        good = 'LISTEN 0 128 127.0.0.1:55432 0.0.0.0:*\n'
        self.assertTrue(doctor.loopback_listener(good, 55432))
        self.assertFalse(doctor.loopback_listener(good.replace('127.0.0.1', '0.0.0.0'), 55432))
        self.assertFalse(doctor.loopback_listener(good + 'LISTEN 0 128 [::]:55432 [::]:*\n', 55432))
        self.assertFalse(doctor.loopback_listener('', 55432))

    def firewall_snapshot(self):
        return [
            '-P INPUT ACCEPT\n-A INPUT -i ztgw0 -j ZTNATIVE_IN\n',
            '-P FORWARD ACCEPT\n-A FORWARD -i ztgw0 -j ZTNATIVE_FW\n',
            '-N ZTNATIVE_IN\n-A ZTNATIVE_IN -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT\n'
            '-A ZTNATIVE_IN -d 10.231.0.1/32 -p tcp -m tcp --dport 3101 -j ACCEPT\n-A ZTNATIVE_IN -j DROP\n',
            '-N ZTNATIVE_FW\n-A ZTNATIVE_FW -j DROP\n',
            '-P PREROUTING ACCEPT\n-A PREROUTING -i ztgw0 -j ZTNATIVE_PRE\n',
            '-N ZTNATIVE_PRE\n-A ZTNATIVE_PRE -m addrtype ! --dst-type LOCAL -j DROP\n'
            '-A ZTNATIVE_PRE -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT\n'
            '-A ZTNATIVE_PRE -d 10.231.0.1/32 -p tcp -m tcp --dport 3101 -j ACCEPT\n'
            '-A ZTNATIVE_PRE -j DROP\n',
        ]

    def test_firewall_requires_scoped_jumps_even_when_services_and_readiness_are_healthy(self):
        safe = self.firewall_snapshot()
        self.assertTrue(doctor.project_firewall_ok(*safe, 'ztgw0', 3101, '10.231.0.1'))
        for position in range(6):
            broken = safe.copy()
            broken[position] = None if position >= 2 else broken[position].splitlines()[0] + '\n'
            with self.subTest(missing_chain_or_jump=position):
                self.assertFalse(doctor.project_firewall_ok(*broken, 'ztgw0', 3101, '10.231.0.1'))
        wrong_scope = safe.copy()
        wrong_scope[0] = wrong_scope[0].replace('-i ztgw0', '-i eth0')
        self.assertFalse(doctor.project_firewall_ok(*wrong_scope, 'ztgw0', 3101, '10.231.0.1'))
        # Availability cannot stand in for policy: /readyz and services can stay up.
        def available(command, **kwargs):
            if command[:2] == ['systemctl', 'is-active']:
                return 'active'
            if command[:4] == ['iptables', '-w', '5', '-S']:
                return None
            return None
        with patch.object(doctor, 'inspect', side_effect=available), patch.object(doctor, 'ready', return_value=True):
            report = doctor.diagnose(self.config)
        firewall = next(row for row in report['checks'] if row['check'].startswith('Project firewall'))
        readiness = next(row for row in report['checks'] if row['check'].startswith('Gateway API /readyz'))
        gateway = next(row for row in report['checks'] if row['check'] == 'zt-native-gateway.service is active')
        self.assertFalse(firewall['ok'])
        self.assertTrue(readiness['ok'])
        self.assertTrue(gateway['ok'])
        self.assertFalse(report['ok'])

    def test_firewall_rejects_wrong_api_or_any_accept_bypass_in_owned_chains(self):
        safe = self.firewall_snapshot()
        for position, original, replacement in (
            (2, '--dport 3101', '--dport 3000'),
            (2, '-d 10.231.0.1/32', '-d 10.231.0.99/32'),
            (2, '-d 10.231.0.1/32 ', ''),
            (2, '-A ZTNATIVE_IN -j DROP', '-A ZTNATIVE_IN -j ACCEPT\n-A ZTNATIVE_IN -j DROP'),
            (2, '-A ZTNATIVE_IN -j DROP', ''),
            (2, 'RELATED,ESTABLISHED', 'NEW,RELATED,ESTABLISHED'),
            (3, '-j DROP', '-j ACCEPT'),
        ):
            unsafe = safe.copy()
            unsafe[position] = unsafe[position].replace(original, replacement)
            with self.subTest(unsafe=replacement):
                self.assertFalse(doctor.project_firewall_ok(*unsafe, 'ztgw0', 3101, '10.231.0.1'))

    def test_prerouting_guard_remains_required_when_filter_accept_precedes_project_rules(self):
        snapshot = self.firewall_snapshot()
        snapshot[1] = '-P FORWARD ACCEPT\n-A FORWARD -o tailscale0 -j ACCEPT\n' \
                      '-A FORWARD -i ztgw0 -j ZTNATIVE_FW\n'
        snapshot[0] = '-P INPUT ACCEPT\n-A INPUT -p udp --dport 41641 -j ACCEPT\n' \
                      '-A INPUT -i ztgw0 -j ZTNATIVE_IN\n'
        self.assertTrue(doctor.project_firewall_ok(*snapshot, 'ztgw0', 3101, '10.231.0.1'))
        for position, before, after in (
            (4, '-i ztgw0', '-i eth0'),
            (4, '-A PREROUTING -i ztgw0', '-A PREROUTING -j ACCEPT\n-A PREROUTING -i ztgw0'),
            (5, '! --dst-type LOCAL', '--dst-type LOCAL'),
            (5, '-j DROP', '-j RETURN'),
            (5, '-A ZTNATIVE_PRE -m', '-A ZTNATIVE_PRE -j RETURN\n-A ZTNATIVE_PRE -m'),
        ):
            broken = snapshot.copy()
            broken[position] = broken[position].replace(before, after)
            with self.subTest(guard_change=after):
                self.assertFalse(doctor.project_firewall_ok(*broken, 'ztgw0', 3101, '10.231.0.1'))

    def test_prerouting_rejects_extra_host_service_or_wrong_api_destination(self):
        safe = self.firewall_snapshot()
        for before, after in (
            ('-A ZTNATIVE_PRE -j DROP', '-A ZTNATIVE_PRE -p udp --dport 41641 -j ACCEPT\n-A ZTNATIVE_PRE -j DROP'),
            ('-d 10.231.0.1/32', '-d 10.231.0.99/32'),
            ('RELATED,ESTABLISHED', 'NEW,RELATED,ESTABLISHED'),
            ('--dport 3101', '--dport 3000'),
        ):
            broken = safe.copy()
            broken[5] = broken[5].replace(before, after)
            with self.subTest(unsafe=after):
                self.assertFalse(doctor.project_firewall_ok(*broken, 'ztgw0', 3101, '10.231.0.1'))

    def worker_snapshot(self):
        rows = [{'name': 'native-worker', 'ip': '10.231.0.2', 'age': 3.0, 'pinned': True}]
        configuration = self.original_wg + f'\n[Peer]\nPublicKey = {WORKER_PUBLIC}\nAllowedIPs = 10.231.0.2/32\n'
        allowed = WORKER_PUBLIC + '\t10.231.0.2/32\n'
        handshakes = WORKER_PUBLIC + '\t990\n'
        return rows, configuration, allowed, handshakes

    def test_worker_check_correlates_database_ip_and_config_live_public_identity(self):
        values = self.worker_snapshot()
        expected = {'identity': True, 'fresh': True, 'handshake': True}
        self.assertEqual(doctor.worker_consistency(*values, self.install, 15, now=1000), expected)
        for changed in ('public', 'database-ip', 'live-ip', 'unapplied-config'):
            rows, configuration, allowed, handshakes = self.worker_snapshot()
            if changed == 'public':
                allowed = allowed.replace(WORKER_PUBLIC, OTHER_PUBLIC)
            elif changed == 'database-ip':
                rows[0]['ip'] = '10.231.0.3'
            elif changed == 'live-ip':
                allowed = allowed.replace('10.231.0.2', '10.231.0.3')
            else:
                configuration += f'\n[Peer]\nPublicKey = {OTHER_PUBLIC}\nAllowedIPs = 10.231.0.3/32\n'
            result = doctor.worker_consistency(rows, configuration, allowed, handshakes, self.install, 15, now=1000)
            with self.subTest(changed=changed):
                self.assertFalse(result['identity'])
                self.assertFalse(result['handshake'])

    def test_unrelated_recent_handshake_cannot_cover_a_registered_worker(self):
        rows, configuration, allowed, _ = self.worker_snapshot()
        for handshakes in (OTHER_PUBLIC + '\t999\n',
                           OTHER_PUBLIC + '\t999\n' + WORKER_PUBLIC + '\t1\n',
                           WORKER_PUBLIC + '\t1001\n'):
            result = doctor.worker_consistency(rows, configuration, allowed, handshakes, self.install, 15, now=1000)
            self.assertTrue(result['identity'])
            self.assertFalse(result['handshake'])

    def test_freshness_and_pins_are_required_for_each_registered_worker(self):
        for age, pinned in ((None, True), (-1.0, True), (15.0, True), (3.0, False), (True, True)):
            rows, configuration, allowed, handshakes = self.worker_snapshot()
            rows[0].update(age=age, pinned=pinned)
            result = doctor.worker_consistency(rows, configuration, allowed, handshakes, self.install, 15, now=1000)
            self.assertFalse(result['fresh'])
        self.assertFalse(any(doctor.worker_consistency([], '', '', '', self.install, 15).values()))

    def test_peer_check_rejects_broad_allowedips_duplicate_keys_and_malformed_live_output(self):
        rows, configuration, allowed, handshakes = self.worker_snapshot()
        for malformed in (configuration.replace('10.231.0.2/32', '10.231.0.0/24'),
                          configuration + f'[Peer]\nPublicKey = {WORKER_PUBLIC}\nAllowedIPs = 10.231.0.3/32\n'):
            result = doctor.worker_consistency(rows, malformed, allowed, handshakes, self.install, 15, now=1000)
            self.assertFalse(any(result.values()))
        self.assertFalse(any(doctor.worker_consistency(rows, configuration, 'malformed', handshakes,
                                                     self.install, 15, now=1000).values()))

    def test_doctor_startup_does_not_create_helper_bytecode_cache(self):
        copied = self.root / 'doctor-startup'
        copied.mkdir()
        for filename in ('doctor.py', 'register-worker.py'):
            shutil.copyfile(ROOT / 'scripts' / filename, copied / filename)
        environment = dict(os.environ)
        environment.pop('PYTHONDONTWRITEBYTECODE', None)
        completed = subprocess.run([sys.executable, str(copied / 'doctor.py'), '--help'],
                                   capture_output=True, text=True, env=environment, check=False)
        self.assertEqual(completed.returncode, 0)
        self.assertFalse((copied / '__pycache__').exists(), 'Read-only doctor must not create helper .pyc files')


class ReadyHTTP(unittest.TestCase):
    def test_readiness_checks_json_status_size_redirect_and_ignores_proxy(self):
        calls = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                calls.append(self.path)
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', '/good')
                    self.end_headers()
                    return
                body = {'/good': b'{"status":"READY","database":{"healthy":true}}',
                        '/unhealthy': b'{"status":"READY","database":{"healthy":false}}',
                        '/array': b'[]', '/nested-array': b'{"status":"READY","database":[]}',
                        '/wrong': b'{"status":"UP"}', '/large': b'x' * 8193}.get(self.path, b'not-json')
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f'http://127.0.0.1:{server.server_port}'
            with patch.dict(os.environ, {'HTTP_PROXY': 'http://127.0.0.1:1', 'http_proxy': 'http://127.0.0.1:1', 'NO_PROXY': ''}):
                self.assertTrue(doctor.ready(base + '/good'))
                for suffix in ('/unhealthy', '/wrong', '/large', '/not-json', '/redirect', '/array', '/nested-array'):
                    self.assertFalse(doctor.ready(base + suffix), suffix)
            self.assertEqual(calls.count('/good'), 1, 'Readiness must not follow redirects')
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
