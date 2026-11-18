"""Worker safety tests plus real local HTTPS; no host configuration changes."""
import base64
import copy
import datetime as dt
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid

AUTOMATION = Path(__file__).resolve().parents[1] / 'deploy/automation'
sys.path.insert(0, str(AUTOMATION))
import worker_support as support
spec = importlib.util.spec_from_file_location('automation_worker', AUTOMATION / 'worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def invitation(url='https://gateway.example/api/enrollment/claim'):
    public = base64.b64encode(secrets.token_bytes(32)).decode()
    ssh = base64.b64encode(b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20' + secrets.token_bytes(32)).decode()
    return {'version': 1, 'gateway_id': 'sha256:' + hashlib.sha256(base64.b64decode(public)).hexdigest(),
            'registration_url': url, 'wireguard_endpoint': '192.0.2.10:51820',
            'wireguard_public_key': public, 'gateway_vpn_ip': '10.100.0.1',
            'bastion_public_key': 'ssh-ed25519 ' + ssh, 'invitation_id': str(uuid.uuid4()),
            'join_token': secrets.token_urlsafe(48),
            'expires_at': (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=15)).isoformat(),
            'node_name': 'test-linux-01', 'node_type': 'VM', 'worker_os': 'linux', 'ssh_username': 'ztuser'}


def assignment(invite, ready=True):
    return {**{k: invite[k] for k in ('gateway_id', 'invitation_id', 'registration_url', 'node_name',
            'node_type', 'worker_os', 'ssh_username', 'gateway_vpn_ip', 'wireguard_endpoint',
            'wireguard_public_key', 'bastion_public_key')},
            'version': 1, 'status': 'READY' if ready else 'PENDING', 'peer_ready': ready,
            'node_id': str(uuid.uuid4()), 'node_ip': '10.100.0.3',
            'gateway_api_url': 'http://10.100.0.1:3000',
            'verification': {'peer_applied': ready, 'heartbeat_recent': False, 'ssh_authenticated': False}}


class InvitationTests(unittest.TestCase):
    def test_invitation_validates_gateway_fingerprint_os_and_code(self):
        value = invitation()
        self.assertEqual(support.validate_invite(value, 'linux'), value)
        bad = [dict(value, gateway_id='sha256:' + '0' * 64), dict(value, worker_os='windows'),
               dict(value, join_token='short'), dict(value, ssh_username='root'),
               dict(value, node_type='DOCKER'), dict(value, wireguard_endpoint='gateway.example:51820'),
               dict(value, wireguard_endpoint='192.0.2.10:0'), dict(value, gateway_vpn_ip='10.100.0.2'),
               dict(value, version=True), dict(value, extra='unexpected')]
        for item in bad:
            with self.subTest(fields=[key for key in item if item.get(key) != value.get(key)]):
                with self.assertRaises(support.InstallError):
                    support.validate_invite(item, 'linux')

    def test_url_rejects_plaintext_credentials_query_and_other_path(self):
        for url in ['http://gateway.example/api/enrollment/claim',
                    'https://user:password@gateway.example/api/enrollment/claim',
                    'https://gateway.example/api/enrollment/claim?token=secret',
                    'https://gateway.example/another', 'https://gateway.example/api/enrollment/claim#fragment']:
            with self.subTest(url=url), self.assertRaises(support.InstallError):
                support.validate_invite(invitation(url), 'linux')

    def test_expired_invitation_only_permitted_for_same_saved_retry(self):
        value = invitation()
        value['expires_at'] = '2000-01-01T00:00:00Z'
        with self.assertRaises(support.InstallError):
            support.validate_invite(value, 'linux')
        self.assertEqual(support.validate_invite(value, 'linux', allow_expired=True), value)

    def test_response_cannot_change_gateway_node_or_ssh_identity(self):
        value = invitation()
        good = assignment(value)
        self.assertEqual(support.validate_assignment(good, value), good)
        changes = {'registration_url': 'https://other.example/api/enrollment/claim',
                   'gateway_id': 'sha256:' + '0' * 64, 'node_name': 'different',
                   'wireguard_endpoint': '192.0.2.11:51820', 'node_ip': '10.100.0.1',
                   'gateway_api_url': 'http://other.example:3000', 'peer_ready': False,
                   'bastion_public_key': invitation()['bastion_public_key'],
                   'verification': {'peer_applied': True, 'heartbeat_recent': True}}
        for key, changed in changes.items():
            with self.subTest(key=key), self.assertRaises(support.InstallError):
                support.validate_assignment({**good, key: changed}, value)

    def test_private_write_is_atomic_private_and_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'identity.json'
            support.write_private(path, {'token': 'fixture-secret'})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(support.read_private_json(path)['token'], 'fixture-secret')
            support.write_private(path, {'token': 'preserved'})
            self.assertEqual(support.read_private_json(path)['token'], 'preserved')
            alias = root / 'link'
            alias.symlink_to(path)
            with self.assertRaises(support.InstallError):
                support.write_private(alias, 'replacement')
            self.assertEqual(support.read_private_json(path)['token'], 'preserved')
            path.chmod(0o644)
            with self.assertRaises(support.InstallError):
                support.read_private_json(path)


class LocalMutationTests(unittest.TestCase):
    def test_agent_hash_and_arch_checked_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'agent'
            data = bytearray(64)
            data[:6] = b'\x7fELF\x02\x01'
            data[18:20] = (62).to_bytes(2, 'little')
            binary.write_bytes(data)
            digest = hashlib.sha256(data).hexdigest()
            with patch.object(worker.platform, 'machine', return_value='x86_64'):
                self.assertEqual(worker.check_binary(binary, digest), digest)
                with self.assertRaises(support.InstallError):
                    worker.check_binary(binary, '0' * 64)
            with patch.object(worker.platform, 'machine', return_value='aarch64'):
                with self.assertRaises(support.InstallError):
                    worker.check_binary(binary, digest)

    def test_managed_backup_restore_and_foreign_edit_protection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            enrollment = root / 'enrollment';enrollment.mkdir(mode=0o700)
            (enrollment / 'backup').mkdir(mode=0o700)
            path = root / 'sshd_config';path.write_text('original\n');path.chmod(0o644)
            value = {'managed': {}, 'original_services': {'ssh': {'active': True, 'enabled': True}}, 'phase': 'enrolled'}
            restored = subprocess.CompletedProcess([], 0,
                stdout=b'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n', stderr=b'')
            with patch.object(worker, 'STATE', enrollment), patch.object(worker, 'JOURNAL', enrollment / 'state.json'), patch.object(worker, 'run', return_value=b''), patch.object(worker.subprocess, 'run', return_value=restored):
                worker.managed_write(path, 'managed\n', value)
                self.assertEqual(path.read_text(), 'managed\n')
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertTrue(worker.rollback(value))
                self.assertEqual(path.read_text(), 'original\n')
                self.assertEqual(path.stat().st_mode & 0o777, 0o644)
                worker.managed_write(path, 'managed\n', value)
                path.write_text('operator edit\n')
                with self.assertRaises(support.InstallError):
                    worker.managed_write(path, 'managed\n', value)
                self.assertFalse(worker.rollback(value))
                self.assertEqual(path.read_text(), 'operator edit\n')

    def test_missing_saved_identity_does_not_generate_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            value = {'identity_fingerprint': 'existing', 'phase': 'complete'}
            with patch.object(worker, 'STATE', Path(directory)), patch.object(worker, 'run') as command:
                with self.assertRaises(support.InstallError):
                    worker.identity(invitation(), value)
                command.assert_not_called()

    def test_missing_saved_host_key_does_not_rotate_host_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'wireguard.private').write_text('saved-wireguard-key')
            (root / 'node.token').write_text('saved-node-token')
            value = {'identity_fingerprint': 'existing', 'phase': 'complete'}
            with patch.object(worker, 'STATE', root), patch.object(worker, 'HOST_KEY', root / 'missing-host-key'), patch.object(worker, 'run') as command:
                with self.assertRaises(support.InstallError):
                    worker.identity(invitation(), value)
                command.assert_not_called()
                self.assertFalse((root / 'missing-host-key').exists())

    def test_firewall_is_scoped_and_does_not_flush_other_tables(self):
        text = worker.firewall_text('10.100.0.1', 'ens3')
        self.assertNotIn('flush ruleset', text)
        self.assertIn('delete table inet zt_worker_auto', text)
        self.assertIn('policy drop', text)
        self.assertIn('iifname "zt-worker" ip saddr 10.100.0.1 tcp dport 22 accept', text)
        with self.assertRaises(support.InstallError):
            worker.firewall_text('10.100.0.1', 'ens3";flush ruleset')


