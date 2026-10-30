"""Dashboard build/configuration checks; browser and Node tests verify UI/API behavior."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DashboardConfigurationTests(unittest.TestCase):
    def test_stack_matches_lockfile(self):
        package = json.loads((ROOT / 'dashboard/package.json').read_text())
        lock = json.loads((ROOT / 'dashboard/package-lock.json').read_text())
        self.assertEqual(package['dependencies'], lock['packages']['']['dependencies'])
        for name in ('react', 'react-dom', '@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'):
            self.assertIn(name, package['dependencies'])
        self.assertEqual(package['scripts']['build'], 'tsc && vite build')

    def test_dev_server_stays_local_and_proxies_api_and_websocket(self):
        source = (ROOT / 'dashboard/vite.config.ts').read_text()
        self.assertIn("host: '127.0.0.1'", source)
        self.assertIn("'/api':", source)
        self.assertIn("'/ws':", source)
        self.assertIn('ws: true', source)
        self.assertIn('sourcemap: false', source)
        self.assertIn('terminal:', source)

    def test_terminal_uses_ticket_frame_and_closes_resources(self):
        source = (ROOT / 'dashboard/src/components/TerminalModal.tsx').read_text()
        self.assertIn('api.getBastionTicket(node.id)', source)
        self.assertIn("JSON.stringify({ type: 'AUTH', ticket })", source)
        self.assertIn('.dispose()', source)
        self.assertIn('.close(', source)
        self.assertNotRegex(source, r'wsUrl[^;]*[?&](?:token|ticket)=')


if __name__ == '__main__':
    unittest.main()
