"""Linux Worker uninstall and durable write-ahead cleanup journal."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time
import urllib.parse

from worker_support import (
    InstallError, assert_no_symlinks, canonical_json,
    post_offboarding_complete, read_private_auth_bundle,
    validate_offboarding_bundle, verify_offboarding, write_private,
)
import worker


def allowed_managed_paths() -> set[Path]:
    return {
        worker.TUNNEL,
        worker.SSH_PUBLIC,
        worker.SSH_CONFIG,
        worker.SSH_UNIT,
        worker.FIREWALL,
        worker.FIREWALL_UNIT,
        worker.AGENT_ENV,
        worker.AGENT_DIR / 'zt-agent',
        worker.AGENT_UNIT,
    }


def get_worker_wg_public_key(state_data: dict) -> str:
    if state_data.get('worker_wireguard_public_key'):
        return state_data['worker_wireguard_public_key']
    private_file = worker.STATE / 'wireguard.private'
    if private_file.exists():
        try:
            return worker.wireguard_key(
                worker.run(['wg', 'pubkey'], data=private_file.read_bytes()).decode().strip(),
                allow_zero=False,
            )
        except Exception:
            pass
    cleanup_file = worker.STATE / 'cleanup.json'
    if cleanup_file.exists():
        try:
            cdata = json.loads(cleanup_file.read_text(encoding='utf-8'))
            if cdata.get('wireguard_public_key'):
                return cdata['wireguard_public_key']
        except Exception:
            pass
    raise InstallError('Cannot determine local Worker WireGuard public key; manual review required.')


def validate_backup_file(path_str: str, before_hash: str, recorded_backup: str | None = None) -> Path:
    expected_filename = hashlib.sha256(path_str.encode()).hexdigest()
    expected_backup = worker.STATE / 'backup' / expected_filename
    if recorded_backup is not None and Path(recorded_backup) != expected_backup:
        raise InstallError(f'Backup path for {path_str} in journal is invalid.')
    assert_no_symlinks(expected_backup)
    if not expected_backup.is_file():
        raise InstallError(f'Backup file for {path_str} is missing or not a regular file.')
    st = expected_backup.stat()
    if not stat.S_ISREG(st.st_mode) or (st.st_mode & 0o077):
        raise InstallError(f'Backup file for {path_str} has unsafe permissions (must be 0600).')
    if os.geteuid() == 0 and st.st_uid != 0:
        raise InstallError(f'Backup file for {path_str} must be owned by root.')
    content = expected_backup.read_bytes()
    if hashlib.sha256(content).hexdigest() != before_hash:
        raise InstallError(f'Backup file for {path_str} checksum mismatch.')
    return expected_backup


def preflight_uninstall(value: dict | None) -> dict:
    if not value or value.get('version') != 1 or value.get('kind') != 'zt-worker-automation':
        raise InstallError('Legacy or missing Worker state; no valid automation installation found for uninstall.')
    assignment = value.get('assignment')
    if not assignment or not isinstance(assignment, dict):
        raise InstallError('Worker state lacks assignment record; manual review required.')
    managed = value.get('managed')
    if not isinstance(managed, dict):
        raise InstallError('Worker state lacks managed file journal; manual review required.')
    original_services = value.get('original_services')
    if not isinstance(original_services, dict):
        raise InstallError('Worker state lacks original services record; manual review required.')

    allowed = allowed_managed_paths()

    # Fail closed if unowned managed files exist on disk (legacy / insufficient journal)
    for p in allowed:
        if p.exists() and str(p) not in managed:
            raise InstallError(f'Unmanaged configuration file exists without journal ownership: {p}; manual review required.')

    conflicts: dict[str, str] = {}
    for path_str, info in managed.items():
        p = Path(path_str)
        if p not in allowed:
            raise InstallError(f'Managed file {p} is outside the allowed Worker paths.')
        assert_no_symlinks(p)
        if not p.exists():
            continue
        st = p.stat()
        if not stat.S_ISREG(st.st_mode):
            conflicts[path_str] = 'Not a regular file.'
            continue
        if os.geteuid() == 0 and st.st_uid != 0:
            conflicts[path_str] = 'Not owned by root.'
            continue

        current_hash = hashlib.sha256(p.read_bytes()).hexdigest()
        before_hash = info.get('before_hash')
        after_hash = info.get('after_hash')

        if before_hash is not None:
            try:
                validate_backup_file(path_str, before_hash, info.get('backup'))
            except InstallError as err:
                conflicts[path_str] = str(err)
            else:
                if current_hash not in (before_hash, after_hash):
                    conflicts[path_str] = 'File was modified since installation; preserving user edits.'
        else:
            if current_hash != after_hash:
                conflicts[path_str] = 'File was modified since installation; preserving user edits.'

    return {
        'conflicts': conflicts,
        'assignment': assignment,
        'original_services': original_services,
        'managed': managed,
    }


def restore_or_remove_managed_file(path: Path, preflight: dict) -> bool:
    path_str = str(path)
    conflicts = preflight['conflicts']
    if path_str in conflicts:
        return False
    info = preflight['managed'].get(path_str)
    if not info:
        return True
    before_hash = info.get('before_hash')
    before_mode = info.get('before_mode')
    if before_hash is None:
        if path.exists():
            assert_no_symlinks(path)
            path.unlink(missing_ok=True)
        return True
    else:
        try:
            backup_file = validate_backup_file(path_str, before_hash, info.get('backup'))
            assert_no_symlinks(path)
            content = backup_file.read_bytes()
            parent = path.parent
            parent.mkdir(parents=True, exist_ok=True)
            mode = (before_mode & 0o777) if before_mode is not None else 0o600

            temp_path = parent / f'.tmp-restore-{path.name}-{os.getpid()}-{int(time.time() * 1000)}'
            assert_no_symlinks(temp_path)
            fd = os.open(str(temp_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.chmod(str(temp_path), mode)
                os.replace(str(temp_path), str(path))
            except Exception:
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    pass
                raise

            try:
                dir_fd = os.open(str(parent), os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            except OSError:
                pass
            return True
        except Exception:
            conflicts[path_str] = 'Failed to restore pre-existing file from backup.'
            return False


def cleanup_empty_owned_directories() -> None:
    dirs_to_clean = [
        worker.AGENT_DIR,
        worker.SSH_PUBLIC.parent,
        worker.SSH_UNIT.parent,
        worker.FIREWALL.parent,
    ]
    for d in dirs_to_clean:
        if d.exists() and d.is_dir():
            try:
                assert_no_symlinks(d)
                d.rmdir()
            except OSError:
                pass
    if worker.AGENT_DIR.parent.exists() and worker.AGENT_DIR.parent.is_dir():
        try:
            assert_no_symlinks(worker.AGENT_DIR.parent)
            worker.AGENT_DIR.parent.rmdir()
        except OSError:
            pass


def cleanup_agent(preflight: dict) -> str:
    agent_unit = worker.AGENT_UNIT
    agent_bin = worker.AGENT_DIR / 'zt-agent'
    conflicts = preflight['conflicts']

    try:
        worker.run(['systemctl', 'stop', 'zt-agent'], check=False)
        worker.run(['systemctl', 'disable', 'zt-agent'], check=False)

        ok_unit = restore_or_remove_managed_file(agent_unit, preflight)
        ok_bin = restore_or_remove_managed_file(agent_bin, preflight)

        worker.run(['systemctl', 'daemon-reload'], check=False)

        if worker.active('zt-agent'):
            return 'REVIEW'
        if not ok_unit or not ok_bin:
            return 'REVIEW'

        unit_info = preflight['managed'].get(str(agent_unit), {})
        if unit_info.get('before_hash') is None and agent_unit.exists():
            return 'REVIEW'
        bin_info = preflight['managed'].get(str(agent_bin), {})
        if bin_info.get('before_hash') is None and agent_bin.exists():
            return 'REVIEW'
    except Exception:
        return 'REVIEW'

    return 'REVIEW' if (str(agent_unit) in conflicts or str(agent_bin) in conflicts) else 'DONE'


def cleanup_tunnel(preflight: dict) -> str:
    tunnel = worker.TUNNEL
    conflicts = preflight['conflicts']

    try:
        worker.run(['systemctl', 'stop', 'wg-quick@zt-worker'], check=False)
        worker.run(['systemctl', 'disable', 'wg-quick@zt-worker'], check=False)

        if shutil.which('ip') and worker.run(['ip', 'link', 'show', 'zt-worker'], check=False):
            worker.run(['ip', 'link', 'delete', 'zt-worker'], check=False)

        ok_tunnel = restore_or_remove_managed_file(tunnel, preflight)

        if worker.active('wg-quick@zt-worker'):
            return 'REVIEW'
        if shutil.which('ip') and worker.run(['ip', 'link', 'show', 'zt-worker'], check=False):
            return 'REVIEW'
        if not ok_tunnel:
            return 'REVIEW'
        tunnel_info = preflight['managed'].get(str(tunnel), {})
        if tunnel_info.get('before_hash') is None and tunnel.exists():
            return 'REVIEW'
    except Exception:
        return 'REVIEW'

    return 'REVIEW' if str(tunnel) in conflicts else 'DONE'


def cleanup_firewall(preflight: dict) -> str:
    firewall_file = worker.FIREWALL
    firewall_unit = worker.FIREWALL_UNIT
    conflicts = preflight['conflicts']

    try:
        worker.run(['systemctl', 'stop', 'zt-worker-firewall'], check=False)
        worker.run(['systemctl', 'disable', 'zt-worker-firewall'], check=False)

        ok_unit = restore_or_remove_managed_file(firewall_unit, preflight)
        ok_file = restore_or_remove_managed_file(firewall_file, preflight)

        worker.run(['nft', 'delete', 'table', 'inet', 'zt_worker_auto'], check=False)

        if worker.active('zt-worker-firewall'):
            return 'REVIEW'
        if not ok_unit or not ok_file:
            return 'REVIEW'

        funit_info = preflight['managed'].get(str(firewall_unit), {})
        if funit_info.get('before_hash') is None and firewall_unit.exists():
            return 'REVIEW'
        ffile_info = preflight['managed'].get(str(firewall_file), {})
        if ffile_info.get('before_hash') is None and firewall_file.exists():
            return 'REVIEW'

        try:
            tables = worker.run(['nft', 'list', 'tables'], check=False).decode()
            if re.search(r'(?m)^table\s+inet\s+zt_worker_auto\s*$', tables):
                return 'REVIEW'
        except Exception:
            return 'REVIEW'
    except Exception:
        return 'REVIEW'

    return 'REVIEW' if (str(firewall_file) in conflicts or str(firewall_unit) in conflicts) else 'DONE'


def cleanup_ssh(preflight: dict) -> str:
    ssh_config = worker.SSH_CONFIG
    ssh_unit = worker.SSH_UNIT
    ssh_public = worker.SSH_PUBLIC
    conflicts = preflight['conflicts']

    try:
        ok_unit = restore_or_remove_managed_file(ssh_unit, preflight)
        ok_public = restore_or_remove_managed_file(ssh_public, preflight)
        ok_config = restore_or_remove_managed_file(ssh_config, preflight)

        try:
            worker.run(['sshd', '-t'], label='SSH validation')
        except Exception:
            return 'REVIEW'

        worker.run(['systemctl', 'daemon-reload'], check=False)

        orig = preflight['original_services'].get('ssh', {'active': True, 'enabled': True})
        worker.run(['systemctl', 'enable' if orig['enabled'] else 'disable', 'ssh'], check=False)
        if orig['active']:
            worker.run(['systemctl', 'restart', 'ssh'], check=False)
        else:
            worker.run(['systemctl', 'stop', 'ssh'], check=False)

        observed = subprocess.run(
            ['systemctl', 'show', 'ssh', '--property=LoadState,ActiveState,UnitFileState', '--no-pager'],
            stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
        properties = dict(line.split('=', 1) for line in observed.stdout.decode().splitlines() if '=' in line)

        if orig['active'] and properties.get('ActiveState') != 'active':
            return 'REVIEW'
        if not orig['active'] and properties.get('ActiveState') == 'active':
            return 'REVIEW'
        if orig['enabled'] and properties.get('UnitFileState') not in ('enabled', 'static', 'indirect'):
            return 'REVIEW'
        if not orig['enabled'] and properties.get('UnitFileState') == 'enabled':
            return 'REVIEW'

        if not ok_unit or not ok_public or not ok_config:
            return 'REVIEW'

        unit_info = preflight['managed'].get(str(ssh_unit), {})
        if unit_info.get('before_hash') is None and ssh_unit.exists():
            return 'REVIEW'
        public_info = preflight['managed'].get(str(ssh_public), {})
        if public_info.get('before_hash') is None and ssh_public.exists():
            return 'REVIEW'
    except Exception:
        return 'REVIEW'

    return 'REVIEW' if (str(ssh_config) in conflicts or str(ssh_unit) in conflicts or str(ssh_public) in conflicts) else 'DONE'


def cleanup_secrets(preflight: dict) -> str:
    agent_env = worker.AGENT_ENV
    conflicts = preflight['conflicts']

    ok_env = restore_or_remove_managed_file(agent_env, preflight)

    wg_priv = worker.STATE / 'wireguard.private'
    node_token = worker.STATE / 'node.token'
    staged_agent = worker.STATE / 'zt-agent'

    if wg_priv.exists():
        assert_no_symlinks(wg_priv)
        wg_priv.unlink(missing_ok=True)
    if node_token.exists():
        assert_no_symlinks(node_token)
        node_token.unlink(missing_ok=True)
    if staged_agent.exists():
        assert_no_symlinks(staged_agent)
        staged_agent.unlink(missing_ok=True)

    cleanup_empty_owned_directories()

    if wg_priv.exists() or node_token.exists() or not ok_env:
        return 'REVIEW'

    env_info = preflight['managed'].get(str(agent_env), {})
    if env_info.get('before_hash') is None and agent_env.exists():
        return 'REVIEW'

    return 'REVIEW' if str(agent_env) in conflicts else 'DONE'


def build_receipt(steps: dict[str, str], bundle: dict) -> dict:
    frozen_steps = copy.deepcopy(steps)
    evidence_payload = {
        'platform': 'linux',
        'steps': frozen_steps,
        'operation_id': bundle['operation_id'],
        'node_id': bundle['node_id'],
        'gateway_id': bundle['gateway_id'],
    }
    evidence_digest = hashlib.sha256(canonical_json(evidence_payload)).hexdigest()
    return {
        'platform': 'linux',
        'steps': frozen_steps,
        'evidence_digest': evidence_digest,
    }


def checkpoint_step(cleanup_file: Path, cleanup_journal: dict, step_name: str, outcome: str) -> None:
    cleanup_journal.setdefault('steps', {})[step_name] = outcome
    cleanup_journal['updated_at'] = int(time.time())
    write_private(cleanup_file, cleanup_journal)


def execute_uninstall(bundle_path: Path, ca_file: Path | None = None) -> dict:
    raw_bundle = read_private_auth_bundle(bundle_path)
    cleanup_file = worker.STATE / 'cleanup.json'
    cap_file = worker.STATE / 'cleanup.capability'

    # Idempotent check: if same operation already completed, return existing complete safely
    if cleanup_file.exists():
        try:
            prev_cleanup = json.loads(cleanup_file.read_text(encoding='utf-8'))
        except Exception:
            prev_cleanup = {}
        if prev_cleanup.get('operation_id') == raw_bundle.get('operation_id'):
            if prev_cleanup.get('gateway_acknowledged') and prev_cleanup.get('status') == 'COMPLETE':
                state_data = worker.state()
                if state_data and state_data.get('assignment'):
                    curr_asgn = state_data['assignment']
                    if (curr_asgn.get('node_id') != prev_cleanup.get('node_id') or
                            curr_asgn.get('gateway_id') != prev_cleanup.get('gateway_id')):
                        raise InstallError('Provided authorization belongs to a previous installation; refusing to mutate current Worker.')
                if state_data and state_data.get('phase') != 'uninstalled':
                    state_data['phase'] = 'uninstalled'
                    state_data['uninstalled_status'] = 'COMPLETE'
                    state_data['cleanup_receipt'] = prev_cleanup.get('receipt')
                    worker.save(state_data)
                cap_file.unlink(missing_ok=True)
                return {
                    'ok': True,
                    'status': 'COMPLETE',
                    'operation_id': prev_cleanup['operation_id'],
                    'node_id': prev_cleanup['node_id'],
                    'node_name': prev_cleanup['node_name'],
                    'receipt': prev_cleanup['receipt'],
                    'gateway_acknowledged': True,
                    'already_completed': True,
                    'state_file': str(worker.JOURNAL),
                }
            else:
                # Existing SAME incomplete operation should route to cleanup_retry with bound auth
                # instead of resetting journal/steps/receipt!
                return execute_cleanup_retry(bundle_path, ca_file)
        elif prev_cleanup.get('operation_id') and not prev_cleanup.get('gateway_acknowledged'):
            raise InstallError('Another cleanup operation is already in progress; complete or review it first.')

    state_data = worker.state()
    plan = preflight_uninstall(state_data)
    assignment = plan['assignment']
    worker_wg_pub = get_worker_wg_public_key(state_data)
    bundle = validate_offboarding_bundle(raw_bundle, assignment, worker_wg_pub)

    reg = urllib.parse.urlsplit(assignment['registration_url'])
    trusted_origin = f'{reg.scheme}://{reg.netloc}'

    # Pre-cleanup verify against Gateway
    verify_offboarding(bundle, trusted_origin, ca_file)

    # Durable write-ahead cleanup journal
    write_private(cap_file, bundle['cleanup_token'] + '\n')

    cleanup_journal = {
        'version': 1,
        'kind': 'zt-worker-cleanup',
        'created_at': int(time.time()),
        'updated_at': int(time.time()),
        'operation_id': bundle['operation_id'],
        'node_id': bundle['node_id'],
        'node_name': bundle['node_name'],
        'node_ip': bundle['node_ip'],
        'gateway_id': bundle['gateway_id'],
        'invitation_id': bundle['invitation_id'],
        'wireguard_public_key': bundle['wireguard_public_key'],
        'completion_url': bundle['completion_url'],
        'registration_url': assignment['registration_url'],
        'status': 'IN_PROGRESS',
        'steps': {},
        'gateway_acknowledged': False,
    }
    write_private(cleanup_file, cleanup_journal)

    # Execute 5 cleanup steps with checkpoints
    steps = cleanup_journal.setdefault('steps', {})
    for name, fn in [
        ('agent', cleanup_agent),
        ('tunnel', cleanup_tunnel),
        ('firewall', cleanup_firewall),
        ('ssh', cleanup_ssh),
        ('secrets', cleanup_secrets),
    ]:
        if steps.get(name) != 'DONE':
            steps[name] = fn(plan)
            checkpoint_step(cleanup_file, cleanup_journal, name, steps[name])

    cleanup_empty_owned_directories()

    status = 'COMPLETE' if all(steps.get(s) == 'DONE' for s in ('agent', 'tunnel', 'firewall', 'ssh', 'secrets')) else 'NEEDS_REVIEW'
    receipt = build_receipt(steps, bundle)

    cleanup_journal['steps'] = steps
    cleanup_journal['status'] = status
    cleanup_journal['receipt'] = receipt
    cleanup_journal['updated_at'] = int(time.time())
    write_private(cleanup_file, cleanup_journal)

    # Post completion receipt to Gateway
    completion_payload = {
        'version': 1,
        'operation_id': bundle['operation_id'],
        'node_id': bundle['node_id'],
        'gateway_id': bundle['gateway_id'],
        'invitation_id': bundle['invitation_id'],
        'wireguard_public_key': bundle['wireguard_public_key'],
        'node_ip': bundle['node_ip'],
        'status': status,
        'receipt': receipt,
    }

    post_offboarding_complete(bundle['completion_url'], bundle['cleanup_token'], completion_payload, ca_file)

    # Persist final nonsecret ack and phase FIRST before wiping capability
    cleanup_journal['gateway_acknowledged'] = True
    cleanup_journal['updated_at'] = int(time.time())
    write_private(cleanup_file, cleanup_journal)

    state_data['phase'] = 'uninstalled' if status == 'COMPLETE' else 'cleanup_needs_review'
    state_data['uninstalled_status'] = status
    state_data['cleanup_receipt'] = receipt
    worker.save(state_data)

    if status == 'COMPLETE':
        cap_file.unlink(missing_ok=True)

    return {
        'ok': status == 'COMPLETE',
        'status': status,
        'operation_id': bundle['operation_id'],
        'node_id': bundle['node_id'],
        'node_name': bundle['node_name'],
        'receipt': receipt,
        'gateway_acknowledged': True,
        'state_file': str(worker.JOURNAL),
    }


def execute_cleanup_retry(bundle_path: Path | None = None, ca_file: Path | None = None) -> dict:
    cleanup_file = worker.STATE / 'cleanup.json'
    cap_file = worker.STATE / 'cleanup.capability'

    if not cleanup_file.exists():
        if bundle_path:
            return execute_uninstall(bundle_path, ca_file)
        raise InstallError('No cleanup in progress to retry.')

    try:
        cleanup_journal = json.loads(cleanup_file.read_text(encoding='utf-8'))
    except (UnicodeError, json.JSONDecodeError):
        raise InstallError('Existing cleanup journal is corrupted.') from None

    state_data = worker.state()

    # If already completed, ensure terminalization is finished and return
    if cleanup_journal.get('gateway_acknowledged') and cleanup_journal.get('status') == 'COMPLETE':
        if state_data and state_data.get('assignment'):
            curr_asgn = state_data['assignment']
            if (curr_asgn.get('node_id') != cleanup_journal.get('node_id') or
                    curr_asgn.get('gateway_id') != cleanup_journal.get('gateway_id')):
                raise InstallError('Saved cleanup belongs to a previous installation; refusing to mutate current Worker.')
        if state_data and state_data.get('phase') != 'uninstalled':
            state_data['phase'] = 'uninstalled'
            state_data['uninstalled_status'] = 'COMPLETE'
            state_data['cleanup_receipt'] = cleanup_journal.get('receipt')
            worker.save(state_data)
        cap_file.unlink(missing_ok=True)
        return {
            'ok': True,
            'status': 'COMPLETE',
            'operation_id': cleanup_journal.get('operation_id'),
            'node_id': cleanup_journal.get('node_id'),
            'node_name': cleanup_journal.get('node_name'),
            'receipt': cleanup_journal.get('receipt'),
            'gateway_acknowledged': True,
            'already_completed': True,
            'state_file': str(worker.JOURNAL),
        }

    # Verify saved operation against current assignment + Worker key
    if not state_data or not state_data.get('assignment'):
        raise InstallError('Worker state lacks assignment record; manual review required.')
    assignment = state_data['assignment']
    for k in ('node_id', 'invitation_id', 'gateway_id', 'node_ip'):
        if cleanup_journal.get(k) != assignment.get(k):
            raise InstallError(f'Saved cleanup operation {k} does not match current Worker assignment.')

    worker_wg_pub = get_worker_wg_public_key(state_data)
    if cleanup_journal.get('wireguard_public_key') != worker_wg_pub:
        raise InstallError('Saved cleanup operation wireguard_public_key does not match local Worker identity.')

    # Validate exact trusted HTTPS origin + /api/offboarding/complete
    reg = urllib.parse.urlsplit(assignment['registration_url'])
    if (reg.scheme != 'https' or not reg.hostname or reg.username or reg.password or
            reg.query or reg.fragment):
        raise InstallError('Worker registration URL is not a valid HTTPS URL.')
    trusted_origin = f'{reg.scheme}://{reg.netloc}'
    expected_completion = f'{trusted_origin}/api/offboarding/complete'

    completion_url = cleanup_journal.get('completion_url')
    if not completion_url or not isinstance(completion_url, str):
        raise InstallError('Cleanup journal lacks valid completion_url.')
    url = urllib.parse.urlsplit(completion_url)
    if (url.scheme != 'https' or not url.hostname or url.username or url.password or
            url.query or url.fragment or completion_url != expected_completion):
        raise InstallError('completion_url in journal does not match trusted Gateway HTTPS offboarding endpoint.')

    token: str | None = None
    if bundle_path:
        raw_bundle = read_private_auth_bundle(bundle_path)
        # Validate all tuple against assignment and worker WireGuard key before rotating capability!
        bundle = validate_offboarding_bundle(raw_bundle, assignment, worker_wg_pub)
        if bundle.get('operation_id') != cleanup_journal.get('operation_id'):
            raise InstallError('Provided authorization bundle does not match the saved cleanup operation.')
        token = bundle['cleanup_token']
        # Rotation cap replace only AFTER validation
        write_private(cap_file, token + '\n')
    elif cap_file.exists():
        token = cap_file.read_text().strip()

    if not token or not re.fullmatch(r'[0-9a-f]{64}', token):
        raise InstallError('No valid cleanup capability token available for retry.')

    # Check if this is a RECEIPT-ONLY retry
    durable_receipt = cleanup_journal.get('receipt')
    is_receipt_only = (
        cleanup_journal.get('status') == 'COMPLETE' and
        isinstance(durable_receipt, dict) and
        bool(durable_receipt.get('evidence_digest'))
    )

    if is_receipt_only:
        # Replay EXACT stored payload to same TRUSTED completion origin via scoped token.
        # No REVOKED precheck necessary; server offboarding complete enforces idempotent binding.
        completion_payload = {
            'version': 1,
            'operation_id': cleanup_journal['operation_id'],
            'node_id': cleanup_journal['node_id'],
            'gateway_id': cleanup_journal['gateway_id'],
            'invitation_id': cleanup_journal['invitation_id'],
            'wireguard_public_key': cleanup_journal['wireguard_public_key'],
            'node_ip': cleanup_journal['node_ip'],
            'status': 'COMPLETE',
            'receipt': durable_receipt,
        }
        post_offboarding_complete(expected_completion, token, completion_payload, ca_file)

        cleanup_journal['gateway_acknowledged'] = True
        cleanup_journal['updated_at'] = int(time.time())
        write_private(cleanup_file, cleanup_journal)

        if state_data:
            state_data['phase'] = 'uninstalled'
            state_data['uninstalled_status'] = 'COMPLETE'
            state_data['cleanup_receipt'] = durable_receipt
            worker.save(state_data)

        cap_file.unlink(missing_ok=True)

        return {
            'ok': True,
            'status': 'COMPLETE',
            'operation_id': cleanup_journal['operation_id'],
            'node_id': cleanup_journal['node_id'],
            'node_name': cleanup_journal['node_name'],
            'receipt': durable_receipt,
            'gateway_acknowledged': True,
            'state_file': str(worker.JOURNAL),
        }

    # IN_PROGRESS / NEEDS_REVIEW before local mutations must verify REVOKED
    verify_bundle = {
        'version': 1,
        'operation_id': cleanup_journal['operation_id'],
        'gateway_id': cleanup_journal['gateway_id'],
        'node_id': cleanup_journal['node_id'],
        'node_name': cleanup_journal.get('node_name', assignment.get('node_name')),
        'invitation_id': cleanup_journal['invitation_id'],
        'wireguard_public_key': cleanup_journal['wireguard_public_key'],
        'node_ip': cleanup_journal['node_ip'],
        'cleanup_token': token,
    }
    verify_offboarding(verify_bundle, trusted_origin, ca_file)

    # Resume all unfinished steps with checkpoints
    plan = preflight_uninstall(state_data)
    steps = cleanup_journal.setdefault('steps', {})
    for name, fn in [
        ('agent', cleanup_agent),
        ('tunnel', cleanup_tunnel),
        ('firewall', cleanup_firewall),
        ('ssh', cleanup_ssh),
        ('secrets', cleanup_secrets),
    ]:
        if steps.get(name) != 'DONE':
            steps[name] = fn(plan)
            checkpoint_step(cleanup_file, cleanup_journal, name, steps[name])

    cleanup_empty_owned_directories()

    status = 'COMPLETE' if all(steps.get(s) == 'DONE' for s in ('agent', 'tunnel', 'firewall', 'ssh', 'secrets')) else 'NEEDS_REVIEW'

    receipt = cleanup_journal.get('receipt')
    if not receipt or cleanup_journal.get('status') != status or steps != receipt.get('steps'):
        receipt = build_receipt(steps, cleanup_journal)
        cleanup_journal['receipt'] = receipt

    cleanup_journal['steps'] = steps
    cleanup_journal['status'] = status
    cleanup_journal['updated_at'] = int(time.time())
    write_private(cleanup_file, cleanup_journal)

    completion_payload = {
        'version': 1,
        'operation_id': cleanup_journal['operation_id'],
        'node_id': cleanup_journal['node_id'],
        'gateway_id': cleanup_journal['gateway_id'],
        'invitation_id': cleanup_journal['invitation_id'],
        'wireguard_public_key': cleanup_journal['wireguard_public_key'],
        'node_ip': cleanup_journal['node_ip'],
        'status': status,
        'receipt': receipt,
    }

    post_offboarding_complete(expected_completion, token, completion_payload, ca_file)

    cleanup_journal['gateway_acknowledged'] = True
    cleanup_journal['updated_at'] = int(time.time())
    write_private(cleanup_file, cleanup_journal)

    if state_data:
        state_data['phase'] = 'uninstalled' if status == 'COMPLETE' else 'cleanup_needs_review'
        state_data['uninstalled_status'] = status
        state_data['cleanup_receipt'] = receipt
        worker.save(state_data)

    if status == 'COMPLETE':
        cap_file.unlink(missing_ok=True)

    return {
        'ok': status == 'COMPLETE',
        'status': status,
        'operation_id': cleanup_journal['operation_id'],
        'node_id': cleanup_journal['node_id'],
        'node_name': cleanup_journal['node_name'],
        'receipt': receipt,
        'gateway_acknowledged': True,
        'state_file': str(worker.JOURNAL),
    }
