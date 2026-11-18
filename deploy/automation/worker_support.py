"""Worker enrollment validation and HTTPS transport; importing changes nothing."""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import ssl
import stat
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid


class InstallError(RuntimeError):
    """Only fixed, non-secret messages are safe to show to an operator."""


def assert_no_symlinks(path: Path) -> None:
    for item in (path.absolute(), *path.absolute().parents):
        if item.is_symlink():
            raise InstallError('Symlink paths are not accepted.')


def read_private_json(path: Path) -> dict:
    assert_no_symlinks(path)
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise InstallError('Enrollment JSON must be a regular private file (0600).')
    if info.st_size > 65536:
        raise InstallError('Enrollment JSON exceeds 64 KiB.')
    data = json.loads(path.read_bytes().decode('utf-8-sig'))
    if not isinstance(data, dict):
        raise InstallError('Enrollment JSON must contain an object.')
    return data


def write_private(path: Path, value: bytes | str | dict) -> None:
    assert_no_symlinks(path)
    if path.exists() and (not path.is_file() or path.stat().st_mode & 0o077):
        raise InstallError('Existing managed private file has unsafe permissions.')
    if isinstance(value, dict):
        value = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    if isinstance(value, str):
        value = value.encode()
    descriptor, temporary = tempfile.mkstemp(prefix='.zt-', dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def wireguard_key(value: object, *, allow_zero: bool = True) -> str:
    if not isinstance(value, str):
        raise InstallError('WireGuard public key is invalid.')
    try:
        decoded = base64.b64decode(value, validate=True)
    except ValueError:
        raise InstallError('WireGuard public key is invalid.') from None
    if len(decoded) != 32 or base64.b64encode(decoded).decode() != value:
        raise InstallError('WireGuard public key is invalid.')
    if not allow_zero and decoded == b'\x00' * 32:
        raise InstallError('WireGuard public key cannot be all zeros.')
    return value


def ssh_public_key(value: object) -> str:
    if not isinstance(value, str) or '\n' in value or '\r' in value:
        raise InstallError('Expected a single Ed25519 SSH public key.')
    parts = value.split()
    if len(parts) < 2 or parts[0] != 'ssh-ed25519':
        raise InstallError('Expected an Ed25519 SSH public key.')
    try:
        blob = base64.b64decode(parts[1], validate=True)
    except ValueError:
        raise InstallError('SSH public key encoding is invalid.') from None
    prefix = b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20'
    if len(blob) != len(prefix) + 32 or not blob.startswith(prefix):
        raise InstallError('SSH public key encoding is invalid.')
    return ' '.join(parts[:2])


def validate_invite(value: dict, worker_os: str, allow_expired: bool = False) -> dict:
    required = {'version', 'gateway_id', 'registration_url', 'wireguard_endpoint',
                'wireguard_public_key', 'gateway_vpn_ip', 'bastion_public_key',
                'invitation_id', 'join_token', 'expires_at', 'node_name',
                'node_type', 'worker_os', 'ssh_username'}
    if set(value) != required or value['version'] != 1 or isinstance(value['version'], bool):
        raise InstallError('Unsupported or incomplete invitation format.')
    if any(not isinstance(value[key], str) for key in required - {'version'}):
        raise InstallError('Invitation fields must be strings.')
    invite = dict(value)
    public = wireguard_key(invite['wireguard_public_key'])
    gateway_id = 'sha256:' + hashlib.sha256(base64.b64decode(public)).hexdigest()
    if invite['gateway_id'] != gateway_id:
        raise InstallError('Gateway ID does not match its WireGuard public key.')
    url = urllib.parse.urlsplit(invite['registration_url'])
    if (url.scheme != 'https' or not url.hostname or url.username or url.password or
            url.query or url.fragment or url.path != '/api/enrollment/claim'):
        raise InstallError('Registration requires a verified HTTPS enrollment URL.')
    try:
        if url.port is not None and not 1 <= url.port <= 65535:
            raise ValueError()
        uuid.UUID(invite['invitation_id'])
        host, separator, port = invite['wireguard_endpoint'].rpartition(':')
        if not separator or str(ipaddress.IPv4Address(host)) != host or not port.isdigit() or not 1 <= int(port) <= 65535:
            raise ValueError()
        expires = dt.datetime.fromisoformat(invite['expires_at'].replace('Z', '+00:00'))
        if expires.tzinfo is None:
            raise ValueError()
    except (ValueError, TypeError):
        raise InstallError('Invitation address, identifier or expiry is invalid.') from None
    if not allow_expired and expires <= dt.datetime.now(dt.timezone.utc):
        raise InstallError('Invitation has expired; request a new one.')
    if invite['gateway_vpn_ip'] != '10.100.0.1':
        raise InstallError('This installer requires the current Gateway overlay address.')
    if invite['worker_os'] != worker_os or invite['node_type'] not in ('VM', 'BARE_METAL'):
        raise InstallError('Invitation does not match the Worker OS/type.')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{3,64}', invite['node_name']):
        raise InstallError('Worker name is invalid.')
    if not re.fullmatch(r'[a-z][a-z0-9_-]{0,19}', invite['ssh_username']):
        raise InstallError('SSH account must be a regular dedicated account name.')
    if invite['ssh_username'] in ('root', 'admin', 'administrator'):
        raise InstallError('SSH enrollment cannot use a privileged account.')
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', invite['join_token']):
        raise InstallError('Invitation code is invalid.')
    ssh_public_key(invite['bastion_public_key'])
    return invite


def invite_fingerprint(invite: dict) -> str:
    return hashlib.sha256(json.dumps(invite, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def validate_assignment(data: dict, invite: dict) -> dict:
    if not isinstance(data, dict) or data.get('version') != 1 or data.get('status') not in ('PENDING', 'READY'):
        raise InstallError('Gateway returned an unsupported enrollment response.')
    fixed = ('gateway_id', 'invitation_id', 'registration_url', 'node_name', 'node_type', 'worker_os',
             'ssh_username', 'gateway_vpn_ip', 'wireguard_endpoint', 'wireguard_public_key')
    if any(data.get(key) != invite[key] for key in fixed):
        raise InstallError('Gateway response differs from the trusted invitation.')
    if ssh_public_key(data.get('bastion_public_key')) != ssh_public_key(invite['bastion_public_key']):
        raise InstallError('Gateway SSH identity differs from the invitation.')
    try:
        uuid.UUID(data['node_id'])
        address = ipaddress.IPv4Address(data['node_ip'])
    except (KeyError, ValueError, TypeError):
        raise InstallError('Gateway returned an invalid Worker assignment.') from None
    if address not in ipaddress.IPv4Network('10.100.0.0/24') or address.packed[-1] not in range(3, 255):
        raise InstallError('Assigned Worker address is outside the permitted range.')
    if data.get('gateway_api_url') != 'http://10.100.0.1:3000':
        raise InstallError('Gateway returned an unexpected telemetry address.')
    if data.get('peer_ready') is not (data['status'] == 'READY'):
        raise InstallError('Gateway peer acknowledgement is inconsistent.')
    check = data.get('verification')
    if not isinstance(check, dict) or set(check) != {'peer_applied', 'heartbeat_recent', 'ssh_authenticated'} or any(type(x) is not bool for x in check.values()):
        raise InstallError('Gateway verification evidence is incomplete.')
    return data


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise InstallError('Enrollment redirects are refused; check the Gateway URL.')


def claim(invite: dict, payload: dict, ca_file: Path | None = None) -> dict:
    context = ssl.create_default_context(cafile=str(ca_file) if ca_file else None)
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context),
                                        urllib.request.ProxyHandler({}))
    request = urllib.request.Request(invite['registration_url'], method='POST',
        headers={'Content-Type': 'application/json', 'X-Enrollment-Token': invite['join_token']},
        data=json.dumps(payload, separators=(',', ':')).encode())
    try:
        with opener.open(request, timeout=15) as response:
            if response.status not in (200, 202):
                raise InstallError('Gateway enrollment did not return a success status.')
            raw = response.read(65537)
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        messages = {400: 'Gateway rejected the enrollment fields.',
                    401: 'Invitation code is invalid.',
                    409: 'Invitation is already bound to a different Worker identity.',
                    410: 'Invitation is expired or revoked.',
                    429: 'Enrollment is rate limited; retry later with the same identity.',
                    503: 'Gateway enrollment is temporarily unavailable; retry with the same identity.'}
        raise InstallError(messages.get(status, 'Gateway enrollment failed.')) from None
    except (urllib.error.URLError, TimeoutError, ssl.SSLError):
        raise InstallError('Cannot reach the verified Gateway HTTPS endpoint; identity is preserved for retry.') from None
    if len(raw) > 65536:
        raise InstallError('Gateway enrollment response exceeds 64 KiB.')
    try:
        data = json.loads(raw)
    except (UnicodeError, json.JSONDecodeError):
        raise InstallError('Gateway returned invalid enrollment JSON.') from None
    return validate_assignment(data, invite)


def read_private_auth_bundle(path: Path) -> dict:
    assert_no_symlinks(path)
    if not path.is_file():
        raise InstallError('Authorization bundle does not exist or is not a regular file.')
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise InstallError('Authorization bundle must be a regular private file (0600).')
    if os.geteuid() == 0 and info.st_uid != 0:
        raise InstallError('Authorization bundle must be owned by root.')
    if info.st_size > 65536:
        raise InstallError('Authorization bundle exceeds 64 KiB.')
    try:
        data = json.loads(path.read_bytes().decode('utf-8-sig'))
    except (UnicodeError, json.JSONDecodeError):
        raise InstallError('Authorization bundle contains invalid JSON.') from None
    if not isinstance(data, dict):
        raise InstallError('Authorization bundle must contain a JSON object.')
    return data


def canonical_json(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def validate_offboarding_bundle(value: dict, assignment: dict, worker_wg_public_key: str) -> dict:
    required = {
        'version', 'gateway_id', 'operation_id', 'node_id', 'node_name',
        'invitation_id', 'wireguard_public_key', 'node_ip', 'completion_url', 'cleanup_token'
    }
    if not isinstance(value, dict) or set(value) != required:
        raise InstallError('Authorization bundle must contain exactly the required keys.')
    if value['version'] != 1 or isinstance(value['version'], bool):
        raise InstallError('Unsupported authorization bundle version.')
    if any(not isinstance(value[key], str) for key in required - {'version'}):
        raise InstallError('Authorization bundle fields must be strings.')

    bundle = dict(value)

    for key in ('operation_id', 'node_id', 'invitation_id'):
        try:
            parsed = uuid.UUID(bundle[key])
            if str(parsed) != bundle[key].lower():
                raise ValueError()
        except (ValueError, TypeError):
            raise InstallError(f'Authorization bundle {key} is invalid.') from None

    wireguard_key(bundle['wireguard_public_key'], allow_zero=False)

    try:
        ip = ipaddress.IPv4Address(bundle['node_ip'])
        if str(ip) != bundle['node_ip']:
            raise ValueError()
    except (ValueError, TypeError):
        raise InstallError('Authorization bundle node_ip is invalid.') from None

    if not re.fullmatch(r'[a-zA-Z0-9_-]{3,64}', bundle['node_name']):
        raise InstallError('Authorization bundle node_name is invalid.')

    if not re.fullmatch(r'[0-9a-f]{64}', bundle['cleanup_token']):
        raise InstallError('Authorization bundle cleanup_token is invalid.')

    if bundle['gateway_id'] != assignment['gateway_id']:
        raise InstallError('Authorization bundle gateway_id does not match installed Worker.')
    if bundle['node_id'] != assignment['node_id']:
        raise InstallError('Authorization bundle node_id does not match installed Worker.')
    if bundle['node_name'] != assignment['node_name']:
        raise InstallError('Authorization bundle node_name does not match installed Worker.')
    if bundle['invitation_id'] != assignment['invitation_id']:
        raise InstallError('Authorization bundle invitation_id does not match installed Worker.')
    if bundle['node_ip'] != assignment['node_ip']:
        raise InstallError('Authorization bundle node_ip does not match installed Worker.')

    if not worker_wg_public_key or not isinstance(worker_wg_public_key, str):
        raise InstallError('Local Worker WireGuard public key is required for authorization validation.')
    if bundle['wireguard_public_key'] != worker_wg_public_key:
        raise InstallError('Authorization bundle wireguard_public_key does not match local Worker identity.')

    reg = urllib.parse.urlsplit(assignment['registration_url'])
    trusted_origin = f'{reg.scheme}://{reg.netloc}'
    expected_completion = f'{trusted_origin}/api/offboarding/complete'

    url = urllib.parse.urlsplit(bundle['completion_url'])
    if (url.scheme != 'https' or not url.hostname or url.username or url.password or
            url.query or url.fragment or bundle['completion_url'] != expected_completion):
        raise InstallError('completion_url must match trusted Gateway HTTPS offboarding endpoint.')

    return bundle


def verify_offboarding(bundle: dict, trusted_origin: str, ca_file: Path | None = None) -> dict:
    context = ssl.create_default_context(cafile=str(ca_file) if ca_file else None)
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context),
                                         urllib.request.ProxyHandler({}))
    payload = {
        'version': 1,
        'operation_id': bundle['operation_id'],
        'gateway_id': bundle['gateway_id'],
        'node_id': bundle['node_id'],
        'invitation_id': bundle['invitation_id'],
        'wireguard_public_key': bundle['wireguard_public_key'],
        'node_ip': bundle['node_ip'],
    }
    verify_url = f'{trusted_origin}/api/offboarding/verify'
    request = urllib.request.Request(
        verify_url,
        method='POST',
        headers={
            'Content-Type': 'application/json',
            'X-Cleanup-Token': bundle['cleanup_token'],
        },
        data=canonical_json(payload),
    )
    try:
        with opener.open(request, timeout=15) as response:
            if response.status != 200:
                raise InstallError('Gateway offboarding verification did not return success.')
            raw = response.read(65537)
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        messages = {
            400: 'Gateway rejected offboarding verification payload.',
            401: 'Offboarding cleanup token is invalid or expired.',
            409: 'Offboarding identity mismatch on Gateway.',
            503: 'Gateway offboarding service is temporarily unavailable; retry later.',
        }
        raise InstallError(messages.get(status, 'Gateway offboarding verification failed.')) from None
    except (urllib.error.URLError, TimeoutError, ssl.SSLError):
        raise InstallError('Cannot reach Gateway offboarding verification endpoint.') from None

    if len(raw) > 65536:
        raise InstallError('Gateway verification response exceeds 64 KiB.')
    try:
        data = json.loads(raw.decode('utf-8'))
    except (UnicodeError, json.JSONDecodeError):
        raise InstallError('Gateway returned invalid verification JSON.') from None

    if not isinstance(data, dict) or not data.get('success'):
        raise InstallError('Gateway offboarding verification was unsuccessful.')

    for key in ('operation_id', 'gateway_id', 'node_id', 'node_name', 'node_ip', 'invitation_id', 'wireguard_public_key'):
        if data.get(key) != bundle[key]:
            raise InstallError(f'Gateway returned mismatched {key} during offboarding verification.')

    lifecycle = data.get('lifecycle_state')
    if lifecycle == 'RETIRING':
        raise InstallError('Offboarding is still RETIRING on Gateway; cannot mutate local system until REVOKED or PENDING_LOCAL_CLEANUP.')
    if lifecycle not in ('REVOKED', 'PENDING_LOCAL_CLEANUP'):
        raise InstallError(f'Unexpected Gateway lifecycle state: {lifecycle}.')

    return data


