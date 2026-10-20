"""Gateway build/configuration guardrails; request behavior belongs to Vitest and make e2e."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class GatewayConfigurationTests(unittest.TestCase):
    def test_backend_stack_and_lockfile_match(self):
        package = json.loads((ROOT / 'gateway/package.json').read_text())
        lock = json.loads((ROOT / 'gateway/package-lock.json').read_text())
        self.assertEqual(package['dependencies'], lock['packages']['']['dependencies'])
        for dependency in ('fastify', 'pg', 'ssh2', '@fastify/jwt', '@fastify/websocket'):
            self.assertIn(dependency, package['dependencies'])
        self.assertEqual(package['scripts']['start'], 'node dist/server.js')
        self.assertEqual(package['scripts']['test'], 'vitest run')

    def test_runtime_excludes_build_tools_and_runs_nonroot(self):
        dockerfile = (ROOT / 'gateway/Dockerfile').read_text()
        runtime = dockerfile.split(' AS runner', 1)[1]
        self.assertIn('npm ci', dockerfile)
        self.assertIn('npm prune --omit=dev', dockerfile)
        self.assertIn('COPY --from=production-deps', runtime)
        self.assertIn('USER node', runtime)
        self.assertIn('CMD ["node", "dist/server.js"]', runtime)
        self.assertNotIn('COPY src/', runtime)

    def test_request_boundary_uses_pinned_proxy_and_jwt_algorithm(self):
        source = (ROOT / 'gateway/src/app.ts').read_text()
        self.assertIn('trustProxy: config.TRUSTED_PROXY_IP || false', source)
        self.assertIn("sign: { algorithm: 'HS256' }", source)
        self.assertIn("verify: { algorithms: ['HS256'] }", source)
        self.assertIn("code: 'RATE_LIMIT_EXCEEDED'", source)
        self.assertIn("fastify.get('/readyz'", source)
        self.assertIn('checkDatabaseHealth()', source)


if __name__ == '__main__':
    unittest.main()
