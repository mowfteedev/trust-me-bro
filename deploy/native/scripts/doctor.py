#!/usr/bin/env python3
"""Read-only native Gateway checks. Never bootstrap, login or send Telegram."""
import argparse
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import ssl
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

SYSTEM_PATH = '/usr/sbin:/usr/bin:/sbin:/bin'

_spec = importlib.util.spec_from_file_location('native_registration', Path(__file__).with_name('register-worker.py'))
_registration = importlib.util.module_from_spec(_spec)
_bytecode_setting = sys.dont_write_bytecode
sys.dont_write_bytecode = True
try:
    _spec.loader.exec_module(_registration)
finally:
    sys.dont_write_bytecode = _bytecode_setting

DB_CHECK = r"""
const { Client } = require('pg');
(async () => {
  const result = { connected:false, runtime_role:false, roles:false, grants:false,
    migrations:false, nodes:0, fresh_nodes:0, pinned_nodes:0, worker_rows:[] };
  const client = new Client({connectionString:process.env.DATABASE_URL,
    connectionTimeoutMillis:3000, statement_timeout:3000, query_timeout:4000});
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    result.connected = true;
    const me = await client.query('SELECT current_user AS name');
    result.runtime_role = me.rows[0]?.name === 'zt_app';
    const roles = await client.query(`SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin
      FROM pg_roles WHERE rolname IN ('zt_admin','zt_app','zt_maintenance')`);
    result.roles = roles.rowCount === 3 && ['zt_app','zt_maintenance'].every(name =>
      roles.rows.some(row => row.rolname === name && row.rolcanlogin
        && !row.rolsuper && !row.rolcreaterole && !row.rolcreatedb));
    const grants = await client.query(`SELECT
      has_table_privilege(current_user,'public.nodes','SELECT') AS node_read,
      has_table_privilege(current_user,'public.nodes','INSERT') AS node_insert,
      has_table_privilege(current_user,'public.audit_logs','INSERT') AS audit_insert,
      has_table_privilege(current_user,'public.audit_logs','UPDATE') AS audit_update,
      has_table_privilege(current_user,'public.audit_logs','DELETE') AS audit_delete,
      has_table_privilege(current_user,'public.schema_migrations','INSERT') AS ddl_write,
      has_function_privilege(current_user,'public.drop_old_metrics_partitions(integer)','EXECUTE') AS retention`);
    const g = grants.rows[0];
    result.grants = g.node_read && g.node_insert && g.audit_insert
      && !g.audit_update && !g.audit_delete && !g.ddl_write && !g.retention;
    const expected = JSON.parse(process.env.EXPECTED_MIGRATIONS);
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(row => row.name));
    result.migrations = expected.length > 0 && expected.every(name => applied.has(name));
    const rows = (await client.query(`SELECT name, host(ip_address) AS ip,
      EXTRACT(EPOCH FROM clock_timestamp() - last_seen)::double precision AS age,
      host_key_fingerprint ~ '^SHA256:[A-Za-z0-9+/]{43}$' AS pinned
      FROM nodes WHERE NOT is_token_revoked ORDER BY name`)).rows;
    result.worker_rows = rows;
    result.nodes = rows.length;
    result.fresh_nodes = rows.filter(row => typeof row.age === 'number'
      && row.age >= 0 && row.age < Number(process.env.STALE_SECONDS)).length;
    result.pinned_nodes = rows.filter(row => row.pinned === true).length;
    await client.query('ROLLBACK');
  } catch {} finally { await client.end().catch(() => {}); }
  console.log(JSON.stringify(result));
})().catch(() => { console.log(JSON.stringify({connected:false})); });
"""