class TLSHandler(http.server.BaseHTTPRequestHandler):
    mode = 'success'
    invite = None
    seen = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        type(self).seen.append({
            'path': self.path,
            'token': self.headers.get('X-Enrollment-Token'),
            'cleanup_token': self.headers.get('X-Cleanup-Token'),
            'user_agent': self.headers.get('User-Agent'),
            'body': body,
        })
        if self.mode == 'redirect':
            self.send_response(302);self.send_header('Location', 'https://localhost:1/stolen');self.end_headers();return
        if self.mode == 'used':
            self.send_response(409);self.end_headers();return
        if self.path == '/api/offboarding/verify':
            resp = {
                'success': True,
                'operation_id': body.get('operation_id'),
                'gateway_id': body.get('gateway_id'),
                'node_id': body.get('node_id'),
                'node_name': 'test-node',
                'node_ip': body.get('node_ip'),
                'invitation_id': body.get('invitation_id'),
                'wireguard_public_key': body.get('wireguard_public_key'),
                'lifecycle_state': 'REVOKED',
            }
            raw = json.dumps(resp).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json');self.send_header('Content-Length', str(len(raw)));self.end_headers()
            self.wfile.write(raw)
            return
        if self.path == '/api/offboarding/complete':
            resp = {'success': True, 'operation_id': body.get('operation_id'), 'lifecycle_state': 'COMPLETED'}
            raw = json.dumps(resp).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json');self.send_header('Content-Length', str(len(raw)));self.end_headers()
            self.wfile.write(raw)
            return
        response = assignment(self.invite, self.mode != 'pending')
        raw = json.dumps(response).encode()
        self.send_response(202 if self.mode == 'pending' else 200)
        self.send_header('Content-Type', 'application/json');self.send_header('Content-Length', str(len(raw)));self.end_headers()
        self.wfile.write(raw)


