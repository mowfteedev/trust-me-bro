"""Deployment configuration checks only; make e2e exercises real PostgreSQL/SSH."""
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class InfrastructureContractTests(unittest.TestCase):
    def test_initialization_shell_syntax_and_private_key_mode(self):
        for script in ('deploy/scripts/init-secrets.sh', 'deploy/scripts/maintenance-retention.sh'):
            with self.subTest(script=script):
                subprocess.run(['bash', '-n', str(ROOT / script)], check=True)
        source = (ROOT / 'deploy/scripts/init-secrets.sh').read_text()
        self.assertIn('chmod 400 "$key_path"', source)
        self.assertIn('bastion_id_ed25519', source)
        self.assertIn('umask 077', source)

    def test_secrets_and_local_reports_are_ignored(self):
        paths = ['keys/fixture.key', '.env', '.memory/fixture', 'docs/fixture.md', 'AGENTS.md']
        result = subprocess.run(['git', 'check-ignore', '--no-index', *paths], cwd=ROOT,
                                check=True, text=True, capture_output=True)
        self.assertEqual(set(result.stdout.splitlines()), set(paths))

    def test_compose_publishes_only_wireguard_on_gateway_and_no_database_port(self):
        source = (ROOT / 'docker-compose.yml').read_text()
        services = dict(re.findall(r'^  ([a-z_0-9]+):\n(.*?)(?=^  [a-z_0-9]+:|^networks:|^volumes:|\Z)',
                                   source, re.MULTILINE | re.DOTALL))
        self.assertNotRegex(services['postgres'], r'(?m)^    ports:')
        published = services['gateway'].split('    ports:', 1)[1].split('    expose:', 1)[0]
        self.assertEqual(published.strip(), '- "${WG_BIND_IP:-0.0.0.0}:${WG_HOST_PORT:-51820}:51820/udp"')
        self.assertIn('${PROXY_BIND_IP:-127.0.0.1}', services['proxy'])
        self.assertIn('internal: true', source)
        self.assertIn('pg_isready', services['postgres'])

    def test_maintenance_is_opt_in_and_uses_separate_database_role(self):
        source = (ROOT / 'docker-compose.yml').read_text()
        maintenance = source.split('  maintenance:', 1)[1].split('  gateway:', 1)[0]
        self.assertIn('profiles: ["maintenance"]', maintenance)
        self.assertIn('MAINTENANCE_DATABASE_URL:', maintenance)
        self.assertIn('dist/scripts/run-maintenance.js', maintenance)
        self.assertNotRegex(maintenance, r'(?m)^      DATABASE_URL:')
        migration = (ROOT / 'gateway/migrations/007_extend_token_hash_and_add_maintenance_role.sql').read_text()
        for fragment in ('SECURITY DEFINER', 'SET search_path = pg_catalog, public, pg_temp',
                         'FROM PUBLIC', 'FROM zt_app', 'TO zt_maintenance'):
            self.assertIn(fragment, migration)


if __name__ == '__main__':
    unittest.main()
