"""Deployment configuration checks only; make e2e exercises real PostgreSQL/SSH."""
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


def compose_services():
    source = (ROOT / 'docker-compose.yml').read_text()
    service_section = source.split('\nservices:\n', 1)[1].split('\nnetworks:\n', 1)[0]
    return dict(re.findall(r'^  ([a-z_0-9]+):\n(.*?)(?=^  [a-z_0-9]+:|\Z)',
                           service_section, re.MULTILINE | re.DOTALL))


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
        services = compose_services()
        self.assertNotRegex(services['postgres'], r'(?m)^    ports:')
        published = services['gateway'].split('    ports:', 1)[1].split('    expose:', 1)[0]
        self.assertEqual(published.strip(), '- "${WG_BIND_IP:-0.0.0.0}:${WG_HOST_PORT:-51820}:51820/udp"')
        self.assertIn('${PROXY_BIND_IP:-127.0.0.1}', services['proxy'])
        self.assertIn('internal: true', source)
        self.assertIn('pg_isready', services['postgres'])

    def test_core_runs_four_services_and_admin_jobs_finish(self):
        services = compose_services()
        persistent = {name for name, block in services.items()
                      if 'restart: unless-stopped' in block and 'profiles:' not in block}
        self.assertEqual(persistent, {'postgres', 'gateway', 'proxy', 'wireguard_gateway'})
        self.assertNotIn('dashboard', services)
        for job in ('migrator', 'provisioner', 'maintenance'):
            with self.subTest(job=job):
                self.assertIn('restart: "no"', services[job])
                self.assertIn('<<: *gateway-image', services[job])
        self.assertIn('profiles: [demo]', services['node_worker_01'])
        self.assertNotRegex(services['node_worker_01'], r'(?m)^    ports:')

    def test_small_machine_database_settings_reach_postgres_and_pool(self):
        services = compose_services()
        for setting in ('shared_buffers=${PG_SHARED_BUFFERS:-32MB}',
                        'max_connections=${PG_MAX_CONNECTIONS:-30}',
                        'work_mem=${PG_WORK_MEM:-2MB}',
                        'maintenance_work_mem=${PG_MAINTENANCE_WORK_MEM:-16MB}'):
            with self.subTest(setting=setting):
                self.assertIn('- ' + setting, services['postgres'])
        self.assertIn('DB_MAX_CONNECTIONS: ${DB_MAX_CONNECTIONS:-5}', services['gateway'])

    def test_caddy_serves_spa_and_routes_api_and_websocket_before_fallback(self):
        services = compose_services()
        self.assertIn('dockerfile: deploy/proxy/Dockerfile', services['proxy'])
        self.assertNotIn('- dashboard', services['proxy'])
        caddy = (ROOT / 'deploy/proxy/Caddyfile').read_text()
        self.assertIn('@backend path /api/* /ws/* /healthz /readyz', caddy)
        self.assertIn('reverse_proxy gateway:3000', caddy)
        self.assertLess(caddy.index('handle @backend'), caddy.index('root * /srv/dashboard'))
        self.assertIn('try_files {path} /index.html', caddy)
        self.assertIn('file_server', caddy)
        self.assertNotIn('dashboard:80', caddy)

    def test_root_context_frontend_build_excludes_deployment_secrets(self):
        dockerfile = (ROOT / 'deploy/proxy/Dockerfile').read_text()
        self.assertNotRegex(dockerfile, r'(?m)^COPY\s+\.\s+\.')
        self.assertIn('COPY dashboard/src/ ./src/', dockerfile)
        self.assertIn('COPY --from=dashboard-build /src/dashboard/dist /srv/dashboard', dockerfile)
        ignored = set((ROOT / '.dockerignore').read_text().splitlines())
        self.assertTrue({'.git', '.memory', '.env', '.env.*', 'keys'} <= ignored)

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