def post_offboarding_complete(completion_url: str, cleanup_token: str, payload: dict, ca_file: Path | None = None) -> dict:
    context = ssl.create_default_context(cafile=str(ca_file) if ca_file else None)
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context),
                                         urllib.request.ProxyHandler({}))
    request = urllib.request.Request(
        completion_url,
        method='POST',
        headers={
            'Content-Type': 'application/json',
            'X-Cleanup-Token': cleanup_token,
        },
        data=canonical_json(payload),
    )
    try:
        with opener.open(request, timeout=15) as response:
            if response.status != 200:
                raise InstallError('Gateway offboarding completion did not return success.')
            raw = response.read(65537)
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        messages = {
            400: 'Gateway rejected offboarding completion receipt.',
            401: 'Offboarding cleanup token is invalid or expired.',
            409: 'Offboarding receipt conflict or already completed on Gateway.',
            503: 'Gateway offboarding service is temporarily unavailable; retry later.',
        }
        raise InstallError(messages.get(status, 'Gateway offboarding completion failed.')) from None
    except (urllib.error.URLError, TimeoutError, ssl.SSLError):
        raise InstallError('Cannot reach Gateway offboarding completion endpoint; capability and receipt are preserved for retry.') from None

    if len(raw) > 65536:
        raise InstallError('Gateway completion response exceeds 64 KiB.')
    try:
        data = json.loads(raw.decode('utf-8'))
    except (UnicodeError, json.JSONDecodeError):
        raise InstallError('Gateway returned invalid completion JSON.') from None

    if not isinstance(data, dict) or not data.get('success'):
        raise InstallError('Gateway offboarding completion was unsuccessful.')

    return data
