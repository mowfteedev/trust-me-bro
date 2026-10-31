#!/usr/bin/env python3
"""Install the tested Debian 12 ARM64 lab bundle without Docker."""
import argparse
import grp
import ipaddress
import json
import os
import pathlib
import platform
import pwd
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import time
import urllib.request

KIT = pathlib.Path(__file__).resolve().parent.parent
UNITS = [f'zt-native-{name}.service' for name in ('wireguard', 'postgres', 'gateway', 'caddy')]
USERS = ('zt-native-db', 'zt-native-app', 'zt-native-web')
BASE_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}


class InstallError(Exception):
    pass


def write(path, text, mode=0o600, owner=None):
    with open(path, 'x', encoding='utf-8') as stream:
        stream.write(text)
    os.chmod(path, mode)
    if owner:
        user = pwd.getpwnam(owner)
        os.chown(path, user.pw_uid, user.pw_gid)


def run(args, *, env=None, cwd=None, input_text=None, timeout=60):
    result = subprocess.run(args, input=input_text, text=True, capture_output=True,
                            env={**BASE_ENV, **(env or {})}, cwd=cwd, timeout=timeout)
    if result.returncode:
        raise InstallError(f'Lệnh {pathlib.Path(args[0]).name} thất bại (exit {result.returncode}); không tiếp tục khởi động.')
    return result.stdout


def check_port(port, kind, address='0.0.0.0'):
    with socket.socket(socket.AF_INET, kind) as sock:
        try:
            sock.bind((address, port))
        except OSError as error:
            raise InstallError(f'Cổng {port} đang được dùng hoặc không bind được; giữ nguyên dịch vụ hiện có.') from error


def safe_path(value):
    path = pathlib.Path(value)
    if not path.is_absolute() or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(path)) or '..' in path.parts:
        raise argparse.ArgumentTypeError('Đường dẫn phải tuyệt đối, không có khoảng trắng hoặc ký tự đặc biệt.')
    return path


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install-dir', type=safe_path, default=pathlib.Path('/opt/zt-serverops-native'))
    parser.add_argument('--config-dir', type=safe_path, default=pathlib.Path('/etc/zt-serverops-native'))
    parser.add_argument('--data-dir', type=safe_path, default=pathlib.Path('/var/lib/zt-serverops-native'))
    parser.add_argument('--wg-address', default='10.100.0.1/24')
    parser.add_argument('--wg-port', type=int, default=51820)
    parser.add_argument('--api-port', type=int, default=3100)
    parser.add_argument('--db-port', type=int, default=55432)
    parser.add_argument('--web-port', type=int, default=8443)
    parser.add_argument('--preflight-only', action='store_true', help='Chỉ kiểm tra, không cài đặt hoặc thay cấu hình.')
    return parser.parse_args()


