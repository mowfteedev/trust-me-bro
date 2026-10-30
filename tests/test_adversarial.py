"""Security configuration guardrails, not penetration tests or SLA measurements."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class SecurityConfigurationTests(unittest.TestCase):
    def test_wireguard_template_blocks_worker_forwarding_without_nat(self):
        source = (ROOT / 'deploy/wireguard/wg0-gateway.conf').read_text()
        rules = '\n'.join(line for line in source.splitlines() if line.startswith(('PostUp', 'PostDown')))
        self.assertIn('iptables -A FORWARD -i %i -j DROP', rules)
        self.assertNotIn('MASQUERADE', rules)
        self.assertIn('ListenPort = 51820', source)

    def test_worker_ssh_disables_password_root_and_forwarding(self):
        for name in ('deploy/linux/sshd-worker.conf', 'deploy/demo/sshd_config'):
            with self.subTest(config=name):
                source = (ROOT / name).read_text()
                settings = dict(re.findall(r'^(\w+)\s+(.+)$', source, re.MULTILINE))
                self.assertEqual(settings['PasswordAuthentication'], 'no')
                self.assertEqual(settings['PermitRootLogin'], 'no')
                self.assertEqual(settings['AllowTcpForwarding'], 'no')
                self.assertTrue(settings['ListenAddress'].startswith('10.100.0.'))

    def test_worker_firewall_has_default_deny_input_and_forward(self):
        source = (ROOT / 'deploy/linux/nftables-worker.conf').read_text()
        self.assertRegex(source, r'chain input\s*{[^}]*policy drop;')
        self.assertRegex(source, r'chain forward\s*{[^}]*policy drop;')
        self.assertIn('ip saddr 10.100.0.1 tcp dport 22 accept', source)

    def test_dashboard_does_not_render_raw_html(self):
        for source in (ROOT / 'dashboard/src').rglob('*.tsx'):
            with self.subTest(source=source.relative_to(ROOT)):
                self.assertNotIn('dangerouslySetInnerHTML', source.read_text())


if __name__ == '__main__':
    unittest.main()
