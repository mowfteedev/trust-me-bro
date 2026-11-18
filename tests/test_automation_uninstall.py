"""Linux Worker offboarding and uninstall automation tests.
All tests run in isolated sandboxed temp directories with mock system commands.
NEVER execute install or uninstall mutations on the host system.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch
import urllib.error
import urllib.parse
import urllib.request
import uuid

AUTOMATION = Path(__file__).resolve().parents[1] / 'deploy/automation'
sys.path.insert(0, str(AUTOMATION))

import worker_support as support
import worker
import worker_uninstall


def sample_wireguard_key(byte_char: bytes = b'W') -> str:
    return base64.b64encode(byte_char * 32).decode()


def sample_state(root: Path, worker_wg_key: str) -> dict:
    gateway_wg_key = base64.b64encode(b'G' * 32).decode()
    gateway_id = 'sha256:' + hashlib.sha256(base64.b64decode(gateway_wg_key)).hexdigest()
    node_id = str(uuid.uuid4())
    invitation_id = str(uuid.uuid4())
    node_ip = '10.100.0.5'
    node_name = 'worker-test-01'
    reg_url = 'https://gateway.example.com:8443/api/enrollment/claim'

    assignment = {
        'version': 1,
        'status': 'READY',
        'peer_ready': True,
        'gateway_id': gateway_id,
        'invitation_id': invitation_id,
        'registration_url': reg_url,
        'node_name': node_name,
        'node_type': 'VM',
        'worker_os': 'linux',
        'ssh_username': 'ztuser',
        'gateway_vpn_ip': '10.100.0.1',
        'wireguard_endpoint': '192.0.2.10:51820',
        'wireguard_public_key': gateway_wg_key,
        'bastion_public_key': 'ssh-ed25519 ' + base64.b64encode(b'\x00' * 11 + b'ssh-ed25519\x00\x00\x00 ' + b'K' * 32).decode(),
        'node_id': node_id,
        'node_ip': node_ip,
        'gateway_api_url': 'http://10.100.0.1:3000',
        'verification': {'peer_applied': True, 'heartbeat_recent': True, 'ssh_authenticated': True},
    }

    state_data = {
        'version': 1,
        'kind': 'zt-worker-automation',
        'phase': 'complete',
        'invite_fingerprint': 'testfingerprint1234567890',
        'agent_sha256': hashlib.sha256(b'mini-agent-binary-data').hexdigest(),
        'gateway_id': gateway_id,
        'node_name': node_name,
        'worker_wireguard_public_key': worker_wg_key,
        'assignment': assignment,
        'managed': {},
        'original_services': {
            'ssh': {'active': True, 'enabled': True},
            'wg-quick@zt-worker': {'active': False, 'enabled': False},
            'zt-agent': {'active': False, 'enabled': False},
            'zt-worker-firewall': {'active': False, 'enabled': False},
        },
    }
    return state_data


def sample_bundle(state_data: dict, worker_wg_key: str, cleanup_token: str | None = None) -> dict:
    assignment = state_data['assignment']
    reg = urllib.parse.urlsplit(assignment['registration_url'])
    trusted_origin = f'{reg.scheme}://{reg.netloc}'
    return {
        'version': 1,
        'gateway_id': assignment['gateway_id'],
        'operation_id': str(uuid.uuid4()),
        'node_id': assignment['node_id'],
        'node_name': assignment['node_name'],
        'invitation_id': assignment['invitation_id'],
        'wireguard_public_key': worker_wg_key,
        'node_ip': assignment['node_ip'],
        'completion_url': f'{trusted_origin}/api/offboarding/complete',
        'cleanup_token': cleanup_token or ('e' * 64),
    }


def sample_verify_reply(bundle: dict, state: str = 'REVOKED', lifecycle: str = 'REVOKED') -> dict:
    return {
        'success': True,
        'operation_id': bundle['operation_id'],
        'gateway_id': bundle['gateway_id'],
        'node_id': bundle['node_id'],
        'node_name': bundle['node_name'],
        'node_ip': bundle['node_ip'],
        'invitation_id': bundle['invitation_id'],
        'wireguard_public_key': bundle['wireguard_public_key'],
        'state': state,
        'lifecycle_state': lifecycle,
    }


def sample_complete_reply(bundle: dict, status: str = 'COMPLETED') -> dict:
    return {
        'success': True,
        'operation_id': bundle['operation_id'],
        'node_id': bundle['node_id'],
        'state': status,
        'lifecycle_state': 'REMOVED',
    }


class MockHttpResponse:
    def __init__(self, data: dict, status: int = 200):
        self.raw = json.dumps(data).encode('utf-8')
        self.status = status

    def read(self, limit: int = 65537) -> bytes:
        return self.raw

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        pass


class AutomationUninstallTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

        self.state_dir = self.root / 'var/lib/zt-serverops/enrollment'
        self.state_dir.mkdir(parents=True, mode=0o700)
        (self.state_dir / 'backup').mkdir(mode=0o700)

        self.journal_file = self.state_dir / 'state.json'
        self.tunnel_file = self.root / 'etc/wireguard/zt-worker.conf'
        self.ssh_config_file = self.root / 'etc/ssh/sshd_config'
        self.ssh_public_file = self.root / 'etc/ssh/zt-worker/authorized_keys'
        self.ssh_unit_file = self.root / 'etc/systemd/system/ssh.service.d/zt-worker.conf'
        self.firewall_file = self.root / 'etc/zt-serverops/worker-firewall.nft'
        self.firewall_unit_file = self.root / 'etc/systemd/system/zt-worker-firewall.service'
        self.agent_env_file = self.root / 'opt/zt-serverops/agent/.env'
        self.agent_dir = self.root / 'opt/zt-serverops/agent'
        self.agent_bin_file = self.agent_dir / 'zt-agent'
        self.agent_unit_file = self.root / 'etc/systemd/system/zt-agent.service'
        self.host_key_file = self.root / 'etc/ssh/ssh_host_ed25519_key'

        for p in (self.tunnel_file, self.ssh_config_file, self.ssh_public_file,
                  self.ssh_unit_file, self.firewall_file, self.firewall_unit_file,
                  self.agent_bin_file, self.agent_unit_file, self.host_key_file):
            p.parent.mkdir(parents=True, mode=0o700, exist_ok=True)

        self.patches = [
            patch.object(worker, 'STATE', self.state_dir),
            patch.object(worker, 'JOURNAL', self.journal_file),
            patch.object(worker, 'TUNNEL', self.tunnel_file),
            patch.object(worker, 'SSH_CONFIG', self.ssh_config_file),
            patch.object(worker, 'SSH_PUBLIC', self.ssh_public_file),
            patch.object(worker, 'SSH_UNIT', self.ssh_unit_file),
            patch.object(worker, 'FIREWALL', self.firewall_file),
            patch.object(worker, 'FIREWALL_UNIT', self.firewall_unit_file),
            patch.object(worker, 'AGENT_ENV', self.agent_env_file),
            patch.object(worker, 'AGENT_DIR', self.agent_dir),
            patch.object(worker, 'AGENT_UNIT', self.agent_unit_file),
            patch.object(worker, 'HOST_KEY', self.host_key_file),
        ]
        for p in self.patches:
            p.start()

        self.worker_wg_key = sample_wireguard_key()
        self.state_data = sample_state(self.root, self.worker_wg_key)

        # Setup standard mock files
        self.host_key_file.write_text('host-key-fixture\n')
        self.host_key_file.chmod(0o600)
        (self.state_dir / 'wireguard.private').write_text('wg-private-key-fixture\n')
        (self.state_dir / 'wireguard.private').chmod(0o600)
        (self.state_dir / 'node.token').write_text('node-token-fixture\n')
        (self.state_dir / 'node.token').chmod(0o600)

        # Install mock managed files & records
        self._setup_managed_files()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp_dir.cleanup()

    def _setup_managed_files(self):
        files_to_install = {
            self.tunnel_file: ('[Interface]\nPrivateKey=test\n', 0o600, None),
            self.ssh_public_file: ('ssh-ed25519 AAAA...\n', 0o644, None),
            self.ssh_config_file: ('Port 22\nListenAddress 10.100.0.5\n', 0o600, 'Original SSH config\n'),
            self.ssh_unit_file: ('[Unit]\nWants=wg-quick@zt-worker.service\n', 0o644, None),
            self.firewall_file: ('table inet zt_worker_auto {}\n', 0o600, None),
            self.firewall_unit_file: ('[Unit]\nDescription=firewall\n', 0o644, None),
            self.agent_env_file: ('NODE_TOKEN=node-token-fixture\n', 0o600, None),
            self.agent_bin_file: ('dummy-binary', 0o755, None),
            self.agent_unit_file: ('[Unit]\nDescription=agent\n', 0o644, None),
        }

        for path, (content, mode, orig) in files_to_install.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            encoded = content.encode('utf-8')
            after_hash = hashlib.sha256(encoded).hexdigest()

            before_hash = None
            backup_file = None
            if orig is not None:
                orig_bytes = orig.encode('utf-8')
                before_hash = hashlib.sha256(orig_bytes).hexdigest()
                expected_filename = hashlib.sha256(str(path).encode()).hexdigest()
                backup_file = self.state_dir / 'backup' / expected_filename
                backup_file.write_bytes(orig_bytes)
                backup_file.chmod(0o600)

            path.write_bytes(encoded)
            path.chmod(mode)

            expected_backup_str = str(self.state_dir / 'backup' / hashlib.sha256(str(path).encode()).hexdigest())
            self.state_data['managed'][str(path)] = {
                'before_hash': before_hash,
                'after_hash': after_hash,
                'backup': expected_backup_str,
                'before_mode': 0o644 if orig is not None else None,
            }

        support.write_private(self.journal_file, self.state_data)

    def _write_auth_file(self, bundle: dict, mode: int = 0o600, filename: str = 'offboarding-bundle.json') -> Path:
        auth_file = self.root / filename
        auth_file.write_text(json.dumps(bundle, indent=2), encoding='utf-8')
        auth_file.chmod(mode)
        return auth_file

    # 1. Bundle validation tests
    def test_bundle_rejects_missing_keys_bad_types_and_invalid_formats(self):
        valid = sample_bundle(self.state_data, self.worker_wg_key)

        # Missing required key
        bad_missing = copy.deepcopy(valid)
        del bad_missing['cleanup_token']
        with self.assertRaises(support.InstallError):
            support.validate_offboarding_bundle(bad_missing, self.state_data['assignment'], self.worker_wg_key)

        # Extra key
        bad_extra = copy.deepcopy(valid)
        bad_extra['unexpected_key'] = 'malicious'
        with self.assertRaises(support.InstallError):
            support.validate_offboarding_bundle(bad_extra, self.state_data['assignment'], self.worker_wg_key)

        # Version boolean True (must be literal int 1)
        bad_ver = copy.deepcopy(valid)
        bad_ver['version'] = True
        with self.assertRaises(support.InstallError):
            support.validate_offboarding_bundle(bad_ver, self.state_data['assignment'], self.worker_wg_key)

        # Non-string node_name
        bad_type = copy.deepcopy(valid)
        bad_type['node_name'] = 12345
        with self.assertRaises(support.InstallError):
            support.validate_offboarding_bundle(bad_type, self.state_data['assignment'], self.worker_wg_key)

        # Invalid UUID
        bad_uuid = copy.deepcopy(valid)
        bad_uuid['operation_id'] = 'not-a-uuid'
        with self.assertRaises(support.InstallError):
            support.validate_offboarding_bundle(bad_uuid, self.state_data['assignment'], self.worker_wg_key)

        # Invalid IPv4
        bad_ip = copy.deepcopy(valid)
        bad_ip['node_ip'] = '999.999.999.999'
        with self.assertRaises(support.InstallError):
            support.validate_offboarding_bundle(bad_ip, self.state_data['assignment'], self.worker_wg_key)

        # All-zero WireGuard key
        bad_wg = copy.deepcopy(valid)
        bad_wg['wireguard_public_key'] = base64.b64encode(b'\x00' * 32).decode()
        with self.assertRaises(support.InstallError):
            support.validate_offboarding_bundle(bad_wg, self.state_data['assignment'], self.worker_wg_key)

        # Cleanup token wrong length
        bad_token = copy.deepcopy(valid)
        bad_token['cleanup_token'] = 'short'
        with self.assertRaises(support.InstallError):
            support.validate_offboarding_bundle(bad_token, self.state_data['assignment'], self.worker_wg_key)

        # Missing worker WG key must be rejected
        with self.assertRaises(support.InstallError):
            support.validate_offboarding_bundle(valid, self.state_data['assignment'], '')

    def test_bundle_file_permissions_and_symlink_rejection(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        auth_file = self._write_auth_file(bundle, mode=0o644)

        # Mode 0644 rejected
        with self.assertRaises(support.InstallError):
            support.read_private_auth_bundle(auth_file)

        # Symlink file rejected
        auth_file.chmod(0o600)
        link_file = self.root / 'link-auth.json'
        link_file.symlink_to(auth_file)
        with self.assertRaises(support.InstallError):
            support.read_private_auth_bundle(link_file)

    def test_bundle_mismatch_with_local_state_before_mutation(self):
        valid = sample_bundle(self.state_data, self.worker_wg_key)

        mismatches = [
            ('gateway_id', 'sha256:' + 'f' * 64),
            ('node_id', str(uuid.uuid4())),
            ('node_name', 'different-worker'),
            ('node_ip', '10.100.0.99'),
            ('invitation_id', str(uuid.uuid4())),
            ('wireguard_public_key', base64.b64encode(b'Z' * 32).decode()),
        ]

        for key, val in mismatches:
            bad = copy.deepcopy(valid)
            bad[key] = val
            with self.subTest(mismatched_key=key):
                auth_path = self._write_auth_file(bad)
                with self.assertRaises(support.InstallError):
                    worker_uninstall.execute_uninstall(auth_path)
                # Verify no mutations occurred
                self.assertTrue(self.tunnel_file.exists())
                self.assertTrue(self.agent_unit_file.exists())
                self.assertTrue((self.state_dir / 'wireguard.private').exists())

    def test_completion_url_must_match_trusted_origin_without_query_or_userinfo(self):
        valid = sample_bundle(self.state_data, self.worker_wg_key)
        bad_urls = [
            'http://gateway.example.com:8443/api/offboarding/complete',
            'https://other.example.com:8443/api/offboarding/complete',
            'https://user:pass@gateway.example.com:8443/api/offboarding/complete',
            'https://gateway.example.com:8443/api/offboarding/complete?token=leak',
            'https://gateway.example.com:8443/api/offboarding/complete#fragment',
            'https://gateway.example.com:8443/api/other/path',
        ]
        for url in bad_urls:
            bad = copy.deepcopy(valid)
            bad['completion_url'] = url
            with self.subTest(url=url):
                with self.assertRaises(support.InstallError):
                    support.validate_offboarding_bundle(bad, self.state_data['assignment'], self.worker_wg_key)

    # 2. Gateway verify & lifecycle state
    def test_gateway_verify_rejects_retiring_state_before_mutation(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        auth_file = self._write_auth_file(bundle)

        verify_reply = sample_verify_reply(bundle, state='RETIRING', lifecycle='RETIRING')
        mock_opener = MagicMock()
        mock_opener.open.return_value = MockHttpResponse(verify_reply, status=200)

        with patch('urllib.request.build_opener', return_value=mock_opener):
            with self.assertRaisesRegex(support.InstallError, 'RETIRING'):
                worker_uninstall.execute_uninstall(auth_file)

        # Verify no files were deleted or mutated
        self.assertTrue(self.tunnel_file.exists())
        self.assertTrue(self.firewall_file.exists())
        self.assertTrue((self.state_dir / 'wireguard.private').exists())

    def test_gateway_verify_rejects_mismatched_gateway_id(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        auth_file = self._write_auth_file(bundle)

        verify_reply = sample_verify_reply(bundle)
        verify_reply['gateway_id'] = 'sha256:' + '9' * 64

        mock_opener = MagicMock()
        mock_opener.open.return_value = MockHttpResponse(verify_reply, status=200)

        with patch('urllib.request.build_opener', return_value=mock_opener):
            with self.assertRaisesRegex(support.InstallError, 'mismatched gateway_id'):
                worker_uninstall.execute_uninstall(auth_file)

    # 3. Preflight detects outside edits and missing backups
    def test_preflight_detects_outside_edits_and_preserves_user_changes(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        auth_file = self._write_auth_file(bundle)

        # User modified sshd_config after install
        self.ssh_config_file.write_text('Custom operator SSH modification\n')

        verify_reply = sample_verify_reply(bundle)
        complete_reply = sample_complete_reply(bundle, status='NEEDS_REVIEW')

        sent_payloads = []
        def fake_open(request, timeout=15):
            body = json.loads(request.data.decode('utf-8'))
            sent_payloads.append(body)
            if 'status' in body:
                return MockHttpResponse(complete_reply, status=200)
            return MockHttpResponse(verify_reply, status=200)

        mock_opener = MagicMock()
        mock_opener.open.side_effect = fake_open

        observed_ssh = subprocess.CompletedProcess(
            [], 0, b'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n', b'')

        with patch('urllib.request.build_opener', return_value=mock_opener), \
             patch.object(worker, 'run', return_value=b''), \
             patch.object(worker.subprocess, 'run', return_value=observed_ssh), \
             patch.object(worker, 'active', return_value=False):
            result = worker_uninstall.execute_uninstall(auth_file)

        # Status must be NEEDS_REVIEW because ssh was customized
        self.assertFalse(result['ok'])
        self.assertEqual(result['status'], 'NEEDS_REVIEW')
        self.assertEqual(result['receipt']['steps']['ssh'], 'REVIEW')
        self.assertEqual(result['receipt']['steps']['agent'], 'DONE')

        # User modification preserved! Not overwritten by backup
        self.assertEqual(self.ssh_config_file.read_text(), 'Custom operator SSH modification\n')

    def test_preflight_detects_missing_backup(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        auth_file = self._write_auth_file(bundle)

        # Delete backup of sshd_config
        backup = Path(self.state_data['managed'][str(self.ssh_config_file)]['backup'])
        backup.unlink()

        verify_reply = sample_verify_reply(bundle)
        complete_reply = sample_complete_reply(bundle, status='NEEDS_REVIEW')

        mock_opener = MagicMock()
        mock_opener.open.side_effect = lambda req, timeout=15: MockHttpResponse(
            complete_reply if b'status' in req.data else verify_reply, status=200)

        observed_ssh = subprocess.CompletedProcess(
            [], 0, b'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n', b'')

        with patch('urllib.request.build_opener', return_value=mock_opener), \
             patch.object(worker, 'run', return_value=b''), \
             patch.object(worker.subprocess, 'run', return_value=observed_ssh), \
             patch.object(worker, 'active', return_value=False):
            result = worker_uninstall.execute_uninstall(auth_file)

        self.assertFalse(result['ok'])
        self.assertEqual(result['status'], 'NEEDS_REVIEW')
        self.assertEqual(result['receipt']['steps']['ssh'], 'REVIEW')

    def test_backup_path_validation_rejects_arbitrary_journal_paths(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        auth_file = self._write_auth_file(bundle)

        # Tamper backup path in journal to point outside STATE/backup
        self.state_data['managed'][str(self.ssh_config_file)]['backup'] = '/etc/shadow'
        support.write_private(self.journal_file, self.state_data)

        verify_reply = sample_verify_reply(bundle)
        complete_reply = sample_complete_reply(bundle, status='NEEDS_REVIEW')

        mock_opener = MagicMock()
        mock_opener.open.side_effect = lambda req, timeout=15: MockHttpResponse(
            complete_reply if b'status' in req.data else verify_reply, status=200)

        observed_ssh = subprocess.CompletedProcess(
            [], 0, b'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n', b'')

        with patch('urllib.request.build_opener', return_value=mock_opener), \
             patch.object(worker, 'run', return_value=b''), \
             patch.object(worker.subprocess, 'run', return_value=observed_ssh), \
             patch.object(worker, 'active', return_value=False):
            result = worker_uninstall.execute_uninstall(auth_file)

        self.assertFalse(result['ok'])
        self.assertEqual(result['receipt']['steps']['ssh'], 'REVIEW')

    # 4. Successful full uninstall & directory cleanup (Bug 1 regression)
    def test_successful_full_uninstall_and_rmdir_allows_reinstall(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        auth_file = self._write_auth_file(bundle)

        verify_reply = sample_verify_reply(bundle)
        complete_reply = sample_complete_reply(bundle, status='COMPLETED')

        sent_requests = []
        def fake_open(request, timeout=15):
            sent_requests.append({
                'url': request.full_url,
                'headers': dict(request.headers),
                'body': json.loads(request.data.decode('utf-8')),
            })
            if 'status' in sent_requests[-1]['body']:
                return MockHttpResponse(complete_reply, status=200)
            return MockHttpResponse(verify_reply, status=200)

        mock_opener = MagicMock()
        mock_opener.open.side_effect = fake_open

        observed_ssh = subprocess.CompletedProcess(
            [], 0, b'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n', b'')

        with patch('urllib.request.build_opener', return_value=mock_opener), \
             patch.object(worker, 'run', return_value=b''), \
             patch.object(worker.subprocess, 'run', return_value=observed_ssh), \
             patch.object(worker, 'active', return_value=False):
            result = worker_uninstall.execute_uninstall(auth_file)

        self.assertTrue(result['ok'])
        self.assertEqual(result['status'], 'COMPLETE')
        self.assertTrue(result['gateway_acknowledged'])
        for step, outcome in result['receipt']['steps'].items():
            self.assertEqual(outcome, 'DONE')

        # Verify files removed
        self.assertFalse(self.tunnel_file.exists())
        self.assertFalse(self.firewall_file.exists())
        self.assertFalse(self.firewall_unit_file.exists())
        self.assertFalse(self.ssh_public_file.exists())
        self.assertFalse(self.ssh_unit_file.exists())
        self.assertFalse(self.agent_unit_file.exists())
        self.assertFalse(self.agent_bin_file.exists())
        self.assertFalse(self.agent_env_file.exists())
        self.assertFalse((self.state_dir / 'wireguard.private').exists())
        self.assertFalse((self.state_dir / 'node.token').exists())

        # Verify empty owned directories were safely removed (Bug 1)
        self.assertFalse(self.agent_dir.exists())
        self.assertFalse(self.ssh_public_file.parent.exists())

        # Verify capability was wiped on Ack
        self.assertFalse((self.state_dir / 'cleanup.capability').exists())

        # Verify repeat install preflight succeeds now that AGENT_DIR is gone!
        new_invite = {
            'version': 1, 'gateway_id': self.state_data['gateway_id'],
            'registration_url': self.state_data['assignment']['registration_url'],
            'wireguard_endpoint': '192.0.2.10:51820',
            'wireguard_public_key': self.state_data['assignment']['wireguard_public_key'],
            'gateway_vpn_ip': '10.100.0.1',
            'bastion_public_key': self.state_data['assignment']['bastion_public_key'],
            'invitation_id': str(uuid.uuid4()),
            'join_token': 'f' * 48,
            'expires_at': '2099-01-01T00:00:00Z',
            'node_name': 'worker-test-01',
            'node_type': 'VM',
            'worker_os': 'linux',
            'ssh_username': 'ztuser',
        }
        with patch.object(worker, 'state', return_value=None), \
             patch.object(worker, 'check_binary', return_value=self.state_data['agent_sha256']), \
             patch('shutil.which', return_value='/usr/bin/tool'), \
             patch('pwd.getpwnam', side_effect=KeyError):
            # Preflight must NOT reject due to existing owned files/dirs
            p = worker.preflight(new_invite, self.root / 'dummy', self.state_data['agent_sha256'])
            self.assertNotIn('Existing Worker configuration has no automation ownership state', ' '.join(p['issues']))

    # 5. Pre-existing files restored from backup instead of deleted (Bug 5 regression)
    def test_original_preexisting_files_are_restored_from_backup(self):
        # Suppose agent_unit and ssh_public were pre-existing before install
        orig_unit = '[Unit]\nDescription=Preexisting\n'
        orig_unit_hash = hashlib.sha256(orig_unit.encode()).hexdigest()
        backup_unit = self.state_dir / 'backup' / hashlib.sha256(str(self.agent_unit_file).encode()).hexdigest()
        backup_unit.write_bytes(orig_unit.encode())
        backup_unit.chmod(0o600)

        self.state_data['managed'][str(self.agent_unit_file)]['before_hash'] = orig_unit_hash
        self.state_data['managed'][str(self.agent_unit_file)]['before_mode'] = 0o644
        self.state_data['managed'][str(self.agent_unit_file)]['backup'] = str(backup_unit)
        support.write_private(self.journal_file, self.state_data)

        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        auth_file = self._write_auth_file(bundle)

        verify_reply = sample_verify_reply(bundle)
        complete_reply = sample_complete_reply(bundle, status='COMPLETED')

        mock_opener = MagicMock()
        mock_opener.open.side_effect = lambda req, timeout=15: MockHttpResponse(
            complete_reply if b'status' in req.data else verify_reply, status=200)

        observed_ssh = subprocess.CompletedProcess(
            [], 0, b'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n', b'')

        with patch('urllib.request.build_opener', return_value=mock_opener), \
             patch.object(worker, 'run', return_value=b''), \
             patch.object(worker.subprocess, 'run', return_value=observed_ssh), \
             patch.object(worker, 'active', return_value=False):
            result = worker_uninstall.execute_uninstall(auth_file)

        self.assertTrue(result['ok'])
        # Pre-existing agent_unit_file was restored from backup, NOT deleted!
        self.assertTrue(self.agent_unit_file.exists())
        self.assertEqual(self.agent_unit_file.read_text(), orig_unit)

    # 6. Crash in progress and step-by-step resume (Bug 2 regression)
    def test_resume_in_progress_after_crash_checkpoints_each_step(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        auth_file = self._write_auth_file(bundle)

        # Simulate a crash after 'agent' step finished
        cleanup_file = self.state_dir / 'cleanup.json'
        cap_file = self.state_dir / 'cleanup.capability'
        support.write_private(cap_file, bundle['cleanup_token'] + '\n')

        crashed_journal = {
            'version': 1,
            'kind': 'zt-worker-cleanup',
            'created_at': 1700000000,
            'updated_at': 1700000000,
            'operation_id': bundle['operation_id'],
            'node_id': bundle['node_id'],
            'node_name': bundle['node_name'],
            'node_ip': bundle['node_ip'],
            'gateway_id': bundle['gateway_id'],
            'invitation_id': bundle['invitation_id'],
            'wireguard_public_key': bundle['wireguard_public_key'],
            'completion_url': bundle['completion_url'],
            'registration_url': self.state_data['assignment']['registration_url'],
            'status': 'IN_PROGRESS',
            'steps': {'agent': 'DONE'},
            'gateway_acknowledged': False,
        }
        support.write_private(cleanup_file, crashed_journal)

        verify_reply = sample_verify_reply(bundle)
        complete_reply = sample_complete_reply(bundle, status='COMPLETED')

        mock_opener = MagicMock()
        mock_opener.open.side_effect = lambda req, timeout=15: MockHttpResponse(
            complete_reply if b'status' in req.data else verify_reply, status=200)

        observed_ssh = subprocess.CompletedProcess(
            [], 0, b'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n', b'')

        with patch('urllib.request.build_opener', return_value=mock_opener), \
             patch.object(worker, 'run', return_value=b''), \
             patch.object(worker.subprocess, 'run', return_value=observed_ssh), \
             patch.object(worker, 'active', return_value=False):
            res = worker_uninstall.execute_cleanup_retry()

        self.assertTrue(res['ok'])
        self.assertEqual(res['status'], 'COMPLETE')
        # All 5 steps now completed
        for s in ('agent', 'tunnel', 'firewall', 'ssh', 'secrets'):
            self.assertEqual(res['receipt']['steps'][s], 'DONE')

    # 7. Missing local worker WG key fails closed (Bug 2 & 6 regression)
    def test_missing_local_worker_wg_key_fails_closed(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        auth_file = self._write_auth_file(bundle)

        # Delete local keys and state field
        del self.state_data['worker_wireguard_public_key']
        support.write_private(self.journal_file, self.state_data)
        (self.state_dir / 'wireguard.private').unlink()

        with self.assertRaisesRegex(support.InstallError, 'Cannot determine local Worker WireGuard public key'):
            worker_uninstall.execute_uninstall(auth_file)

    # 8. Ordering of ack write and capability wipe (Bug 3 regression)
    def test_cap_unlink_after_durable_ack_and_terminal_recovery(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)

        # Simulate state where cleanup.json has gateway_acknowledged=True and COMPLETE,
        # but state.json was still in 'enrolled' due to crash before phase update
        cleanup_file = self.state_dir / 'cleanup.json'
        cap_file = self.state_dir / 'cleanup.capability'
        support.write_private(cap_file, bundle['cleanup_token'] + '\n')

        cleanup_data = {
            'version': 1,
            'kind': 'zt-worker-cleanup',
            'operation_id': bundle['operation_id'],
            'node_id': bundle['node_id'],
            'node_name': bundle['node_name'],
            'node_ip': bundle['node_ip'],
            'gateway_id': bundle['gateway_id'],
            'invitation_id': bundle['invitation_id'],
            'wireguard_public_key': bundle['wireguard_public_key'],
            'completion_url': bundle['completion_url'],
            'status': 'COMPLETE',
            'steps': {'agent': 'DONE', 'tunnel': 'DONE', 'firewall': 'DONE', 'ssh': 'DONE', 'secrets': 'DONE'},
            'receipt': {
                'platform': 'linux',
                'steps': {'agent': 'DONE', 'tunnel': 'DONE', 'firewall': 'DONE', 'ssh': 'DONE', 'secrets': 'DONE'},
                'evidence_digest': 'c' * 64,
            },
            'gateway_acknowledged': True,
        }
        support.write_private(cleanup_file, cleanup_data)

        # Retry recovery must finish terminalization on state.json and wipe cap_file
        res = worker_uninstall.execute_cleanup_retry()
        self.assertTrue(res['ok'])
        self.assertTrue(res['already_completed'])
        self.assertEqual(worker.state()['phase'], 'uninstalled')
        self.assertFalse(cap_file.exists())

    # 9. Repeat uninstall on completed same operation (Bug 4 regression)
    def test_repeat_uninstall_on_completed_same_operation_returns_existing_complete(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        auth_file = self._write_auth_file(bundle)

        verify_reply = sample_verify_reply(bundle)
        complete_reply = sample_complete_reply(bundle, status='COMPLETED')

        mock_opener = MagicMock()
        mock_opener.open.side_effect = lambda req, timeout=15: MockHttpResponse(
            complete_reply if b'status' in req.data else verify_reply, status=200)

        observed_ssh = subprocess.CompletedProcess(
            [], 0, b'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n', b'')

        with patch('urllib.request.build_opener', return_value=mock_opener), \
             patch.object(worker, 'run', return_value=b''), \
             patch.object(worker.subprocess, 'run', return_value=observed_ssh), \
             patch.object(worker, 'active', return_value=False):
            res1 = worker_uninstall.execute_uninstall(auth_file)
            self.assertTrue(res1['ok'])

            # Repeat uninstall with same authorization bundle
            res2 = worker_uninstall.execute_uninstall(auth_file)
            self.assertTrue(res2['ok'])
            self.assertTrue(res2['already_completed'])
            self.assertEqual(res2['receipt'], res1['receipt'])

    # 10. Old authorization on new installation (Bug 4 regression)
    def test_old_authorization_on_new_installation_refuses_without_mutation(self):
        old_bundle = sample_bundle(self.state_data, self.worker_wg_key)
        old_auth_file = self._write_auth_file(old_bundle)

        # Create new installation with different node_id and invitation_id
        new_state = sample_state(self.root, sample_wireguard_key(b'Z'))
        new_state['assignment']['node_id'] = str(uuid.uuid4())
        new_state['assignment']['invitation_id'] = str(uuid.uuid4())
        support.write_private(self.journal_file, new_state)

        with self.assertRaises(support.InstallError):
            worker_uninstall.execute_uninstall(old_auth_file)

    # 11. SSH inactive/disabled state verification (Bug 7 regression)
    def test_cleanup_ssh_verifies_inactive_and_disabled_states(self):
        # Set original_services ssh to inactive and disabled
        self.state_data['original_services']['ssh'] = {'active': False, 'enabled': False}
        support.write_private(self.journal_file, self.state_data)

        plan = worker_uninstall.preflight_uninstall(self.state_data)

        # If systemctl reports ssh is active when it should be inactive -> REVIEW
        observed_active = subprocess.CompletedProcess(
            [], 0, b'LoadState=loaded\nActiveState=active\nUnitFileState=disabled\n', b'')
        with patch.object(worker, 'run', return_value=b''), \
             patch.object(worker.subprocess, 'run', return_value=observed_active):
            self.assertEqual(worker_uninstall.cleanup_ssh(plan), 'REVIEW')

        # If systemctl reports ssh is disabled and inactive as expected -> DONE
        observed_inactive = subprocess.CompletedProcess(
            [], 0, b'LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\n', b'')
        with patch.object(worker, 'run', return_value=b''), \
             patch.object(worker.subprocess, 'run', return_value=observed_inactive):
            self.assertEqual(worker_uninstall.cleanup_ssh(plan), 'DONE')

    # 12. CLI console & root restrictions
    def test_cli_console_and_root_restrictions(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        auth_file = self._write_auth_file(bundle)

        args = MagicMock()
        args.authorization = auth_file
        args.ca_file = None

        with patch('os.geteuid', return_value=1000):
            with self.assertRaisesRegex(support.InstallError, 'root at the dedicated Worker console'):
                worker.uninstall(args)
            with self.assertRaisesRegex(support.InstallError, 'root at the dedicated Worker console'):
                worker.cleanup_retry(args)

        with patch('os.geteuid', return_value=0), patch.dict('os.environ', {'SSH_CONNECTION': '192.0.2.1 54321 192.0.2.10 22'}):
            with self.assertRaisesRegex(support.InstallError, 'do not run uninstall through SSH'):
                worker.uninstall(args)
            with self.assertRaisesRegex(support.InstallError, 'do not run cleanup retry through SSH'):
                worker.cleanup_retry(args)

    # 13. Receipt stability and lost network retry
    def test_receipt_stability_and_lost_network_retry_after_key_wipe(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        auth_file = self._write_auth_file(bundle)

        verify_reply = sample_verify_reply(bundle)
        complete_reply = sample_complete_reply(bundle, status='COMPLETED')

        def fake_network_fail(request, timeout=15):
            if b'status' in request.data:
                raise urllib.error.URLError('Connection lost')
            return MockHttpResponse(verify_reply, status=200)

        mock_opener_fail = MagicMock()
        mock_opener_fail.open.side_effect = fake_network_fail

        observed_ssh = subprocess.CompletedProcess(
            [], 0, b'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n', b'')

        with patch('urllib.request.build_opener', return_value=mock_opener_fail), \
             patch.object(worker, 'run', return_value=b''), \
             patch.object(worker.subprocess, 'run', return_value=observed_ssh), \
             patch.object(worker, 'active', return_value=False):
            with self.assertRaises(support.InstallError):
                worker_uninstall.execute_uninstall(auth_file)

        # Keys were already wiped during secrets cleanup
        self.assertFalse((self.state_dir / 'wireguard.private').exists())
        self.assertFalse((self.state_dir / 'node.token').exists())

        cleanup_data = json.loads((self.state_dir / 'cleanup.json').read_text())
        original_digest = cleanup_data['receipt']['evidence_digest']
        self.assertTrue((self.state_dir / 'cleanup.capability').exists())

        sent_on_retry = []
        def fake_retry_open(request, timeout=15):
            body = json.loads(request.data.decode('utf-8'))
            sent_on_retry.append(body)
            if 'status' in body:
                return MockHttpResponse(complete_reply, status=200)
            return MockHttpResponse(verify_reply, status=200)

        mock_opener_retry = MagicMock()
        mock_opener_retry.open.side_effect = fake_retry_open

        with patch('urllib.request.build_opener', return_value=mock_opener_retry), \
             patch.object(worker, 'run', return_value=b''), \
             patch.object(worker.subprocess, 'run', return_value=observed_ssh), \
             patch.object(worker, 'active', return_value=False):
            retry_res = worker_uninstall.execute_cleanup_retry()

        self.assertTrue(retry_res['ok'])
        # Receipt stability: digest sent on retry is identical to original digest
        self.assertEqual(sent_on_retry[-1]['receipt']['evidence_digest'], original_digest)
        self.assertEqual(retry_res['receipt']['evidence_digest'], original_digest)
        self.assertFalse((self.state_dir / 'cleanup.capability').exists())

    # 14. Server accepted + lost response & replay: verify would return REMOVED, replay succeeds
    def test_server_accepted_lost_response_replay_without_verify(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        complete_reply = sample_complete_reply(bundle, status='COMPLETED')
        complete_reply['replayed'] = True

        steps = {'agent': 'DONE', 'tunnel': 'DONE', 'firewall': 'DONE', 'ssh': 'DONE', 'secrets': 'DONE'}
        receipt = worker_uninstall.build_receipt(steps, bundle)

        cleanup_journal = {
            'version': 1,
            'kind': 'zt-worker-cleanup',
            'created_at': int(time.time()),
            'updated_at': int(time.time()),
            'operation_id': bundle['operation_id'],
            'node_id': bundle['node_id'],
            'node_name': bundle['node_name'],
            'node_ip': bundle['node_ip'],
            'gateway_id': bundle['gateway_id'],
            'invitation_id': bundle['invitation_id'],
            'wireguard_public_key': bundle['wireguard_public_key'],
            'completion_url': bundle['completion_url'],
            'registration_url': self.state_data['assignment']['registration_url'],
            'status': 'COMPLETE',
            'steps': steps,
            'receipt': receipt,
            'gateway_acknowledged': False,
        }
        support.write_private(self.state_dir / 'cleanup.json', cleanup_journal)
        support.write_private(self.state_dir / 'cleanup.capability', bundle['cleanup_token'] + '\n')

        verify_calls = []
        complete_calls = []

        def mock_open(request, timeout=15):
            url = request.full_url
            if '/api/offboarding/verify' in url:
                verify_calls.append(url)
                removed_reply = sample_verify_reply(bundle, state='COMPLETED', lifecycle='REMOVED')
                return MockHttpResponse(removed_reply, status=200)
            elif '/api/offboarding/complete' in url:
                complete_calls.append(url)
                return MockHttpResponse(complete_reply, status=200)
            raise AssertionError(f'Unexpected URL: {url}')

        mock_opener = MagicMock()
        mock_opener.open.side_effect = mock_open

        with patch('urllib.request.build_opener', return_value=mock_opener):
            res = worker_uninstall.execute_cleanup_retry()

        self.assertTrue(res['ok'])
        self.assertEqual(res['status'], 'COMPLETE')
        self.assertEqual(len(verify_calls), 0)
        self.assertEqual(len(complete_calls), 1)
        self.assertEqual(res['receipt']['evidence_digest'], receipt['evidence_digest'])

        self.assertFalse((self.state_dir / 'cleanup.capability').exists())
        state_data = json.loads(self.journal_file.read_text())
        self.assertEqual(state_data.get('phase'), 'uninstalled')
        self.assertEqual(state_data.get('uninstalled_status'), 'COMPLETE')
        cleanup_data = json.loads((self.state_dir / 'cleanup.json').read_text())
        self.assertTrue(cleanup_data['gateway_acknowledged'])

    # 15. Rotated capability recovery from CLI
    def test_rotated_capability_recovery_from_cli(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        new_token = 'b' * 64
        rotated_bundle = dict(bundle)
        rotated_bundle['cleanup_token'] = new_token
        rotated_auth_file = self._write_auth_file(rotated_bundle)

        cleanup_journal = {
            'version': 1,
            'kind': 'zt-worker-cleanup',
            'created_at': int(time.time()),
            'updated_at': int(time.time()),
            'operation_id': bundle['operation_id'],
            'node_id': bundle['node_id'],
            'node_name': bundle['node_name'],
            'node_ip': bundle['node_ip'],
            'gateway_id': bundle['gateway_id'],
            'invitation_id': bundle['invitation_id'],
            'wireguard_public_key': bundle['wireguard_public_key'],
            'completion_url': bundle['completion_url'],
            'registration_url': self.state_data['assignment']['registration_url'],
            'status': 'IN_PROGRESS',
            'steps': {},
            'gateway_acknowledged': False,
        }
        support.write_private(self.state_dir / 'cleanup.json', cleanup_journal)
        support.write_private(self.state_dir / 'cleanup.capability', ('0' * 64) + '\n')

        # Negative test: mismatched node_id rejects before rotating capability
        mismatched_bundle = dict(rotated_bundle)
        mismatched_bundle['node_id'] = str(uuid.uuid4())
        bad_auth_file = self._write_auth_file(mismatched_bundle, filename='bad-bundle.json')
        with self.assertRaises(support.InstallError):
            worker_uninstall.execute_cleanup_retry(bad_auth_file)
        self.assertEqual((self.state_dir / 'cleanup.capability').read_text().strip(), '0' * 64)

        # Positive test: valid rotated bundle updates cap_file and succeeds
        tokens_received = []
        def mock_open(request, timeout=15):
            token_hdr = request.headers.get('X-cleanup-token') or request.headers.get('X-Cleanup-Token')
            tokens_received.append(token_hdr)
            url = request.full_url
            if '/api/offboarding/verify' in url:
                return MockHttpResponse(sample_verify_reply(bundle), status=200)
            elif '/api/offboarding/complete' in url:
                return MockHttpResponse(sample_complete_reply(bundle), status=200)
            raise AssertionError(f'Unexpected URL: {url}')

        mock_opener = MagicMock()
        mock_opener.open.side_effect = mock_open

        observed_ssh = subprocess.CompletedProcess(
            [], 0, b'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n', b'')

        with patch('urllib.request.build_opener', return_value=mock_opener), \
             patch.object(worker, 'run', return_value=b''), \
             patch.object(worker.subprocess, 'run', return_value=observed_ssh), \
             patch.object(worker, 'active', return_value=False):
            res = worker_uninstall.execute_cleanup_retry(rotated_auth_file)

        self.assertTrue(res['ok'])
        self.assertIn(new_token, tokens_received)

    # 16. Foreign completion URL rejected with no HTTP and no local mutation
    def test_foreign_completion_url_refused_no_http_or_mutation(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        cleanup_journal = {
            'version': 1,
            'kind': 'zt-worker-cleanup',
            'created_at': int(time.time()),
            'updated_at': int(time.time()),
            'operation_id': bundle['operation_id'],
            'node_id': bundle['node_id'],
            'node_name': bundle['node_name'],
            'node_ip': bundle['node_ip'],
            'gateway_id': bundle['gateway_id'],
            'invitation_id': bundle['invitation_id'],
            'wireguard_public_key': bundle['wireguard_public_key'],
            'completion_url': 'https://evil.attacker.example.com/api/offboarding/complete',
            'registration_url': self.state_data['assignment']['registration_url'],
            'status': 'IN_PROGRESS',
            'steps': {},
            'gateway_acknowledged': False,
        }
        support.write_private(self.state_dir / 'cleanup.json', cleanup_journal)
        support.write_private(self.state_dir / 'cleanup.capability', bundle['cleanup_token'] + '\n')

        self.assertTrue(self.tunnel_file.exists())

        mock_opener = MagicMock()
        mock_opener.open.side_effect = AssertionError('No HTTP request should be made!')

        with patch('urllib.request.build_opener', return_value=mock_opener):
            with self.assertRaisesRegex(support.InstallError, 'completion_url'):
                worker_uninstall.execute_cleanup_retry()

        self.assertTrue(self.tunnel_file.exists())
        self.assertTrue((self.state_dir / 'cleanup.capability').exists())

    # 17. Interrupted same operation journal preserved by execute_uninstall
    def test_interrupted_same_operation_journal_preserved_by_execute_uninstall(self):
        bundle = sample_bundle(self.state_data, self.worker_wg_key)
        auth_file = self._write_auth_file(bundle)

        cleanup_journal = {
            'version': 1,
            'kind': 'zt-worker-cleanup',
            'created_at': int(time.time()),
            'updated_at': int(time.time()),
            'operation_id': bundle['operation_id'],
            'node_id': bundle['node_id'],
            'node_name': bundle['node_name'],
            'node_ip': bundle['node_ip'],
            'gateway_id': bundle['gateway_id'],
            'invitation_id': bundle['invitation_id'],
            'wireguard_public_key': bundle['wireguard_public_key'],
            'completion_url': bundle['completion_url'],
            'registration_url': self.state_data['assignment']['registration_url'],
            'status': 'IN_PROGRESS',
            'steps': {'agent': 'DONE'},
            'gateway_acknowledged': False,
        }
        support.write_private(self.state_dir / 'cleanup.json', cleanup_journal)
        support.write_private(self.state_dir / 'cleanup.capability', bundle['cleanup_token'] + '\n')

        verify_reply = sample_verify_reply(bundle)
        complete_reply = sample_complete_reply(bundle)

        mock_opener = MagicMock()
        def mock_open(request, timeout=15):
            url = request.full_url
            if '/api/offboarding/verify' in url:
                return MockHttpResponse(verify_reply, status=200)
            elif '/api/offboarding/complete' in url:
                return MockHttpResponse(complete_reply, status=200)
            raise AssertionError(f'Unexpected URL: {url}')
        mock_opener.open.side_effect = mock_open

        observed_ssh = subprocess.CompletedProcess(
            [], 0, b'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n', b'')

        with patch('urllib.request.build_opener', return_value=mock_opener), \
             patch.object(worker, 'run', return_value=b''), \
             patch.object(worker.subprocess, 'run', return_value=observed_ssh), \
             patch.object(worker, 'active', return_value=False):
            res = worker_uninstall.execute_uninstall(auth_file)

        self.assertTrue(res['ok'])
        self.assertEqual(res['receipt']['steps']['agent'], 'DONE')
        self.assertEqual(res['receipt']['steps']['tunnel'], 'DONE')
        self.assertEqual(res['receipt']['steps']['secrets'], 'DONE')

    # 18. New install refuses old authorization without mutation
    def test_new_install_refuses_old_authorization_without_mutation(self):
        old_bundle = sample_bundle(self.state_data, self.worker_wg_key)
        old_auth_file = self._write_auth_file(old_bundle)

        old_cleanup = {
            'version': 1,
            'kind': 'zt-worker-cleanup',
            'created_at': int(time.time()),
            'updated_at': int(time.time()),
            'operation_id': old_bundle['operation_id'],
            'node_id': old_bundle['node_id'],
            'node_name': old_bundle['node_name'],
            'node_ip': old_bundle['node_ip'],
            'gateway_id': old_bundle['gateway_id'],
            'invitation_id': old_bundle['invitation_id'],
            'wireguard_public_key': old_bundle['wireguard_public_key'],
            'completion_url': old_bundle['completion_url'],
            'registration_url': self.state_data['assignment']['registration_url'],
            'status': 'COMPLETE',
            'steps': {'agent': 'DONE', 'tunnel': 'DONE', 'firewall': 'DONE', 'ssh': 'DONE', 'secrets': 'DONE'},
            'receipt': {'platform': 'linux', 'steps': {}, 'evidence_digest': 'f' * 64},
            'gateway_acknowledged': True,
        }
        support.write_private(self.state_dir / 'cleanup.json', old_cleanup)

        # New installation in state.json
        new_state = dict(self.state_data)
        new_state['assignment'] = dict(self.state_data['assignment'])
        new_state['assignment']['node_id'] = str(uuid.uuid4())
        new_state['assignment']['invitation_id'] = str(uuid.uuid4())
        new_state['phase'] = 'installed'
        worker.save(new_state)

        with self.assertRaisesRegex(support.InstallError, 'previous installation'):
            worker_uninstall.execute_uninstall(old_auth_file)

        self.assertEqual(worker.state()['phase'], 'installed')

        with self.assertRaisesRegex(support.InstallError, 'previous installation'):
            worker_uninstall.execute_cleanup_retry(old_auth_file)

        self.assertEqual(worker.state()['phase'], 'installed')

    # 19. Atomic backup restore preserves mode and cleans temp files
    def test_restore_from_backup_is_atomic_and_preserves_mode(self):
        orig_content = b'# Custom sshd config\nPort 2222\n'
        orig_hash = hashlib.sha256(orig_content).hexdigest()
        backup_file = self.state_dir / 'backup' / hashlib.sha256(str(self.ssh_config_file).encode()).hexdigest()
        backup_file.write_bytes(orig_content)
        backup_file.chmod(0o600)

        preflight = {
            'conflicts': {},
            'managed': {
                str(self.ssh_config_file): {
                    'before_hash': orig_hash,
                    'before_mode': 0o640,
                    'backup': str(backup_file),
                }
            }
        }
        self.ssh_config_file.write_bytes(b'# Installed content\n')
        self.ssh_config_file.chmod(0o600)

        ok = worker_uninstall.restore_or_remove_managed_file(self.ssh_config_file, preflight)
        self.assertTrue(ok)
        self.assertEqual(self.ssh_config_file.read_bytes(), orig_content)
        self.assertEqual(self.ssh_config_file.stat().st_mode & 0o777, 0o640)

        temp_files = list(self.ssh_config_file.parent.glob('.tmp-restore-*'))
        self.assertEqual(temp_files, [])


if __name__ == '__main__':
    unittest.main()
