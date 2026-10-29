"""Real local TLS readiness probes; no Docker, application DB or external traffic."""
import http.server
import importlib.util
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('demo_http', ROOT / 'deploy/scripts/demo_http.py')
HTTP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HTTP)


class ReadinessTests(unittest.TestCase):
    def test_bind_address_sni_response_validation_and_ambient_proxy(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            status, body = 200, b'{"status":"READY"}'

            def do_GET(self):
                self.send_response(self.status)
                self.end_headers()
                self.wfile.write(self.body)

            def log_message(self, *_args):
                pass

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                            '-keyout', str(root / 'key.pem'), '-out', str(root / 'cert.pem'),
                            '-days', '1', '-subj', '/CN=localhost'], check=True, capture_output=True)
            server = http.server.ThreadingHTTPServer(('127.0.0.2', 0), Handler)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(root / 'cert.pem', root / 'key.pem')
            names = []
            context.set_servername_callback(lambda _sock, name, _ctx: names.append(name))
            server.socket = context.wrap_socket(server.socket, server_side=True)
            worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
            worker.start()
            env = {'PROXY_BIND_IP': '127.0.0.2', 'HTTPS_PORT': str(server.server_port)}
            try:
                with patch.dict(os.environ, {'HTTPS_PROXY': 'http://127.0.0.1:1', 'NO_PROXY': ''}):
                    self.assertTrue(HTTP.gateway_ready(env))
                self.assertEqual(names, ['localhost'])
                for status, body in [(200, b'{"status":"NOT_READY"}'), (503, b'{"status":"READY"}'),
                                     (200, b'<html>not the gateway</html>'), (200, b'[]'),
                                     (200, b'{"status":"READY","pad":"' + b'x' * 4096 + b'"}')]:
                    Handler.status, Handler.body = status, body
                    self.assertFalse(HTTP.gateway_ready(env))
                self.assertFalse(HTTP.gateway_ready({**env, 'PROXY_BIND_IP': '127.0.0.1'}, timeout=0.2))
            finally:
                server.shutdown()
                server.server_close()
                worker.join(timeout=2)

    def test_invalid_listener_configuration_is_not_ready(self):
        for env in [{'PROXY_BIND_IP': 'not-an-ip'}, {'HTTPS_PORT': 'invalid'},
                    {'HTTPS_PORT': '0'}, {'HTTPS_PORT': '65536'}]:
            self.assertFalse(HTTP.gateway_ready(env))


if __name__ == '__main__':
    unittest.main()
