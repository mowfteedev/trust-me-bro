"""Agent packaging/source checks; Go unit tests and VM checks execute the Agent itself."""
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class AgentPackagingTests(unittest.TestCase):
    def test_go_agent_has_no_external_modules(self):
        module = (ROOT / 'agent/go.mod').read_text()
        self.assertRegex(module, r'(?m)^module zt-serverops/agent$')
        self.assertIsNone(re.search(r'(?m)^require\b', module))
        for collector in ('collect_linux.go', 'collect_windows.go'):
            with self.subTest(collector=collector):
                self.assertNotIn('"os/exec"', (ROOT / 'agent' / collector).read_text())

    def test_container_runs_static_binary_as_unprivileged_user(self):
        dockerfile = (ROOT / 'agent/Dockerfile').read_text()
        runtime = dockerfile.rsplit('FROM ', 1)[1]
        self.assertIn('CGO_ENABLED=0 go test ./...', dockerfile)
        self.assertIn('COPY --from=builder /out/zt-agent /usr/local/bin/zt-agent', runtime)
        self.assertIn('USER ztuser', runtime)
        self.assertIn('ENTRYPOINT ["/usr/local/bin/zt-agent"]', runtime)
        self.assertNotIn('golang:', runtime)

    def test_linux_installer_syntax_and_service_identity(self):
        installer = ROOT / 'agent/install.sh'
        subprocess.run(['bash', '-n', str(installer)], check=True)
        source = installer.read_text()
        for setting in ('User=zt-agent', 'Group=zt-agent', 'NoNewPrivileges=true',
                        'ProtectSystem=strict', 'Restart=on-failure', 'chmod 0600'):
            self.assertIn(setting, source)
        self.assertIn('if [[ ! -f "${ENV_TARGET}" ]]; then', source)

    def test_windows_installer_keeps_local_service_and_config(self):
        source = (ROOT / 'agent/install-windows.ps1').read_text()
        self.assertIn('[switch]$UpdateConfig', source)
        self.assertIn('S-1-5-19', source)
        self.assertIn('NT AUTHORITY\\LocalService', source)
        self.assertIn('Assert-NoReparsePoint', source)


if __name__ == '__main__':
    unittest.main()
