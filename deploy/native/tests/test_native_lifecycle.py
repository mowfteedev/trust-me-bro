#!/usr/bin/env python3
"""Ownership/lifecycle unit checks; kernel and systemd calls are mocked here."""
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_lifecycle', ROOT / 'scripts/wireguard-lifecycle.py')
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)


class Ownership(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='zt-native-lifecycle-unit-')
        self.runtime = Path(self.directory.name)
        self.marker = self.runtime / 'owner.json'
        self.patch_runtime = patch.object(lifecycle, 'RUNTIME', self.runtime)
        self.patch_marker = patch.object(lifecycle, 'MARKER', self.marker)
        self.patch_runtime.start()
        self.patch_marker.start()
        self.expected = {'invocation_id': 'a' * 32, 'config': '/etc/wireguard/ztgw0.conf',
                         'interface': 'ztgw0', 'api_port': 3100, 'gateway_ip': '10.100.0.1'}
        self.link_state = []
        self.filter_state = '-P INPUT ACCEPT\n'
        self.mangle_state = '-P PREROUTING ACCEPT\n'
        self.calls = []
        self.failure = None

    def tearDown(self):
        self.patch_marker.stop()
        self.patch_runtime.stop()
        self.directory.cleanup()

    def fake_run(self, command):
        self.calls.append(command)
        if self.failure and self.failure in command:
            raise RuntimeError('injected command failure')
        if command == ['ip', '-j', '-d', 'link', 'show']:
            return json.dumps(self.link_state)
        if command[0] == 'iptables':
            return self.filter_state if 'filter' in command else self.mangle_state
        if command == ['ip', 'link', 'delete', 'dev', 'ztgw0']:
            self.link_state = []
            return ''
        if command == [str(lifecycle.FIREWALL), 'down', 'ztgw0', '3100']:
            return ''
        raise AssertionError('Unexpected command: ' + repr(command))

    def test_prepare_records_current_attempt_only_after_readonly_checks(self):
        with patch.object(lifecycle, 'run', side_effect=self.fake_run):
            lifecycle.prepare(self.expected)
        self.assertEqual(json.loads(self.marker.read_text()), self.expected)
        self.assertEqual(stat.S_IMODE(self.marker.stat().st_mode), 0o600)
        self.assertEqual(len(self.calls), 3)
        self.assertTrue(all('show' in c or '-S' in c for c in self.calls))

    def test_refused_existing_chain_does_not_enable_cleanup(self):
        self.filter_state += '-N ZTNATIVE_IN\n'
        with patch.object(lifecycle, 'run', side_effect=self.fake_run):
            with self.assertRaisesRegex(RuntimeError, 'already exists'):
                lifecycle.prepare(self.expected)
            before = list(self.calls)
            lifecycle.cleanup(self.expected)
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.calls, before)

    def test_refused_existing_interface_does_not_enable_cleanup(self):
        self.link_state = [{'ifname': 'ztgw0', 'linkinfo': {'info_kind': 'wireguard'}}]
        with patch.object(lifecycle, 'run', side_effect=self.fake_run):
            with self.assertRaisesRegex(RuntimeError, 'already exists'):
                lifecycle.prepare(self.expected)
            before = list(self.calls)
            lifecycle.cleanup(self.expected)
        self.assertEqual(self.calls, before)
        self.assertEqual(len(self.link_state), 1)

    def test_backend_error_cannot_grant_ownership(self):
        self.failure = 'iptables'
        with patch.object(lifecycle, 'run', side_effect=self.fake_run):
            with self.assertRaises(RuntimeError):
                lifecycle.prepare(self.expected)
            before = list(self.calls)
            lifecycle.cleanup(self.expected)
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.calls, before)

    def test_failed_up_cleans_owned_interface_and_firewall_then_removes_marker(self):
        with patch.object(lifecycle, 'run', side_effect=self.fake_run):
            lifecycle.prepare(self.expected)
            self.link_state = [{'ifname': 'ztgw0', 'linkinfo': {'info_kind': 'wireguard'}}]
            self.calls.clear()
            lifecycle.cleanup(self.expected)
        self.assertEqual(self.calls, [
            ['ip', '-j', '-d', 'link', 'show'],
            ['ip', 'link', 'delete', 'dev', 'ztgw0'],
            [str(lifecycle.FIREWALL), 'down', 'ztgw0', '3100']])
        self.assertFalse(self.marker.exists())

    def test_failed_up_with_interface_already_removed_still_cleans_firewall(self):
        with patch.object(lifecycle, 'run', side_effect=self.fake_run):
            lifecycle.prepare(self.expected)
            self.calls.clear()
            lifecycle.cleanup(self.expected)
        self.assertEqual(self.calls[-1], [str(lifecycle.FIREWALL), 'down', 'ztgw0', '3100'])
        self.assertFalse(self.marker.exists())

    def test_repeat_cleanup_after_normal_stop_is_noop(self):
        with patch.object(lifecycle, 'run', side_effect=self.fake_run):
            lifecycle.prepare(self.expected)
            lifecycle.cleanup(self.expected)
            self.calls.clear()
            lifecycle.cleanup(self.expected)
        self.assertEqual(self.calls, [])

    def test_previous_invocation_marker_is_preserved_when_new_prepare_fails(self):
        with patch.object(lifecycle, 'run', side_effect=self.fake_run):
            lifecycle.prepare(self.expected)
            old = self.marker.read_bytes()
            self.calls.clear()
            new = {**self.expected, 'invocation_id': 'b' * 32}
            with self.assertRaisesRegex(RuntimeError, 'marker already exists'):
                lifecycle.prepare(new)
            with self.assertRaisesRegex(RuntimeError, 'different start attempt'):
                lifecycle.cleanup(new)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.marker.read_bytes(), old)

    def test_unexpected_interface_type_is_preserved(self):
        with patch.object(lifecycle, 'run', side_effect=self.fake_run):
            lifecycle.prepare(self.expected)
            self.link_state = [{'ifname': 'ztgw0', 'linkinfo': {'info_kind': 'dummy'}}]
            self.calls.clear()
            with self.assertRaisesRegex(RuntimeError, 'not WireGuard'):
                lifecycle.cleanup(self.expected)
        self.assertTrue(self.marker.exists())
        self.assertEqual(len(self.calls), 1)

    def test_cleanup_failure_retains_marker(self):
        with patch.object(lifecycle, 'run', side_effect=self.fake_run):
            lifecycle.prepare(self.expected)
            self.failure = str(lifecycle.FIREWALL)
            with self.assertRaises(RuntimeError):
                lifecycle.cleanup(self.expected)
        self.assertTrue(self.marker.exists())

    def test_marker_symlink_cannot_authorize_cleanup(self):
        external = self.runtime / 'external.json'
        external.write_text(json.dumps(self.expected))
        external.chmod(0o600)
        self.marker.symlink_to(external)
        with patch.object(lifecycle, 'run', side_effect=self.fake_run):
            with self.assertRaisesRegex(RuntimeError, 'file type'):
                lifecycle.cleanup(self.expected)
        self.assertEqual(self.calls, [])
        self.assertTrue(self.marker.is_symlink())


if __name__ == '__main__':
    unittest.main(verbosity=2)