def preflight(args):
    if platform.machine() != 'aarch64':
        raise InstallError('Gói này chỉ dành cho Linux aarch64/ARM64; không cài bản ARM lên laptop x86.')
    os_release = dict(line.split('=', 1) for line in pathlib.Path('/etc/os-release').read_text().splitlines() if '=' in line)
    if os_release.get('ID', '').strip('"') != 'debian' or os_release.get('VERSION_ID', '').strip('"') != '12':
        raise InstallError('Gói này đã nhắm Debian 12 ARM64 (bao gồm Armbian nền Debian 12).')
    if not pathlib.Path('/run/systemd/system').is_dir():
        raise InstallError('Cần máy boot bằng systemd, không chạy installer trong container không có systemd.')
    selinux = pathlib.Path('/sys/fs/selinux/enforce')
    if selinux.exists() and selinux.read_text().strip() != '0':
        raise InstallError('SELinux enforcing chưa được kiểm chứng cho gói này; dừng trước khi cài, không tự tắt SELinux.')
    required = ['systemctl', 'wg', 'wg-quick', 'iptables', 'ip', 'openssl', 'ssh-keygen', 'runuser', 'useradd', 'sha256sum']
    missing = [name for name in required if not shutil.which(name)]
    if missing:
        raise InstallError('Thiếu công cụ: ' + ', '.join(missing) + '. Installer không tự cài package hoặc đổi hệ điều hành.')
    if not (KIT / 'SHA256SUMS').is_file():
        raise InstallError('Thiếu SHA256SUMS; dùng đúng archive đã được dựng và kiểm tra.')
    for name in ('zt-native-wireguard', 'zt-native-postgres'):
        runtime = pathlib.Path('/run') / name
        if runtime.exists() or runtime.is_symlink():
            raise InstallError(f'{runtime} đã tồn tại; không để systemd thay quyền thư mục runtime cũ.')
    for line in (KIT / 'SHA256SUMS').read_text().splitlines():
        parts = line.split(maxsplit=1)
        if len(parts) != 2:
            raise InstallError('Manifest SHA256SUMS không hợp lệ.')
        path = pathlib.PurePosixPath(parts[1].lstrip('*'))
        if path.is_absolute() or '..' in path.parts:
            raise InstallError('Manifest có đường dẫn ngoài gói; từ chối.')
    run(['sha256sum', '--check', '--strict', 'SHA256SUMS'], cwd=KIT)
    for path in (args.install_dir, args.config_dir, args.data_dir):
        if path.exists() or path.is_symlink():
            raise InstallError(f'{path} đã tồn tại; không ghi đè cài đặt hoặc dữ liệu cũ.')
        for parent in path.parents:
            if parent.is_symlink():
                raise InstallError(f'Thư mục cha {parent} là symlink; từ chối ghi ra vị trí khác.')
    if len({str(args.install_dir), str(args.config_dir), str(args.data_dir)}) != 3:
        raise InstallError('Ba thư mục install/config/data phải khác nhau.')
    paths = (args.install_dir, args.config_dir, args.data_dir)
    if any(first in second.parents for first in paths for second in paths if first != second):
        raise InstallError('Ba thư mục install/config/data không được lồng nhau.')
    for name in USERS:
        try:
            pwd.getpwnam(name)
        except KeyError:
            pass
        else:
            raise InstallError(f'Tài khoản {name} đã tồn tại; cần kiểm tra cài đặt cũ trước.')
        try:
            grp.getgrnam(name)
        except KeyError:
            pass
        else:
            raise InstallError(f'Nhóm {name} đã tồn tại; cần kiểm tra bản cài trước.')
    for unit in UNITS:
        for parent in ('/etc/systemd/system', '/run/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system'):
            path = pathlib.Path(parent) / unit
            if path.exists() or path.is_symlink():
                raise InstallError(f'Unit {unit} đã tồn tại; không thay dịch vụ cũ.')
    if pathlib.Path('/etc/wireguard/ztgw0.conf').exists() or pathlib.Path('/etc/wireguard/ztgw0.conf').is_symlink():
        raise InstallError('/etc/wireguard/ztgw0.conf đã tồn tại; không ghi đè khóa/config WireGuard.')
    if pathlib.Path('/etc/wireguard').is_symlink():
        raise InstallError('/etc/wireguard là symlink; từ chối ghi cấu hình ngoài vị trí đã chọn.')
    if subprocess.run(['ip', 'link', 'show', 'ztgw0'], capture_output=True).returncode == 0:
        raise InstallError('Interface ztgw0 đã tồn tại; không thay mạng đang chạy.')
    for table, chains in (('filter', ('ZTNATIVE_IN', 'ZTNATIVE_FW')), ('mangle', ('ZTNATIVE_PRE',))):
        try:
            rules = run(['iptables', '-w', '5', '-t', table, '-S'])
        except InstallError as error:
            raise InstallError(f'Không đọc được bảng firewall {table}; dừng trước khi cài: {error}') from error
        for chain in chains:
            if any(line.split()[:2] == ['-N', chain] for line in rules.splitlines()):
                raise InstallError(f'Firewall chain {chain} đã tồn tại; kiểm tra bản cài trước.')
    try:
        address = ipaddress.IPv4Interface(args.wg_address)
    except ValueError as error:
        raise InstallError('--wg-address cần IPv4/CIDR hợp lệ.') from error
    private = [ipaddress.IPv4Network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
    if not any(address.network.subnet_of(network) for network in private) or address.network.prefixlen > 30:
        raise InstallError('Dải WireGuard phải là subnet riêng RFC1918 có chỗ cho Worker.')
    if address.ip in (address.network.network_address, address.network.broadcast_address):
        raise InstallError('IP Gateway không được là địa chỉ mạng/broadcast.')
    routes = json.loads(run(['ip', '-j', '-4', 'route', 'show', 'table', 'all']))
    for route in routes:
        destination = route.get('dst', 'default')
        if destination == 'default':
            continue
        try:
            existing = ipaddress.IPv4Network(destination, strict=False)
        except ValueError:
            continue
        if existing.overlaps(address.network):
            raise InstallError(f'Dải WireGuard {address.network} trùng route {existing}; chọn dải thử khác.')
    ports = (args.wg_port, args.api_port, args.db_port, args.web_port)
    if any(port < 1024 or port > 65535 for port in ports) or len(set(ports)) != 4:
        raise InstallError('Các cổng phải khác nhau và nằm trong 1024–65535.')
    check_port(args.api_port, socket.SOCK_STREAM)
    check_port(args.db_port, socket.SOCK_STREAM, '127.0.0.1')
    check_port(args.web_port, socket.SOCK_STREAM, '127.0.0.1')
    check_port(args.web_port, socket.SOCK_DGRAM, '127.0.0.1')
    check_port(args.wg_port, socket.SOCK_DGRAM)
    pg_root = KIT / 'runtime/postgres'
    pg_bin = pg_root / 'usr/lib/postgresql/16/bin'
    pg_lib = ':'.join(str(pg_root / suffix) for suffix in ('usr/lib/aarch64-linux-gnu', 'lib/aarch64-linux-gnu'))
    required_files = [KIT / 'runtime/node/bin/node', KIT / 'runtime/caddy/caddy', pg_bin / 'postgres', pg_bin / 'initdb',
                      pg_bin / 'pg_isready', pg_root / 'usr/share/postgresql/16/extension/pgcrypto.control',
                      KIT / 'app/gateway/dist/server.js', KIT / 'app/gateway/node_modules/pg/package.json',
                      KIT / 'app/dashboard/index.html']
    missing_files = [str(path.relative_to(KIT)) for path in required_files if not path.is_file()]
    if missing_files:
        raise InstallError('Gói thiếu: ' + ', '.join(missing_files))
    node_version = run([str(KIT / 'runtime/node/bin/node'), '--version'], env={'LD_LIBRARY_PATH': pg_lib}).strip()
    pg_version = run([str(pg_bin / 'postgres'), '--version'], env={'LD_LIBRARY_PATH': pg_lib}).strip()
    caddy_version = run([str(KIT / 'runtime/caddy/caddy'), 'version']).strip()
    if not node_version.startswith('v22.') or 'PostgreSQL) 16.' not in pg_version or not caddy_version.startswith('v2.'):
        raise InstallError('Phiên bản runtime không khớp Node22/PostgreSQL16/Caddy2 của gói.')
    available = shutil.disk_usage(args.install_dir.parent if args.install_dir.parent.exists() else '/').free
    package_size = sum(path.stat().st_size for path in KIT.rglob('*') if path.is_file() and not path.is_symlink())
    if available < package_size + 512 * 1024 * 1024:
        raise InstallError('Không đủ chỗ cho bản cài và ít nhất 512MiB dữ liệu dự trù; không tự xóa tệp.')
    return address


def make_dir(path, mode=0o755, owner=None):
    path.mkdir(parents=True, exist_ok=False)
    os.chmod(path, mode)
    if owner:
        user = pwd.getpwnam(owner)
        os.chown(path, user.pw_uid, user.pw_gid)


def render(template, values):
    text = (KIT / 'templates' / template).read_text()
    for name, value in values.items():
        text = text.replace('@' + name + '@', str(value))
    if re.search(r'@[A-Z_]+@', text):
        raise InstallError(f'Template {template} còn giá trị chưa điền.')
    return text


def wait_postgres(pg_bin, pg_lib, port):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        probe = subprocess.run([str(pg_bin / 'pg_isready'), '-h', '127.0.0.1', '-p', str(port), '-U', 'zt_admin', '-d', 'postgres'],
                               capture_output=True, env={**BASE_ENV, 'LD_LIBRARY_PATH': pg_lib}, timeout=5)
        if probe.returncode == 0:
            return
        time.sleep(0.25)
    raise InstallError('PostgreSQL chưa nhận kết nối sau 60s; xem journalctl -u zt-native-postgres.')


def wait_ready(url, timeout=60):
    context = ssl._create_unverified_context()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with opener.open(url, timeout=3) as response:
                body = response.read(4097)
                if response.status == 200 and len(body) <= 4096 and json.loads(body).get('status') == 'READY':
                    return
        except (OSError, ValueError):
            pass
        time.sleep(0.25)
    raise InstallError('Readiness chưa đạt; xem journalctl của các unit zt-native. Không coi bản cài là đã chạy được.')


def install(args, address):
    if os.geteuid() != 0:
        raise InstallError('Cài đặt cần sudo/root để tạo user và service riêng. --preflight-only chỉ đọc.')
    os.umask(0o077)
    print('Đã kiểm tra gói và điều kiện nền; bắt đầu tạo bản cài native riêng.')
    shutil.copytree(KIT, args.install_dir, symlinks=True)
    os.chmod(args.install_dir, 0o755)
    for path in args.install_dir.rglob('*'):
        if path.is_dir() and not path.is_symlink():
            os.chmod(path, path.stat().st_mode | 0o555)
    for name in USERS:
        run(['useradd', '--system', '--user-group', '--home-dir', str(args.data_dir / name), '--no-create-home', '--shell', '/usr/sbin/nologin', name])
    make_dir(args.config_dir)
    make_dir(args.data_dir)
    make_dir(args.data_dir / 'postgres', 0o700, 'zt-native-db')
    make_dir(args.data_dir / 'keys', 0o700, 'zt-native-app')
    make_dir(args.data_dir / 'caddy', 0o700, 'zt-native-web')
    make_dir(args.data_dir / 'bundles', 0o700)
    for path in (args.config_dir, args.data_dir):
        os.chmod(path, 0o755)
    node = args.install_dir / 'runtime/node/bin/node'
    gateway_dir = args.install_dir / 'app/gateway'
    pg_root = args.install_dir / 'runtime/postgres'
    pg_bin = pg_root / 'usr/lib/postgresql/16/bin'
    pg_lib_dirs = [str(pg_root / path) for path in ('usr/lib/aarch64-linux-gnu', 'lib/aarch64-linux-gnu')]
    pg_lib = ':'.join(pg_lib_dirs)
    wg_config = pathlib.Path('/etc/wireguard/ztgw0.conf')
    bastion = args.data_dir / 'keys/bastion_id_ed25519'
    run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(bastion)])
    app_user = pwd.getpwnam('zt-native-app')
    os.chown(bastion, app_user.pw_uid, app_user.pw_gid)
    os.chmod(bastion, 0o400)
    os.chmod(bastion.with_suffix('.pub'), 0o644)
    db_password, app_password, maintenance_password = (secrets.token_hex(24) for _ in range(3))
    base = f'127.0.0.1:{args.db_port}/zt_serverops'
    urls = {'MIGRATION_DATABASE_URL': f'postgresql://zt_admin:{db_password}@{base}',
            'DATABASE_URL': f'postgresql://zt_app:{app_password}@{base}',
            'MAINTENANCE_DATABASE_URL': f'postgresql://zt_maintenance:{maintenance_password}@{base}'}
    app_env = {'NODE_ENV': 'production', 'NODE_OPTIONS': '--network-family-autoselection-attempt-timeout=2500',
               'LD_LIBRARY_PATH': pg_lib,
               'GATEWAY_HOST': str(address.ip), 'GATEWAY_PORT': str(args.api_port), 'TRUSTED_PROXY_IP': str(address.ip),
               'JWT_SECRET': secrets.token_hex(32), 'JWT_EXPIRES_IN': '1d', 'DATABASE_URL': urls['DATABASE_URL'],
               'DB_MAX_CONNECTIONS': '5', 'DB_IDLE_TIMEOUT_MS': '30000', 'BASTION_SSH_KEY_PATH': str(bastion),
               'BASTION_DEFAULT_USER': 'ztuser', 'BASTION_CONNECT_TIMEOUT_MS': '10000', 'SWEEPER_INTERVAL_MS': '5000',
               'NODE_STALE_THRESHOLD_SECONDS': '15', 'NODE_OFFLINE_THRESHOLD_SECONDS': '30',
               'CPU_ALERT_THRESHOLD_PERCENT': '85', 'CPU_RECOVERY_THRESHOLD_PERCENT': '75',
               'TELEGRAM_MODE': 'dry-run', 'WG_GATEWAY_IP': str(address.ip), 'WG_LISTEN_PORT': str(args.wg_port)}
    write(args.config_dir / 'gateway.env', ''.join(f'{key}={value}\n' for key, value in app_env.items()))
    write(args.config_dir / 'admin.env', ''.join(f'{key}={value}\n' for key, value in urls.items()))
    login = {'admin': {'username': 'demo-admin', 'password': secrets.token_urlsafe(24)},
             'viewer': {'username': 'demo-viewer', 'password': secrets.token_urlsafe(24)}}
    write(args.config_dir / 'login.json', json.dumps(login, indent=2) + '\n')
    wg_key = run(['wg', 'genkey']).strip()
    wg_public = run(['wg', 'pubkey'], input_text=wg_key + '\n').strip()
    wg_config.parent.mkdir(mode=0o700, exist_ok=True)
    firewall = args.install_dir / 'scripts/firewall.sh'
    write(wg_config, f'[Interface]\nAddress = {address}\nListenPort = {args.wg_port}\nPrivateKey = {wg_key}\nMTU = 1200\n'
          f'PreUp = {firewall} up %i {args.api_port} {address.ip}\nPostDown = {firewall} down %i {args.api_port}\n')
    values = {'INSTALL_DIR': args.install_dir, 'CONFIG_DIR': args.config_dir, 'DATA_DIR': args.data_dir,
              'WG_CONFIG': wg_config, 'WG_QUICK': shutil.which('wg-quick'), 'WG_IP': address.ip,
              'API_PORT': args.api_port, 'WEB_PORT': args.web_port, 'PG_BIN': pg_bin, 'PG_LIB_PATH': pg_lib}
    metadata = {'install_dir': str(args.install_dir), 'config_dir': str(args.config_dir), 'data_dir': str(args.data_dir),
                'wg_interface': 'ztgw0', 'wg_address': str(address), 'wg_ip': str(address.ip), 'wg_port': args.wg_port,
                'api_port': args.api_port, 'db_port': args.db_port, 'web_port': args.web_port,
                'wg_config': str(wg_config), 'wg_public_key': wg_public, 'node_path': str(node),
                'gateway_dir': str(gateway_dir), 'pg_bin_dir': str(pg_bin), 'pg_lib_dirs': pg_lib_dirs,
                'db_name': 'zt_serverops', 'db_os_user': 'zt-native-db', 'app_os_user': 'zt-native-app',
                'web_os_user': 'zt-native-web', 'bastion_key': str(bastion), 'units': UNITS}
    write(args.config_dir / 'install.json', json.dumps(metadata, indent=2) + '\n', 0o644)
    write(args.config_dir / 'Caddyfile', render('Caddyfile', values), 0o644)
    for unit in UNITS:
        write(pathlib.Path('/etc/systemd/system') / unit, render(unit, values), 0o644)
    secret_file = args.data_dir / 'pg-init-password.tmp'
    write(secret_file, db_password + '\n', owner='zt-native-db')
    try:
        run(['runuser', '-u', 'zt-native-db', '--', '/usr/bin/env', 'LD_LIBRARY_PATH=' + pg_lib,
             str(pg_bin / 'initdb'), '-D', str(args.data_dir / 'postgres'), '-L', str(pg_root / 'usr/share/postgresql/16'),
             '--username=zt_admin', '--encoding=UTF8', '--locale=C.UTF-8', '--auth-local=peer',
             '--auth-host=scram-sha-256', '--pwfile=' + str(secret_file)], cwd='/', timeout=120)
    finally:
        secret_file.unlink(missing_ok=True)
    pg_config = args.data_dir / 'postgres/postgresql.conf'
    with pg_config.open('a') as stream:
        stream.write(f"\nlisten_addresses = '127.0.0.1'\nport = {args.db_port}\nunix_socket_directories = '/run/zt-native-postgres'\n"
                     "shared_buffers = '32MB'\nmax_connections = 30\nwork_mem = '2MB'\nmaintenance_work_mem = '16MB'\n"
                     "max_wal_size = '256MB'\nmin_wal_size = '64MB'\ntimezone = 'UTC'\npassword_encryption = 'scram-sha-256'\n")
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', *UNITS])
    run(['systemctl', 'start', 'zt-native-postgres.service'])
    wait_postgres(pg_bin, pg_lib, args.db_port)
    print('PostgreSQL riêng đã nhận kết nối; tạo DB, migration và cấp quyền.')
    create_db = """const {Client}=require('pg');
(async()=>{const c=new Client({connectionString:process.env.MIGRATION_DATABASE_URL,connectionTimeoutMillis:5000});
try{await c.connect();await c.query('CREATE DATABASE zt_serverops OWNER zt_admin');}finally{await c.end();}})()
.catch(()=>{console.error('Không tạo được DB riêng; kiểm tra PostgreSQL.');process.exitCode=1;});"""
    run([str(node), '-e', create_db], cwd=gateway_dir,
        env={'MIGRATION_DATABASE_URL': urls['MIGRATION_DATABASE_URL'].rsplit('/', 1)[0] + '/postgres', 'LD_LIBRARY_PATH': pg_lib})
    run([str(node), 'dist/scripts/run-migrations.js'], cwd=gateway_dir, env={**urls, 'LD_LIBRARY_PATH': pg_lib}, timeout=120)
    run([str(node), 'dist/scripts/provision-roles.js'], cwd=gateway_dir, env={**urls, 'LD_LIBRARY_PATH': pg_lib})
    bootstrap = """const fs=require('fs');const {Client}=require('pg');const {hashPassword}=require('./dist/utils/crypto.js');
(async()=>{const users=JSON.parse(fs.readFileSync(0,'utf8'));const c=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});
try{await c.connect();await c.query('BEGIN');
for(const [key,role]of[['admin','ADMIN'],['viewer','VIEWER']]){
await c.query('INSERT INTO users (username,password_hash,role,is_active) VALUES ($1,$2,$3,TRUE)',[users[key].username,hashPassword(users[key].password),role]);}
await c.query('COMMIT');}finally{await c.end();}})()
.catch(()=>{console.error('Không tạo được tài khoản demo riêng; không ghi đè người dùng.');process.exitCode=1;});"""
    run([str(node), '-e', bootstrap], cwd=gateway_dir, env={'DATABASE_URL': urls['DATABASE_URL'], 'LD_LIBRARY_PATH': pg_lib},
        input_text=json.dumps(login))
    run(['systemctl', 'start', 'zt-native-wireguard.service', 'zt-native-gateway.service', 'zt-native-caddy.service'])
    wait_ready(f'http://{address.ip}:{args.api_port}/readyz')
    wait_ready(f'https://localhost:{args.web_port}/readyz')
    print('API và HTTPS trả READY. Bản cài đã khởi động, chưa thay kiểm thử Worker/SSH.')
    print(f'Tài khoản và mật khẩu ở {args.config_dir}/login.json (root0600); không được đóng gói tệp này để chia sẻ.')
    print(f'Kiểm tra tiếp: sudo python3 {args.install_dir}/scripts/doctor.py --config-dir {args.config_dir}')


def main():
    args = arguments()
    try:
        address = preflight(args)
        if args.preflight_only:
            print('Preflight đạt; chưa tạo user/file/interface hoặc thay dịch vụ.')
            return 0
        install(args, address)
        return 0
    except (InstallError, OSError, subprocess.TimeoutExpired) as error:
        print('CHƯA CÀI XONG: ' + str(error), file=sys.stderr)
        print('Không xóa dữ liệu hoặc đổi cấu hình khác để che lỗi. Nếu đã cài một phần, kiểm tra các thư mục/unit zt-native trước khi thử lại.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
