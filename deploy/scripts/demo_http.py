"""Probe the configured listener using the bundled Caddy site's localhost name."""
import http.client
import ipaddress
import json
import socket
import ssl


def gateway_ready(env, timeout=3):
    connection = None
    try:
        address = ipaddress.ip_address(env.get('PROXY_BIND_IP') or '127.0.0.1')
        if address.is_unspecified:
            address = ipaddress.ip_address('::1' if address.version == 6 else '127.0.0.1')
        port = int(env.get('HTTPS_PORT') or '443')
        if not 1 <= port <= 65535:
            return False
        # The demo CA is local. Connect to the bind IP, retain localhost SNI/Host,
        # and bypass ambient proxies; this is readiness, not a CA trust check.
        context = ssl._create_unverified_context()
        connection = http.client.HTTPConnection('localhost', port, timeout=timeout)
        with socket.create_connection((str(address), port), timeout=timeout) as raw:
            connection.sock = context.wrap_socket(raw, server_hostname='localhost')
            connection.request('GET', '/readyz')
            response = connection.getresponse()
            body = response.read(4097)
            if response.status != 200 or len(body) > 4096:
                return False
            data = json.loads(body)
            return isinstance(data, dict) and data.get('status') == 'READY'
    except (OSError, ValueError, http.client.HTTPException):
        return False
    finally:
        if connection:
            connection.close()