def inspect(command, *, input=None, cwd=None, env=None, timeout=12):
    try:
        result = subprocess.run(command, input=input, cwd=cwd, env=env, text=True,
                                capture_output=True, timeout=timeout, check=False)
        return result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def ready(url, *, https=False, timeout=4):
    """Probe the local demo endpoint; no ambient proxy or redirect following."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    handlers = [urllib.request.ProxyHandler({}), NoRedirect()]
    if https:
        handlers.append(urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))
    try:
        with urllib.request.build_opener(*handlers).open(url, timeout=timeout) as response:
            payload = response.read(8193)
            if response.status != 200 or len(payload) > 8192:
                return False
            data = json.loads(payload)
            return isinstance(data, dict) and data.get('status') == 'READY' \
                and isinstance(data.get('database'), dict) and data['database'].get('healthy') is True
    except urllib.error.HTTPError as error:
        error.close()
        return False
    except (OSError, ValueError, TypeError):
        return False


def listener_addresses(output, port):
    addresses = []
    for line in (output or '').splitlines():
        fields = line.split()
        if len(fields) < 4:
            continue
        local = fields[3]
        host, separator, raw_port = local.rpartition(':')
        if separator and raw_port == str(port):
            addresses.append(host.strip('[]'))
    return addresses


def loopback_listener(output, port):
    """Require listeners for this port to be IPv4 loopback, with no wildcard."""
    addresses = listener_addresses(output, port)
    return bool(addresses) and all(address == '127.0.0.1' for address in addresses)


def chain_rules(output, chain):
    """Parse only the named project's chain, without dumping the host firewall."""
    if output is None:
        raise ValueError('Firewall inspection unavailable.')
    rules = []
    for line in output.splitlines():
        parts = shlex.split(line)
        if len(parts) >= 2 and parts[:2] == ['-A', chain]:
            rule = parts[2:]
            # iptables -S inserts the TCP matcher even when the CLI omitted it.
            rule = [value for index, value in enumerate(rule)
                    if not (value == '-m' and index + 1 < len(rule) and rule[index + 1] == 'tcp')
                    and not (value == 'tcp' and index > 0 and rule[index - 1] == '-m')]
            rules.append(rule)
    return rules


def project_firewall_ok(input_output, forward_output, input_chain, forward_chain,
                        prerouting_output, prerouting_chain, interface, api_port, wg_ip):
    try:
        incoming = chain_rules(input_output, 'INPUT')
        forwarding = chain_rules(forward_output, 'FORWARD')
        own_input = chain_rules(input_chain, 'ZTNATIVE_IN')
        own_forward = chain_rules(forward_chain, 'ZTNATIVE_FW')
        prerouting = chain_rules(prerouting_output, 'PREROUTING')
        own_pre = chain_rules(prerouting_chain, 'ZTNATIVE_PRE')
        if ['-i', interface, '-j', 'ZTNATIVE_IN'] not in incoming \
                or ['-i', interface, '-j', 'ZTNATIVE_FW'] not in forwarding:
            return False
        if len(own_input) != 3 or own_forward != [['-j', 'DROP']]:
            return False
        drop_nonlocal = ['-m', 'addrtype', '!', '--dst-type', 'LOCAL', '-j', 'DROP']
        if not prerouting or prerouting[0] != ['-i', interface, '-j', 'ZTNATIVE_PRE'] \
                or len(own_pre) != 4 or own_pre[0] != drop_nonlocal:
            return False
        established = own_input[0]
        if len(established) != 6 or established[:3] != ['-m', 'conntrack', '--ctstate'] \
                or set(established[3].split(',')) != {'ESTABLISHED', 'RELATED'} \
                or established[4:] != ['-j', 'ACCEPT']:
            return False
        api_rule = own_input[1]
        if len(api_rule) != 8 or api_rule[0] != '-d' \
                or ipaddress.ip_network(api_rule[1]) != ipaddress.ip_network(wg_ip + '/32'):
            return False
        return api_rule[2:] == ['-p', 'tcp', '--dport', str(api_port), '-j', 'ACCEPT'] \
            and own_input[2] == ['-j', 'DROP'] \
            and own_pre[1:] == own_input
    except (ValueError, TypeError):
        return False


def peer_index(configuration, *, live=False):
    """Require unique single-host IPv4 AllowedIPs for this deployment's peers."""
    records = []
    if live:
        for line in configuration.splitlines():
            fields = line.split(None, 1)
            if len(fields) != 2:
                raise ValueError('Malformed live WireGuard peer.')
            records.append((fields[0], fields[1]))
    else:
        for section in re.split(r'(?m)^\s*\[Peer\]\s*$', configuration)[1:]:
            values = re.findall(r'(?m)^\s*(PublicKey|AllowedIPs)\s*=\s*([^#\r\n]+)', section)
            if len(values) != 2 or len(dict(values)) != 2:
                raise ValueError('Malformed configured WireGuard peer.')
            values = dict(values)
            records.append((values['PublicKey'].strip(), values['AllowedIPs'].strip()))
    addresses, keys = {}, set()
    for public, allowed in records:
        _registration.wg_key(public)
        network = ipaddress.ip_network(allowed.strip(), strict=True)
        if network.version != 4 or network.prefixlen != 32 or str(network.network_address) in addresses or public in keys:
            raise ValueError('Overlapping, repeated or non-host WireGuard AllowedIPs.')
        addresses[str(network.network_address)] = public
        keys.add(public)
    return addresses


