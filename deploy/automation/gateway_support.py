"""Bounded local installation primitives; no shell evaluation or credential output."""
from pathlib import Path
import ipaddress
import json
import os
import re
import stat
import subprocess
import tempfile
import urllib.parse


class InstallError(RuntimeError):
    pass


def guarded_path(path):
    path = Path(os.path.abspath(path))
    for item in [path, *path.parents]:
        if item.is_symlink():
            raise InstallError('Refusing a symlink in an installation path.')
    return path


def private_read(path):
    path = guarded_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 65536:
            raise InstallError('Configuration must be a private regular file, at most64KiB.')
        return os.read(fd, 65537).decode()
    finally:
        os.close(fd)


def atomic_write(path, value, mode=0o600):
    path = guarded_path(path)
    if path.exists() and not path.is_file():
        raise InstallError('Refusing a nonregular installation target.')
    fd, temp = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(value if isinstance(value, bytes) else value.encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, mode)
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


def write_new(path, value, mode=0o600):
    path = guarded_path(path)
    fd, temp = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, mode)
        # link creates the final name atomically and refuses any existing target.
        os.link(temp, path, follow_symlinks=False)
    finally:
        Path(temp).unlink(missing_ok=True)


def read_env(path):
    env = {}
    for line in private_read(path).splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        name, separator, value = line.partition('=')
        if not separator or not re.fullmatch(r'[A-Z][A-Z0-9_]*', name) or any(c in value for c in '\r\n\0'):
            raise InstallError('Environment file has an unsupported format.')
        env[name] = value
    return env


def endpoint(value):
    host, separator, port = value.rpartition(':')
    try:
        address = ipaddress.IPv4Address(host)
    except ValueError:
        raise InstallError('WireGuard endpoint requires an IPv4 address and UDP port.') from None
    if not separator or not port.isdecimal() or not 1 <= int(port) <= 65535 or address.is_unspecified or address.is_multicast:
        raise InstallError('WireGuard endpoint is invalid.')
    return str(address) + ':' + str(int(port))


def public_url(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise InstallError('Registration origin must be HTTPS without credentials, path, query or fragment.')
    try:
        parsed.port
    except ValueError:
        raise InstallError('Registration HTTPS port is invalid.') from None
    if any(c.isspace() for c in value) or '\\' in value:
        raise InstallError('Registration origin is invalid.')
    return value.rstrip('/')


def run(command, cwd, data=None, timeout=60):
    try:
        # A non-interactive child must not consume the installer's password stdin.
        source = {'stdin': subprocess.DEVNULL} if data is None else {'input': data}
        result = subprocess.run(command, cwd=cwd, capture_output=True, timeout=timeout, **source)
    except (OSError, subprocess.TimeoutExpired):
        raise InstallError('Installation command could not finish; state retained for retry.') from None
    if result.returncode:
        # Native stderr may include SQL/configuration. Never echo it or the argv.
        raise InstallError('Installation command failed; state retained. Check prerequisite/service readiness.')
    return result.stdout


def json_output(value):
    try:
        return json.loads(value)
    except (ValueError, UnicodeDecodeError):
        raise InstallError('A service returned invalid verification data.') from None
