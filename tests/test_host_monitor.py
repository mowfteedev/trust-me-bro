"""Collector behavior without Docker or network side effects."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('host_monitor', Path(__file__).parents[1] / 'deploy/ec2/host-monitor.py')
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class HostMonitorTests(unittest.TestCase):
    def test_missing_docker_is_unknown_not_healthy(self):
        with patch.object(monitor.subprocess, 'run', side_effect=FileNotFoundError):
            rows = monitor.service_states('zt_ec2')
        self.assertEqual(len(rows), 4)
        self.assertEqual({x['state'] for x in rows}, {'unknown'})

    def test_proxy_health_independent_of_gateway_readiness(self):
        lines = '\n'.join([
            '/zt_ec2-gateway-1|true|false|none|0|2026-11-08T00:00:00Z|172.21.0.3,',
            '/zt_ec2-proxy-1|true|false|none|1|2026-11-08T00:00:00Z|172.21.0.4,',
            '/zt_ec2-postgres-1|true|false|unhealthy|0|2026-11-08T00:00:00Z|172.21.0.2,',
            '/zt_ec2-wireguard_gateway-1|false|false|healthy|0|2026-11-08T00:00:00Z|',
        ])
        with patch.object(monitor.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, lines, '')), patch.object(monitor, 'probe', side_effect=lambda url, ready=False: not ready):
            rows = {x['id']: x for x in monitor.service_states('zt_ec2')}
        self.assertEqual(rows['gateway']['state'], 'unhealthy')
        self.assertEqual(rows['proxy']['state'], 'healthy')
        self.assertEqual(rows['postgres']['state'], 'unhealthy')
        self.assertEqual(rows['wireguard_gateway']['state'], 'stopped')

    def test_atomic_snapshot_permissions_and_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'host.json'
            monitor.atomic_json(target, {'sample': 1}, 0o644)
            monitor.atomic_json(target, {'sample': 2}, 0o644)
            self.assertEqual(monitor.previous(target), {'sample': 2})
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)
            self.assertEqual(len(list(Path(directory).iterdir())), 1)


if __name__ == '__main__':
    unittest.main()
