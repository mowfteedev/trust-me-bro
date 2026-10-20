"""Check command routing without Docker and cleanup safety in temporary directories."""
import importlib.util
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('clean_script', ROOT / 'deploy/scripts/clean.py')
CLEAN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CLEAN)
DEMO_SPEC = importlib.util.spec_from_file_location('demo_actions', ROOT / 'deploy/scripts/demo_actions.py')
DEMO = importlib.util.module_from_spec(DEMO_SPEC)
DEMO_SPEC.loader.exec_module(DEMO)


class CleanupTests(unittest.TestCase):
    def test_only_bytecode_removed_and_evidence_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache = root / 'deploy/__pycache__'
            cache.mkdir(parents=True)
            (cache / 'module.pyc').write_bytes(b'bytecode')
            (root / 'legacy.pyo').write_bytes(b'bytecode')
            evidence = [root / 'runtime.log', root / 'module.py', root / 'fixture.json']
            for protected in CLEAN.PROTECTED_DIRS:
                directory = root / protected / '__pycache__'
                directory.mkdir(parents=True)
                evidence.extend([directory / 'keep.pyc', directory / 'proof.log'])
            for path in evidence:
                path.write_bytes(b'keep exactly')

            self.assertEqual(CLEAN.clean_python_cache(root), (2, 1))
            self.assertFalse(cache.exists())
            for path in evidence:
                self.assertEqual(path.read_bytes(), b'keep exactly', str(path))
            self.assertEqual(CLEAN.clean_python_cache(root), (0, 0))

    def test_symlinks_and_non_bytecode_inside_cache_preserved(self):
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as external:
            root, outside = Path(temporary), Path(external)
            external_cache = outside / '__pycache__'
            external_cache.mkdir()
            target = external_cache / 'keep.pyc'
            target.write_bytes(b'outside')
            (root / 'linked-directory').symlink_to(outside, target_is_directory=True)
            (root / 'linked.pyc').symlink_to(target)
            (root / 'dangling.pyc').symlink_to(outside / 'missing')
            cache = root / '__pycache__'
            cache.mkdir()
            (cache / 'module.pyc').write_bytes(b'bytecode')
            (cache / 'proof.log').write_bytes(b'evidence')
            (cache / 'keys').mkdir()
            (cache / 'keys/keep.pyc').write_bytes(b'protected')

            self.assertEqual(CLEAN.clean_python_cache(root), (1, 0))
            self.assertEqual(target.read_bytes(), b'outside')
            self.assertEqual((cache / 'proof.log').read_bytes(), b'evidence')
            self.assertEqual((cache / 'keys/keep.pyc').read_bytes(), b'protected')
            for name in ('linked-directory', 'linked.pyc', 'dangling.pyc'):
                self.assertTrue((root / name).is_symlink(), name)


class MakeCommandTests(unittest.TestCase):
    def test_cluster_targets_forward_selected_environment(self):
        actions = {'up': 'up', 'down': 'down', 'status': 'status', 'logs': 'logs',
                   'e2e': 'check', 'doctor': 'doctor', 'check-cpu': 'check-cpu',
                   'check-telegram': 'check-telegram', 'maintenance': 'maintenance'}
        for target, action in actions.items():
            with self.subTest(target=target):
                result = subprocess.run(
                    ['make', '--no-print-directory', '-n', target, 'PROJECT=zt_fixture',
                     'ENV_FILE=keys/fixture with spaces.env', 'PYTHON=python-custom'],
                    cwd=ROOT, check=True, text=True, capture_output=True,
                )
                commands = [shlex.split(line) for line in result.stdout.splitlines()]
                self.assertIn(['python-custom', 'deploy/scripts/demo.py', action,
                               '--env-file', 'keys/fixture with spaces.env',
                               '--project', 'zt_fixture'], commands)


class CredentialTests(unittest.TestCase):
    def test_maintenance_uses_existing_role_job_without_demo_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            env_path = root / 'maintenance.env'
            env_path.write_text('MAINTENANCE_DATABASE_URL=postgresql://zt_maintenance:fixture@postgres/fixture\n')
            with patch.object(DEMO, 'KEYS', root), patch.object(DEMO, 'run') as run:
                DEMO.dispatch('maintenance', env_path, 'zt_fixture', self.fail)
                run.assert_called_once_with(['docker', 'compose', '--env-file', str(env_path), '-p', 'zt_fixture',
                                             '--profile', 'demo', '--profile', 'maintenance', 'run', '--rm',
                                             '--build', '--no-deps', 'maintenance'])
                self.assertFalse((root / 'demo-login.env').exists())

    def test_checks_do_not_create_or_replace_login_credentials(self):
        previous = DEMO.KEYS
        try:
            with tempfile.TemporaryDirectory() as temporary:
                DEMO.KEYS = Path(temporary)
                with self.assertRaises(RuntimeError):
                    DEMO.credentials()
                self.assertEqual(list(DEMO.KEYS.iterdir()), [])
                created = DEMO.credentials(create=True)
                before = (DEMO.KEYS / 'demo-login.env').read_bytes()
                self.assertEqual(DEMO.credentials(), created)
                self.assertEqual((DEMO.KEYS / 'demo-login.env').read_bytes(), before)
                self.assertEqual((DEMO.KEYS / 'demo-login.env').stat().st_mode & 0o777, 0o600)
        finally:
            DEMO.KEYS = previous

    def test_check_dispatch_requires_credentials_before_running_commands(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            keys = root / 'keys'
            keys.mkdir()
            env_path = root / 'fixture with spaces.env'
            env_path.write_text('TELEGRAM_MODE=live\nTELEGRAM_BOT_TOKEN=fixture\n')
            with patch.object(DEMO, 'KEYS', keys), patch.object(DEMO, 'run') as run:
                for action in ('setup', 'check', 'check-cpu', 'check-telegram'):
                    with self.subTest(action=action), self.assertRaises(RuntimeError):
                        DEMO.dispatch(action, env_path, 'zt_fixture', self.fail)
                    run.assert_not_called()
                    self.assertEqual(list(keys.iterdir()), [])

    def test_inspection_and_down_preserve_credentials_and_compose_selection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            env_path = root / 'fixture with spaces.env'
            env_path.write_text('TELEGRAM_MODE=dry-run\n')
            compose = ['docker', 'compose', '--env-file', str(env_path), '-p', 'zt_fixture', '--profile', 'demo']
            commands = {'status': compose + ['ps', '-a'],
                        'logs': compose + ['logs', '--tail', '80', 'gateway', 'wireguard_gateway', 'node_worker_01'],
                        'down': compose + ['down']}
            with patch.object(DEMO, 'KEYS', root), patch.object(DEMO, 'run') as run:
                for action, command in commands.items():
                    with self.subTest(action=action):
                        DEMO.dispatch(action, env_path, 'zt_fixture', self.fail)
                        run.assert_called_once_with(command)
                        self.assertFalse((root / 'demo-login.env').exists())
                        run.reset_mock()


if __name__ == '__main__':
    unittest.main()