@unittest.skipUnless(shutil.which('openssl'), 'Local TLS test requires openssl.')
class RealTLSTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.cert = cls.root / 'cert.pem';key = cls.root / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
                        '-keyout', str(key), '-out', str(cls.cert)], capture_output=True, check=True)
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), TLSHandler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cls.cert, key)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True);cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join();cls.temp.cleanup()

    def setUp(self):
        self.invite = invitation(f'https://localhost:{self.server.server_port}/api/enrollment/claim')
        self.payload = {'invitation_id': self.invite['invitation_id'], 'wireguard_public_key': self.invite['wireguard_public_key'],
                        'ssh_host_public_key': self.invite['bastion_public_key'], 'node_token': secrets.token_urlsafe(48)}
        TLSHandler.invite = self.invite;TLSHandler.seen = [];TLSHandler.mode = 'success'

    def test_real_https_accepts_explicit_ca_and_sends_separate_code_header(self):
        response = support.claim(self.invite, self.payload, self.cert)
        self.assertTrue(response['peer_ready'])
        self.assertEqual(TLSHandler.seen[0]['body'], self.payload)
        self.assertEqual(TLSHandler.seen[0]['token'], self.invite['join_token'])
        self.assertEqual(TLSHandler.seen[0]['user_agent'], 'ZT-ServerOps/1.0')
        self.assertNotIn('join_token', TLSHandler.seen[0]['body'])

    def test_real_https_offboarding_verify_and_complete_send_user_agent(self):
        origin = f'https://localhost:{self.server.server_port}'
        bundle = {
            'version': 1,
            'operation_id': 'op-123',
            'gateway_id': self.invite['gateway_id'],
            'node_id': 'node-456',
            'node_name': 'test-node',
            'node_ip': '10.100.0.5',
            'invitation_id': self.invite['invitation_id'],
            'wireguard_public_key': self.invite['wireguard_public_key'],
            'cleanup_token': 'cleanup-secret-token',
            'completion_url': f'{origin}/api/offboarding/complete',
        }
        verified = support.verify_offboarding(bundle, origin, self.cert)
        self.assertTrue(verified['success'])
        self.assertEqual(verified['lifecycle_state'], 'REVOKED')
        self.assertEqual(TLSHandler.seen[-1]['path'], '/api/offboarding/verify')
        self.assertEqual(TLSHandler.seen[-1]['cleanup_token'], 'cleanup-secret-token')
        self.assertEqual(TLSHandler.seen[-1]['user_agent'], 'ZT-ServerOps/1.0')

        receipt = {'operation_id': 'op-123', 'status': 'completed'}
        completed = support.post_offboarding_complete(bundle['completion_url'], bundle['cleanup_token'], receipt, self.cert)
        self.assertTrue(completed['success'])
        self.assertEqual(TLSHandler.seen[-1]['path'], '/api/offboarding/complete')
        self.assertEqual(TLSHandler.seen[-1]['cleanup_token'], 'cleanup-secret-token')
        self.assertEqual(TLSHandler.seen[-1]['user_agent'], 'ZT-ServerOps/1.0')

    def test_real_https_rejects_untrusted_certificate_without_leaking_token(self):
        with self.assertRaises(support.InstallError) as error:
            support.claim(self.invite, self.payload)
        self.assertNotIn(self.invite['join_token'], str(error.exception))
        self.assertNotIn(self.payload['node_token'], str(error.exception))
        self.assertEqual(TLSHandler.seen, [])

    def test_redirect_is_refused_before_sending_secret_to_another_url(self):
        TLSHandler.mode = 'redirect'
        with self.assertRaises(support.InstallError):
            support.claim(self.invite, self.payload, self.cert)
        self.assertEqual(len(TLSHandler.seen), 1)

    def test_pending_reply_is_distinct_and_reused_code_fails_safely(self):
        TLSHandler.mode = 'pending'
        self.assertFalse(support.claim(self.invite, self.payload, self.cert)['peer_ready'])
        TLSHandler.mode = 'used'
        with self.assertRaisesRegex(support.InstallError, 'different Worker identity'):
            support.claim(self.invite, self.payload, self.cert)


if __name__ == '__main__':
    unittest.main()