def worker_consistency(rows, configuration, allowed_output, handshake_output, install, stale, now=None):
    result = {'identity': False, 'fresh': False, 'handshake': False}
    if not isinstance(rows, list) or not rows:
        return result
    try:
        configured = peer_index(configuration)
        live = peer_index(allowed_output, live=True)
        addresses = [_registration.worker_ip(row['ip'], install) for row in rows]
        result['identity'] = len(set(addresses)) == len(rows) and configured == live \
            and all(address in configured for address in addresses)
        result['fresh'] = all(isinstance(row.get('age'), (int, float)) and not isinstance(row['age'], bool)
                              and 0 <= row['age'] < stale and row.get('pinned') is True for row in rows)
        handshakes = {}
        for line in handshake_output.splitlines():
            public, at = line.split()
            _registration.wg_key(public)
            if public in handshakes:
                raise ValueError('Repeated handshake peer.')
            handshakes[public] = int(at)
        now = time.time() if now is None else now
        result['handshake'] = result['identity'] and all(
            configured[address] in handshakes and 0 <= now - handshakes[configured[address]] <= 180
            for address in addresses)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {'identity': False, 'fresh': False, 'handshake': False}
    return result


def diagnose(config_dir, *, require_worker=False):
    checks = []

    def check(ok, label):
        checks.append({'ok': bool(ok), 'check': label})

    try:
        install, config_dir = _registration.load_install(config_dir)
    except (OSError, ValueError, KeyError, TypeError):
        return {'scope': 'native-readonly', 'ok': False, 'checks': [{'ok': False, 'check': 'Installation record is readable and valid'}]}
    check(os.geteuid() == 0, 'Run read-only doctor as root to inspect protected files and WireGuard')
    settings = {}
    for filename in ('gateway.env', 'admin.env', 'login.json'):
        try:
            path = _registration.private_file(config_dir / filename)
            check(path.stat().st_uid == 0, f'{filename} is a root-owned regular file with mode 0600')
            if filename == 'gateway.env':
                settings = _registration.read_env(path)
        except (OSError, ValueError):
            check(False, f'{filename} is a root-owned regular file with mode 0600')

    node_path = install['node_path']
    caddy_path = str(Path(install['install_dir']) / 'runtime/caddy/caddy')
    pg_path = str(Path(install['pg_bin_dir']) / 'postgres')
    runtime_env = {'PATH': SYSTEM_PATH, 'LD_LIBRARY_PATH': ':'.join(install.get('pg_lib_dirs', []))}
    check(bool(re.fullmatch(r'v22\.[0-9.]+', inspect([node_path, '--version'], env=runtime_env) or '')), 'Bundled Node 22 runs')
    check(bool(inspect([caddy_path, 'version'])), 'Bundled Caddy runs')
    check('16.' in (inspect([pg_path, '--version'], env=runtime_env) or ''), 'Bundled PostgreSQL 16 runs')
    dashboard = Path(install['install_dir']) / 'app/dashboard/index.html'
    check(dashboard.is_file(), 'Built React index.html exists')
    check((Path(install['gateway_dir']) / 'dist/server.js').is_file(), 'Built Gateway entry point exists')

    for unit in install.get('units', []):
        check(inspect(['systemctl', 'is-active', unit]) == 'active', f'{unit} is active')
    check(set(install.get('units', [])) == {f'zt-native-{name}.service' for name in ('wireguard', 'postgres', 'gateway', 'caddy')},
          'Installation declares all four core services')

    try:
        key_path = _registration.private_file(install['bastion_key'], 0o400)
        app_user = pwd.getpwnam(install['app_os_user'])
        readable = inspect(['runuser', '-u', install['app_os_user'], '--', 'test', '-r', str(key_path)])
        check(key_path.stat().st_uid == app_user.pw_uid and readable is not None,
              'Application user can read its own Bastion private key with mode 0400')
    except (OSError, ValueError, KeyError):
        check(False, 'Application user can read its own Bastion private key with mode 0400')

    interface = install['wg_interface']
    listen = inspect(['wg', 'show', interface, 'listen-port'])
    check(listen == str(install['wg_port']), 'WireGuard listens on the configured UDP port')
    addresses = inspect(['ip', '-j', 'address', 'show', 'dev', interface])
    try:
        assigned = any(item.get('local') == install['wg_ip'] for link in json.loads(addresses or '[]')
                       for item in link.get('addr_info', []))
    except (ValueError, TypeError):
        assigned = False
    check(assigned, 'WireGuard interface has the configured overlay IPv4')
    check(bool(_safe_public_key(inspect(['wg', 'show', interface, 'public-key']))), 'WireGuard has a valid public identity')
    try:
        wg_config = _registration.private_file(install['wg_config'])
        check(wg_config.stat().st_uid == 0, 'WireGuard private configuration is root-owned with mode 0600')
        configuration = wg_config.read_text(encoding='utf-8')
    except (OSError, ValueError):
        configuration = ''
        check(False, 'WireGuard private configuration is root-owned with mode 0600')
    firewall = [inspect(['iptables', '-w', '5', '-S', chain])
                for chain in ('INPUT', 'FORWARD', 'ZTNATIVE_IN', 'ZTNATIVE_FW')]
    firewall += [inspect(['iptables', '-w', '5', '-t', 'mangle', '-S', chain])
                 for chain in ('PREROUTING', 'ZTNATIVE_PRE')]
    check(project_firewall_ok(*firewall, interface, install['api_port'], install['wg_ip']),
          'Project firewall guards host access and forwarding before filter, permitting only the WG API and replies')

    listeners = inspect(['ss', '-H', '-lnt'])
    check(loopback_listener(listeners, install['db_port']), 'PostgreSQL TCP listener is only 127.0.0.1')
    api_addresses = listener_addresses(listeners, install['api_port'])
    check(bool(api_addresses) and all(address == install['wg_ip'] for address in api_addresses),
          'Gateway API listener is only the overlay IPv4')
    web_addresses = listener_addresses(listeners, install['web_port'])
    check(bool(web_addresses) and all(address in ('127.0.0.1', '::1') for address in web_addresses),
          'Caddy HTTPS listener is only loopback')
    api_url = f'http://{install["wg_ip"]}:{install["api_port"]}/readyz'
    check(ready(api_url), 'Gateway API /readyz confirms PostgreSQL healthy')
    check(ready(f'https://localhost:{install["web_port"]}/readyz', https=True),
          'Loopback Caddy HTTPS forwards /readyz (demo CA trust is not certified)')

    migrations = sorted(path.name for path in (Path(install['gateway_dir']) / 'migrations').glob('*.sql'))
    env = {'PATH': SYSTEM_PATH, 'NODE_ENV': 'production', 'DATABASE_URL': settings.get('DATABASE_URL', ''),
           'EXPECTED_MIGRATIONS': json.dumps(migrations), 'STALE_SECONDS': settings.get('NODE_STALE_THRESHOLD_SECONDS', '15')}
    if install.get('pg_lib_dirs'):
        env['LD_LIBRARY_PATH'] = ':'.join(install['pg_lib_dirs'])
    raw = inspect(['runuser', '-u', install['app_os_user'], '--', node_path, '-'], input=DB_CHECK,
                  cwd=install['gateway_dir'], env=env)
    try:
        database = json.loads(raw or '{}')
    except ValueError:
        database = {}
    if not isinstance(database, dict):
        database = {}
    for name, label in (('connected', 'Runtime role connects to PostgreSQL'),
                        ('runtime_role', 'Gateway uses zt_app, not admin DB credentials'),
                        ('roles', 'Admin/app/maintenance roles exist and app/maintenance are unprivileged'),
                        ('grants', 'Runtime audit, schema and retention privileges are restricted'),
                        ('migrations', 'All packaged schema migrations are applied')):
        check(database.get(name) is True, label)
    if require_worker:
        allowed = inspect(['wg', 'show', interface, 'allowed-ips'])
        handshakes = inspect(['wg', 'show', interface, 'latest-handshakes'])
        consistency = worker_consistency(database.get('worker_rows'), configuration, allowed, handshakes,
                                         install, int(settings.get('NODE_STALE_THRESHOLD_SECONDS', '15')))
        check(consistency['fresh'], 'All active registered Workers have recent heartbeat and SSH pins')
        check(consistency['identity'], 'DB Worker VPN IPs match configured/live WireGuard public keys and AllowedIPs')
        check(consistency['handshake'], 'Each DB Worker matched peer handshook within 180 seconds')
    return {'scope': 'native-readonly', 'ok': all(row['ok'] for row in checks), 'checks': checks,
            'workers': database.get('nodes', 0),
            'limits': 'No login/logout, DB writes or Telegram calls. Only project firewall chains are checked, not the entire host policy. SSH/PTY authentication, reboot, independent Internet and ARM resource use need separate runtime evidence.'}


def _safe_public_key(value):
    try:
        return _registration.wg_key(value)
    except (ValueError, TypeError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config-dir', type=Path, default=Path('/etc/zt-serverops-native'))
    parser.add_argument('--require-worker', action='store_true', help='Also require fresh, pinned Workers and recent WG handshakes.')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    report = diagnose(args.config_dir, require_worker=args.require_worker)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for row in report['checks']:
            print(f'[{"OK" if row["ok"] else "FAIL"}] {row["check"]}')
        print(report.get('limits', 'Installation record unavailable; no state was changed.'))
        print(f'Issues: {sum(not row["ok"] for row in report["checks"])}')
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError):
        raise SystemExit('Read-only diagnosis stopped; check protected paths and configuration. Secret output was suppressed.') from None
