"""Offline safety checks; real PostgreSQL roundtrip requires explicit opt-in."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'deploy/scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


recovery = load('recovery')
worker = load('worker_check')
release = load('release_manifest')
acceptance = load('acceptance')


def bundle(root, worker_os='linux'):
    root.mkdir(mode=0o700)
    token = 'a' * 64
    values = {
        'node.token': token,
        'bastion_id_ed25519.pub': 'ssh-ed25519 ' + base64.b64encode(b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20' + bytes(32)).decode(),
        'metadata.json': json.dumps({'node_name': 'fixture-linux', 'node_type': 'BARE_METAL', 'node_ip': '10.100.0.6',
                                    'tunnel_name': 'zt-worker', 'gateway_endpoint': '192.0.2.1:51820'}),
        'agent-config.json': json.dumps({'NODE_ID': 'fixture-linux', 'NODE_TOKEN': token,
                                       'NETWORK_INTERFACE': 'zt-worker', 'GATEWAY_URL': 'http://10.100.0.1:3000',
                                       'DISK_MOUNT_POINT': '/' if worker_os == 'linux' else 'C:\\'}),
        'zt-worker.conf': '[Interface]\nPrivateKey = ' + base64.b64encode(bytes(32)).decode() + '\nAddress = 10.100.0.6/32\n[Peer]\nPublicKey = ' + base64.b64encode(bytes(range(32))).decode() + '\nEndpoint = 192.0.2.1:51820\nAllowedIPs = 10.100.0.1/32\n',
    }
    for name, content in values.items():
        (root / name).write_text(content)
        (root / name).chmod(0o600)


class RecoverySafety(unittest.TestCase):
    def make_archive(self, root, member='nested/config.json'):
        root.mkdir(mode=0o700)
        (root / 'database.dump').write_bytes(b'fixture-custom-dump')
        with tarfile.open(root / 'config.tar', 'w:') as archive:
            entry = tarfile.TarInfo(member)
            entry.size = 3
            archive.addfile(entry, io.BytesIO(b'abc'))
        for name in recovery.FILES:
            (root / name).chmod(0o600)
        manifest = {'format_version': 1, 'checksums': {n: recovery.checksum(root / n) for n in recovery.FILES}}
        (root / 'manifest.json').write_text(json.dumps(manifest))
        (root / 'manifest.json').chmod(0o600)
        return root

    def test_tampered_dump_is_rejected(self):
        with tempfile.TemporaryDirectory() as parent:
            path = self.make_archive(Path(parent) / 'backup')
            self.assertEqual(recovery.validate_bundle(path)['format_version'], 1)
            (path / 'database.dump').write_bytes(b'changed')
            with self.assertRaises(ValueError):
                recovery.validate_bundle(path)

    def test_traversal_rejected_before_restore(self):
        with tempfile.TemporaryDirectory() as parent:
            path = self.make_archive(Path(parent) / 'backup', '../../outside')
            with self.assertRaises(ValueError):
                recovery.validate_bundle(path)

    def test_world_readable_backup_is_rejected(self):
        with tempfile.TemporaryDirectory() as parent:
            path = self.make_archive(Path(parent) / 'backup')
            (path / 'config.tar').chmod(0o644)
            with self.assertRaises(ValueError):
                recovery.validate_bundle(path)

    def test_symlinks_and_repository_output_rejected(self):
        with tempfile.TemporaryDirectory() as parent:
            link = Path(parent) / 'link'
            link.symlink_to(parent, target_is_directory=True)
            with self.assertRaises(ValueError):
                recovery.private_dir(link / 'backup')
        with self.assertRaises(ValueError):
            recovery.private_dir(ROOT / 'never-created-backup')

    def test_manifest_has_source_migrations_and_no_environment(self):
        result = release.source_manifest()
        self.assertEqual(len(result['commit']), 40)
        self.assertTrue(result['migrations'])
        self.assertNotIn('environment', result)
        self.assertFalse(any(name.startswith(('keys/', '.memory/')) for name in result['source_files']))


class WorkerBundleChecks(unittest.TestCase):
    def test_linux_and_windows_configs_and_no_runtime_claim(self):
        for worker_os in ('linux', 'windows'):
            with self.subTest(worker_os=worker_os), tempfile.TemporaryDirectory() as parent:
                path = Path(parent) / 'bundle'
                bundle(path, worker_os)
                result = worker.check(path, worker_os)
                self.assertTrue(result['config_consistent'])
                self.assertFalse(result['wireguard_handshake_verified'])
                self.assertFalse(result['reboot_verified'])

    def test_mixed_gateway_and_token_rejected(self):
        with tempfile.TemporaryDirectory() as parent:
            path = Path(parent) / 'bundle'
            bundle(path)
            cfg = path / 'agent-config.json'
            data = json.loads(cfg.read_text())
            data['GATEWAY_URL'] = 'http://10.100.0.1:3100'
            cfg.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                worker.check(path, 'linux')
            data['GATEWAY_URL'] = 'http://10.100.0.1:3000'
            data['NODE_TOKEN'] = 'b' * 64
            cfg.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                worker.check(path, 'linux')

    def test_windows_mount_on_linux_rejected(self):
        with tempfile.TemporaryDirectory() as parent:
            path = Path(parent) / 'bundle'
            bundle(path, 'windows')
            with self.assertRaises(ValueError):
                worker.check(path, 'linux')

    def test_prepare_cli_offers_correct_os_and_physical_type(self):
        help_text = subprocess.check_output(['python3', 'deploy/scripts/register-node.py', 'prepare', '--help'], cwd=ROOT, text=True)
        self.assertIn('--worker-os', help_text)
        self.assertIn('BARE_METAL', help_text)


class AcceptanceStatus(unittest.TestCase):
    def test_missing_go_and_docker_remains_unverified(self):
        with patch.object(acceptance.shutil, 'which', return_value=None):
            self.assertIsNone(acceptance.agent_command())
        with tempfile.TemporaryDirectory() as parent:
            result = acceptance.run_check('agent', None, 'unit', Path(parent))
        self.assertEqual(result['status'], 'SKIP')
        self.assertEqual(acceptance.overall_status([result]), 'INCOMPLETE')

    def test_failed_check_cannot_be_hidden_by_skip(self):
        self.assertEqual(acceptance.overall_status([{'status':'SKIP'}, {'status':'FAIL'}]), 'FAIL')
        self.assertEqual(acceptance.overall_status([{'status':'PASS'}]), 'PASS')


if __name__ == '__main__':
    unittest.main()
