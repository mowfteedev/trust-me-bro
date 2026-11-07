#!/usr/bin/env python3
"""One-shot host collector. Publishes only counters and four owned service states."""
import argparse
from datetime import datetime, timezone
import ipaddress
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import urllib.request

SERVICES = {'gateway': 'Gateway', 'proxy': 'Caddy', 'postgres': 'PostgreSQL', 'wireguard_gateway': 'WireGuard'}
STATES = {'healthy', 'running', 'unhealthy', 'stopped', 'unknown'}


def atomic_json(path, data, mode):
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name + '-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, separators=(',', ':'), allow_nan=False)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def previous(path):
    try:
        if path.stat().st_size > 262144:
            return {}
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def host_counters(old):
    ticks = [int(x) for x in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
    total, idle = sum(ticks), ticks[3] + ticks[4]
    prior = old.get('cpu_ticks', [])
    cpu = None
    if len(prior) == 2 and total > prior[0] and idle >= prior[1]:
        cpu = round(max(0, min(100, 100 * (1 - (idle - prior[1]) / (total - prior[0])))), 2)
    memory = dict((line.split(':', 1)[0], int(line.split()[1]) * 1024)
                  for line in Path('/proc/meminfo').read_text().splitlines() if ':' in line)
    disk = os.statvfs('/')
    interface = next((line.split()[0] for line in Path('/proc/net/route').read_text().splitlines()[1:]
                      if line.split()[1] == '00000000' and int(line.split()[3], 16) & 1), None)
    counters = {}
    for line in Path('/proc/net/dev').read_text().splitlines()[2:]:
        name, data = line.split(':', 1)
        counters[name.strip()] = [int(x) for x in data.split()]
    if interface not in counters:
        raise RuntimeError('No host uplink counters')
    network = counters[interface]
    host = {'hostname': socket.gethostname(), 'cpu_percent': cpu,
            'memory_total_bytes': memory['MemTotal'], 'memory_used_bytes': memory['MemTotal'] - memory['MemAvailable'],
            'disk_total_bytes': disk.f_blocks * disk.f_frsize,
            'disk_used_bytes': (disk.f_blocks - disk.f_bfree) * disk.f_frsize,
            'uptime_seconds': int(float(Path('/proc/uptime').read_text().split()[0])),
            'network_interface': interface, 'network_rx_bytes': network[0], 'network_tx_bytes': network[8]}
    return host, [total, idle]


def probe(url, ready=False):
    # Local loopback demo TLS only; no credentials or external URLs are sent.
    handlers = [urllib.request.ProxyHandler({})]
    if url.startswith('https://'):
        handlers.append(urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))
    try:
        with urllib.request.build_opener(*handlers).open(url, timeout=1) as response:
            body = response.read(4096)
            return response.status == 200 and (not ready or json.loads(body).get('status') == 'READY')
    except Exception:
        return False


def service_states(project):
    containers = [f'{project}-{name}-1' for name in SERVICES]
    fmt = '{{.Name}}|{{.State.Running}}|{{.State.Restarting}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.StartedAt}}|{{range .NetworkSettings.Networks}}{{.IPAddress}},{{end}}'
    try:
        result = subprocess.run(['docker', 'inspect', '--format', fmt, *containers],
                                capture_output=True, text=True, timeout=3)
        lines = result.stdout.splitlines()
    except (OSError, subprocess.TimeoutExpired):
        lines = []
    parsed = {}
    for line in lines:
        fields = line.split('|')
        if len(fields) == 7:
            parsed[fields[0].lstrip('/')] = fields[1:]
    output = []
    for service, name in SERVICES.items():
        row = parsed.get(f'{project}-{service}-1')
        state, started, restarts = 'unknown', None, 0
        if row:
            running, restarting, health, count, stamp, addresses = row
            restarts = max(0, int(count))
            started = stamp if stamp and not stamp.startswith('0001-') else None
            state = 'stopped' if running != 'true' else 'unhealthy' if restarting == 'true' or health == 'unhealthy' else 'healthy' if health == 'healthy' else 'running'
            if state in {'running', 'healthy'} and service == 'gateway':
                ips = [ip for ip in addresses.split(',') if ip]
                private = next((ip for ip in ips if ipaddress.ip_address(ip).version == 4 and ipaddress.ip_address(ip).is_private), None)
                state = 'healthy' if private and probe(f'http://{private}:3000/readyz', ready=True) else 'unhealthy'
            if state in {'running', 'healthy'} and service == 'proxy':
                state = 'healthy' if probe('https://localhost:8443/') else 'unhealthy'
        output.append({'id': service, 'name': name, 'state': state, 'started_at': started, 'restarts': restarts})
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=Path('/run/zt-serverops-monitor'))
    parser.add_argument('--project', default='zt_ec2')
    args = parser.parse_args()
    if not args.project.replace('_', '').replace('-', '').isalnum():
        parser.error('Invalid Compose project')
    args.output_dir.mkdir(mode=0o755, parents=True, exist_ok=True)
    snapshot_path = args.output_dir / 'host.json'
    old = previous(snapshot_path)
    host, ticks = host_counters(previous(args.output_dir / '.cpu.json'))
    services = service_states(args.project)
    stamp = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    for service in services:
        prior = next((item for item in old.get('services', []) if item.get('id') == service['id']), {})
        observations = [item for item in prior.get('observations', [])
                        if isinstance(item, dict) and isinstance(item.get('at'), str) and item.get('state') in STATES]
        service['observations'] = (observations + [{'at': stamp, 'state': service['state']}])[-30:]
    atomic_json(snapshot_path, {'sampled_at': stamp, 'host': host, 'services': services}, 0o644)
    atomic_json(args.output_dir / '.cpu.json', {'cpu_ticks': ticks}, 0o600)


if __name__ == '__main__':
    main()
