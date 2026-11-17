"""Rollback state verification with mocked commands; no host service mutations."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/automation'))
spec = importlib.util.spec_from_file_location('rollback_worker', ROOT / 'deploy/automation/worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class AutomationRollbackTests(unittest.TestCase):
    def state(self):
        return {'managed': {}, 'original_services': {'ssh': {'active': True, 'enabled': True}}}

    def observe(self, active='active', enabled='enabled', load='loaded', code=0):
        return subprocess.CompletedProcess([], code,
            f'LoadState={load}\nActiveState={active}\nUnitFileState={enabled}\n'.encode(), b'')

    def check(self, observed, tables=b'', failed_nft=False, state=None):
        value = state if state is not None else self.state()
        commands = []
        def run(command, **kwargs):
            commands.append(command)
            if command == ['nft', 'list', 'tables']:
                if failed_nft:
                    raise worker.InstallError('Firewall query failed')
                return tables
            return b''
        with patch.object(worker, 'run', side_effect=run), patch.object(worker, 'save'), \
                patch.object(worker.subprocess, 'run', return_value=observed):
            result = worker.rollback(value)
        self.assertNotIn(['nft', 'flush', 'ruleset'], commands)
        return result, value

    def test_restored_services_and_removed_owned_table_are_confirmed(self):
        result, value = self.check(self.observe(), b'table inet unrelated\n')
        self.assertTrue(result)
        self.assertTrue(value['rollback_complete'])
        self.assertEqual(value['phase'], 'rolled_back')

    def test_failed_ssh_restart_requires_review_even_when_files_restored(self):
        result, value = self.check(self.observe(active='failed'))
        self.assertFalse(result)
        self.assertFalse(value['rollback_complete'])
        self.assertEqual(value['phase'], 'rollback_needs_review')

    def test_failed_enable_is_not_success(self):
        self.assertFalse(self.check(self.observe(enabled='disabled'))[0])

    def test_remaining_owned_firewall_table_is_not_success(self):
        self.assertFalse(self.check(self.observe(), b'table inet zt_worker_auto\n')[0])

    def test_failed_state_observation_is_not_success(self):
        self.assertFalse(self.check(subprocess.CompletedProcess([], 1, b'', b'permission denied'))[0])
        self.assertFalse(self.check(self.observe(), failed_nft=True)[0])

    def test_new_unit_removed_after_rollback_is_valid_original_absence(self):
        state = {'managed': {}, 'original_services': {'zt-worker-firewall': {'active': False, 'enabled': False}}}
        self.assertTrue(self.check(self.observe(active='inactive', enabled='', load='not-found', code=1), state=state)[0])


if __name__ == '__main__':
    unittest.main()
