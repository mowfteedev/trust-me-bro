#!/usr/bin/env python3
"""ZT-ServerOps: Native Linux Worker Offboarding Acceptance Driver.

Executes explicit, reproducible acceptance verification for the Linux Worker
lifecycle and durable offboarding uninstaller in an owned, isolated VM lab.

Safety & Verification Invariants:
- Python standard library only (no third-party dependencies).
- Strictly non-destructive: Operates only on owned lab containers, networks,
  and verified VM processes. Never touches host networking or external services.
- All published ports restricted to loopback (127.0.0.1).
- Private data, authorization bundles, and secrets are strictly redacted.
- Resumable phase execution backed by durable JSON checkpoints.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import ssl
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

# Fixed Lab Constants
PROJECT_PREFIX = "zt_offboard_lab_"
CONTROLLER_IMAGE = "zt-automation-controller:20261117"
PREBUILT_PROXY_IMAGE = "zt-serverops-proxy:automation-local"

GATEWAY_FQDN = "gateway.offboarding.test"
HTTPS_PORT = 24444
HTTP_PORT = 18084
WG_PORT = 51829
SSH_PORT = 22252

NODE_NAME = "lab-worker"
ADMIN_USER = "lab-admin"
WORKER_ENDPOINT = "10.0.2.2:51829"
HTTPS_ORIGIN = f"https://{GATEWAY_FQDN}:{HTTPS_PORT}"
LOOPBACK_HTTPS_URL = f"https://127.0.0.1:{HTTPS_PORT}"


class AcceptanceError(Exception):
    """Raised when an acceptance invariant or verification check fails."""


class StrictNoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Disallows any HTTP redirection fail-closed."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f"Unexpected redirect to {newurl}", headers, fp)


def create_https_opener(ca_file: Path) -> urllib.request.OpenerDirector:
    """Build a hardened urllib opener: strict TLS, loopback direct, no proxies, no redirects."""
    ctx = ssl.create_default_context(cafile=str(ca_file))
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    proxy_handler = urllib.request.ProxyHandler({})
    redirect_handler = StrictNoRedirectHandler()
    https_handler = urllib.request.HTTPSHandler(context=ctx)
    return urllib.request.build_opener(proxy_handler, redirect_handler, https_handler)


def guard_paths(repo: Path, lab_dir: Path) -> None:
    """Ensure lab-dir is valid and strictly outside repository hierarchy."""
    if not lab_dir.exists() or not lab_dir.is_dir():
        raise AcceptanceError(f"Lab directory does not exist or is not a directory: {lab_dir}")
    repo_resolved = repo.resolve()
    lab_resolved = lab_dir.resolve()
    if lab_resolved == repo_resolved:
        raise AcceptanceError("Lab directory cannot be the repository root.")
    if lab_resolved in repo_resolved.parents or repo_resolved in lab_resolved.parents:
        raise AcceptanceError("Lab directory must be located strictly outside repository.")


def write_private_json(path: Path, data: dict) -> None:
    """Atomically write JSON data with 0600 file permissions."""
    tmp = path.with_suffix(".tmp")
    data_str = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    try:
        with open(fd, "w", encoding="utf-8", closefd=True) as stream:
            stream.write(data_str)
            stream.flush()
            os.fsync(stream.fileno())
        tmp.replace(path)
    except Exception:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        raise


def read_private_json(path: Path) -> dict:
    """Read a private JSON file."""
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8") as stream:
        return json.load(stream)


class LabCheckpoint:
    """Durable checkpoint state for resumable driver runs with persisted project identifier."""

    def __init__(self, path: Path):
        self.path = path
        self.state = read_private_json(path)
        if "steps" not in self.state:
            self.state["steps"] = {}
        if "metadata" not in self.state:
            self.state["metadata"] = {}

        if "project" not in self.state["metadata"]:
            suffix = secrets.token_hex(4)
            self.state["metadata"]["project"] = f"{PROJECT_PREFIX}{suffix}"
            self.save()

    @property
    def project(self) -> str:
        return self.state["metadata"]["project"]

    def is_step_done(self, name: str) -> bool:
        return self.state["steps"].get(name, {}).get("status") == "COMPLETED"

    def get_step_data(self, name: str) -> dict:
        return self.state["steps"].get(name, {}).get("data", {})

    def record_step(self, name: str, data: dict | None = None) -> None:
        self.state["steps"][name] = {
            "status": "COMPLETED",
            "timestamp": time.time(),
            "data": data or {},
        }
        self.save()

    def save(self) -> None:
        write_private_json(self.path, self.state)


# -----------------------------------------------------------------------------
# VM Lifecycle and Root Console Operations
# -----------------------------------------------------------------------------

def is_pid_alive_and_owned(pid: int, lab_dir: Path) -> bool:
    """Verify that PID is alive, belongs to QEMU, and references the exact full image path."""
    if pid <= 0:
        return False
    proc_cmdline = Path(f"/proc/{pid}/cmdline")
    if not proc_cmdline.exists():
        return False
    try:
        full_image_path = str((lab_dir / "worker.qcow2").resolve())
        cmdline = proc_cmdline.read_bytes().decode("utf-8", errors="replace").replace("\x00", " ")
        return ("qemu" in cmdline) and (full_image_path in cmdline)
    except Exception:
        return False


def ensure_vm_running(lab_dir: Path) -> int:
    """Check vm-state.json and start QEMU if not running, polling readiness via serial console."""
    state_file = lab_dir / "vm-state.json"
    state = read_private_json(state_file)
    pid = state.get("pid")

    if pid and is_pid_alive_and_owned(pid, lab_dir):
        return pid

    # Clean stale socket files if process dead
    for sock_name in ("serial.sock", "monitor.sock"):
        sock_path = lab_dir / sock_name
        if sock_path.exists():
            sock_path.unlink()

    worker_img = (lab_dir / "worker.qcow2").resolve()
    seed_iso = (lab_dir / "seed.iso").resolve()
    if not worker_img.exists():
        raise AcceptanceError(f"Worker disk image missing: {worker_img}")
    if not seed_iso.exists():
        raise AcceptanceError(f"Cloud-init seed image missing: {seed_iso}")

    qemu_cmd = [
        "qemu-system-x86_64",
        "-name", "zt-offboarding-lab",
        "-m", "768M",
        "-smp", "1",
        "-enable-kvm",
        "-drive", f"file={worker_img},format=qcow2,if=virtio",
        "-cdrom", str(seed_iso),
        "-netdev", f"user,id=net0,hostfwd=tcp:127.0.0.1:{SSH_PORT}-:22",
        "-device", "virtio-net-pci,netdev=net0",
        "-chardev", f"socket,id=serial0,path={lab_dir / 'serial.sock'},server=on,wait=off",
        "-serial", "chardev:serial0",
        "-chardev", f"socket,id=monitor0,path={lab_dir / 'monitor.sock'},server=on,wait=off",
        "-monitor", "chardev:monitor0",
        "-display", "none",
        "-daemonize",
        "-pidfile", str(lab_dir / "qemu.pid"),
    ]

    res = subprocess.run(qemu_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if res.returncode != 0:
        raise AcceptanceError(f"Failed to start QEMU: {res.stderr.decode('utf-8', errors='replace')}")

    # Poll for new PID
    new_pid = 0
    pid_file = lab_dir / "qemu.pid"
    for _ in range(10):
        if pid_file.exists():
            try:
                new_pid = int(pid_file.read_text().strip())
                if is_pid_alive_and_owned(new_pid, lab_dir):
                    break
            except ValueError:
                pass
        time.sleep(0.5)

    if not new_pid or not is_pid_alive_and_owned(new_pid, lab_dir):
        raise AcceptanceError("Failed to obtain running QEMU PID for owned lab VM.")

    write_private_json(state_file, {"running": True, "pid": new_pid, "boot_time": time.time()})

    # Poll serial console readiness
    console_mod = load_console_module(lab_dir)
    ready = False
    for _ in range(60):
        try:
            probe = console_mod.command(["echo", "ready_signal"], timeout=5)
            if probe.get("exit_code") == 0 and "ready_signal" in probe.get("stdout", ""):
                ready = True
                break
        except Exception:
            pass
        time.sleep(1)

    if not ready:
        raise AcceptanceError("VM failed serial console readiness check after boot.")

    return new_pid


def stop_vm(lab_dir: Path) -> None:
    """Stop the QEMU VM only if matching verified owned image process."""
    state_file = lab_dir / "vm-state.json"
    state = read_private_json(state_file)
    pid = state.get("pid")
    if pid and is_pid_alive_and_owned(pid, lab_dir):
        try:
            os.kill(pid, signal.SIGTERM)
            for _ in range(20):
                time.sleep(0.5)
                if not is_pid_alive_and_owned(pid, lab_dir):
                    break
            else:
                os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    write_private_json(state_file, {"running": False, "pid": None})


def load_console_module(lab_dir: Path):
    """Import console.py from lab-dir."""
    if str(lab_dir) not in sys.path:
        sys.path.insert(0, str(lab_dir))
    try:
        import console
        return console
    except ImportError as err:
        raise AcceptanceError(f"Unable to load console.py from {lab_dir}: {err}")


def console_exec(console_mod, argv: list[str], timeout: int = 120) -> dict:
    """Execute command in VM root serial console."""
    result = console_mod.command(argv, timeout=timeout)
    if not isinstance(result, dict) or "exit_code" not in result:
        raise AcceptanceError(f"Invalid console.command response structure: {result}")
    return result


def console_write_file(console_mod, data: bytes, dest_path: str, mode: str = "0600") -> None:
    """Transfer small private authorization or invitation payload via base64."""
    b64_content = base64.b64encode(data).decode("ascii")
    chunk_size = 4096
    console_exec(console_mod, ["rm", "-f", f"{dest_path}.b64", dest_path])
    for i in range(0, len(b64_content), chunk_size):
        chunk = b64_content[i:i + chunk_size]
        res = console_exec(console_mod, ["bash", "-c", f"printf '%s' '{chunk}' >> {dest_path}.b64"])
        if res.get("exit_code") != 0:
            raise AcceptanceError("Failed writing private chunk to VM.")
    decode_cmd = (
        f"base64 -d {dest_path}.b64 > {dest_path} && "
        f"rm -f {dest_path}.b64 && "
        f"chmod {mode} {dest_path}"
    )
    res = console_exec(console_mod, ["bash", "-c", decode_cmd])
    if res.get("exit_code") != 0:
        raise AcceptanceError(f"Failed decoding private base64 file on VM {dest_path}")


# -----------------------------------------------------------------------------
# Source Preparation, Mode Preservation & Artifact Packaging
# -----------------------------------------------------------------------------

def setup_source_copy(repo: Path, lab_dir: Path) -> tuple[Path, dict[str, str]]:
    """Copy tracked/clean source files to lab_dir/source preserving exact modes and symlink safety."""
    source_dir = lab_dir / "source"
    expected_source = (lab_dir / "source").resolve()

    if source_dir.exists():
        if source_dir.resolve() != expected_source:
            raise AcceptanceError(f"Refusing to delete unexpected source directory: {source_dir}")
        shutil.rmtree(source_dir)

    source_dir.mkdir(parents=True, mode=0o700)

    cmd = ["git", "-C", str(repo), "ls-files", "-c", "-o", "--exclude-standard"]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    file_list = proc.stdout.decode("utf-8").splitlines()

    pinned_shas: dict[str, str] = {}
    forbidden_components = {"keys", ".memory", ".git", "node_modules", "privateassets"}

    for rel_str in file_list:
        rel_str = rel_str.strip()
        if not rel_str:
            continue
        rel_path = Path(rel_str)

        # Check if any component in path is forbidden or a real env file
        def is_forbidden(p: Path) -> bool:
            for c in p.parts:
                if c in forbidden_components:
                    return True
                if c.startswith(".env"):
                    # Whitelist exact tracked public template .env.example / *.example
                    if c == ".env.example" or c.endswith(".example"):
                        continue
                    return True
            return False

        if is_forbidden(rel_path):
            continue

        src_path = repo / rel_path
        # Symlink check across path and parent directories
        if any(p.is_symlink() for p in (src_path, *src_path.parents)):
            continue
        if not src_path.is_file():
            continue

        dest_path = source_dir / rel_path
        dest_path.parent.mkdir(parents=True, exist_ok=True)

        content = src_path.read_bytes()
        dest_path.write_bytes(content)
        # Preserve original executable modes
        dest_path.chmod(src_path.stat().st_mode)
        pinned_shas[rel_str] = hashlib.sha256(content).hexdigest()

    # 1. Modify deploy/proxy/Caddyfile in lab copy
    caddyfile = source_dir / "deploy" / "proxy" / "Caddyfile"
    if caddyfile.exists():
        caddy_text = caddyfile.read_text(encoding="utf-8")
        caddy_text = re.sub(
            r"localhost:443, 127\.0\.0\.1:443, \[::1\]:443\s*\{[\s\S]*?tls internal",
            ":443 {\n    tls /tls/gateway.crt /tls/gateway.key",
            caddy_text,
            count=1,
        )
        caddyfile.write_text(caddy_text, encoding="utf-8")

    # 2. Modify docker-compose.yml for loopback WG bind
    compose_file = source_dir / "docker-compose.yml"
    if compose_file.exists():
        compose_text = compose_file.read_text(encoding="utf-8")
        compose_text = compose_text.replace(
            '"${WG_BIND_IP:-0.0.0.0}:${WG_HOST_PORT:-51820}:51820/udp"',
            f'"127.0.0.1:{WG_PORT}:51820/udp"',
        )
        compose_file.write_text(compose_text, encoding="utf-8")

    # 3. Modify compose.enrollment.yml to bind proxy /tls
    enrollment_compose = source_dir / "deploy" / "automation" / "compose.enrollment.yml"
    if enrollment_compose.exists():
        extra_bind = (
            "\n  proxy:\n"
            "    volumes:\n"
            f"      - type: bind\n"
            f"        source: {lab_dir / 'tls'}\n"
            "        target: /tls\n"
            "        read_only: true\n"
            "        bind:\n"
            "          create_host_path: false\n"
        )
        enrollment_compose.write_text(
            enrollment_compose.read_text(encoding="utf-8") + extra_bind,
            encoding="utf-8",
        )

    # 4. Fresh keys directory
    (source_dir / "keys").mkdir(parents=True, mode=0o700, exist_ok=True)

    # Save full pinned SHA mapping to private artifact
    write_private_json(lab_dir / "pinned-sources.json", pinned_shas)

    # Package public source tree for VM transfer
    tar_path = lab_dir / "zt-source.tar.gz"
    if tar_path.exists():
        tar_path.unlink()
    with tarfile.open(tar_path, "w:gz") as tar:
        tar.add(source_dir, arcname="zt-source")

    return source_dir, pinned_shas


def build_owned_images(source_dir: Path, gateway_tag: str, wg_tag: str) -> None:
    """Build unique owned lab images."""
    cmd_gw = ["docker", "build", "-t", gateway_tag, "-f", "Dockerfile", "."]
    res_gw = subprocess.run(cmd_gw, cwd=str(source_dir / "gateway"), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if res_gw.returncode != 0:
        raise AcceptanceError(f"Gateway image build failed: {res_gw.stderr.decode('utf-8', errors='replace')}")

    cmd_wg = ["docker", "build", "-t", wg_tag, "-f", "Dockerfile", "."]
    res_wg = subprocess.run(cmd_wg, cwd=str(source_dir / "deploy" / "wireguard"), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if res_wg.returncode != 0:
        raise AcceptanceError(f"WireGuard image build failed: {res_wg.stderr.decode('utf-8', errors='replace')}")


def build_agent_binary(source_dir: Path, lab_dir: Path) -> tuple[Path, str]:
    """Compile zt-agent with CGO_ENABLED=0."""
    agent_bin = lab_dir / "zt-agent"
    env = os.environ.copy()
    env["CGO_ENABLED"] = "0"
    cmd = ["go", "build", "-o", str(agent_bin), "."]
    res = subprocess.run(cmd, cwd=str(source_dir / "agent"), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if res.returncode != 0:
        raise AcceptanceError(f"Agent binary compilation failed: {res.stderr.decode('utf-8', errors='replace')}")
    content = agent_bin.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    return agent_bin, digest


# -----------------------------------------------------------------------------
# Gateway Controller Calls & API Client
# -----------------------------------------------------------------------------

def run_gateway_install(lab_dir: Path, source_dir: Path, project: str, gw_tag: str, wg_tag: str, ca_file: Path) -> None:
    """Run deploy/automation/gateway.py install using explicit python3 entrypoint."""
    admin_pw = secrets.token_hex(20)
    pw_input = json.dumps({"password": admin_pw}).encode("utf-8")

    cmd = [
        "docker", "run", "--rm",
        "--entrypoint", "python3",
        "--network", "host",
        "--add-host", f"{GATEWAY_FQDN}:127.0.0.1",
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        "-v", f"{lab_dir}:{lab_dir}",
        "-i",
        CONTROLLER_IMAGE,
        str(source_dir / "deploy" / "automation" / "gateway.py"),
        "install",
        "--project", project,
        "--endpoint", WORKER_ENDPOINT,
        "--public-url", HTTPS_ORIGIN,
        "--http-port", str(HTTP_PORT),
        "--https-port", str(HTTPS_PORT),
        "--wg-port", str(WG_PORT),
        "--skip-collector",
        "--ca-file", str(ca_file),
        "--admin-user", ADMIN_USER,
        "--password-stdin",
        "--gateway-image", gw_tag,
        "--proxy-image", PREBUILT_PROXY_IMAGE,
        "--wireguard-image", wg_tag,
    ]

    res = subprocess.run(cmd, input=pw_input, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if res.returncode != 0:
        raise AcceptanceError(f"Gateway installation failed ({res.returncode}): {res.stderr.decode('utf-8', errors='replace')}")


def mint_jwt_in_container(project: str) -> str:
    """Locate exact gateway container via Docker labels and mint admin JWT in container."""
    ps_cmd = [
        "docker", "ps",
        "--filter", f"label=com.docker.compose.project={project}",
        "--filter", "label=com.docker.compose.service=gateway",
        "--format", "{{.ID}}",
    ]
    ps_proc = subprocess.run(ps_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    container_id = ps_proc.stdout.decode().strip()
    if not container_id:
        raise AcceptanceError("Gateway container ID not found by compose labels.")

    # Inspect labels before execution
    insp_proc = subprocess.run(["docker", "inspect", "--format", "{{json .Config.Labels}}", container_id], stdout=subprocess.PIPE, check=True)
    labels = json.loads(insp_proc.stdout.decode())
    if labels.get("com.docker.compose.project") != project or labels.get("com.docker.compose.service") != "gateway":
        raise AcceptanceError("Container label verification failed before JWT minting.")

    script = (
        "const { Client } = require('pg');\n"
        "const crypto = require('crypto');\n"
        "async function run() {\n"
        "  const dbUrl = process.env.DATABASE_URL || "
        "    `postgres://${process.env.POSTGRES_USER || 'zt_admin'}:${process.env.POSTGRES_PASSWORD || ''}@"
        "${process.env.PGHOST || 'postgres'}:${process.env.PGPORT || '5432'}/${process.env.POSTGRES_DB || 'zt_serverops'}`;\n"
        "  const client = new Client({ connectionString: dbUrl });\n"
        "  await client.connect();\n"
        "  const res = await client.query('SELECT id, username, role, session_version FROM users WHERE username = $1', ['lab-admin']);\n"
        "  await client.end();\n"
        "  if (!res.rows[0]) throw new Error('User lab-admin not found');\n"
        "  const u = res.rows[0];\n"
        "  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');\n"
        "  const h = b64({ alg: 'HS256', typ: 'JWT' });\n"
        "  const p = b64({ id: u.id, username: u.username, role: u.role, session_version: u.session_version, exp: Math.floor(Date.now() / 1000) + 3600 });\n"
        "  const s = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${h}.${p}`).digest('base64url');\n"
        "  process.stdout.write(`${h}.${p}.${s}`);\n"
        "}\n"
        "run().catch(e => { console.error(e.message); process.exit(1); });\n"
    )

    cmd = ["docker", "exec", "-i", container_id, "node", "-e", script]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if res.returncode != 0:
        raise AcceptanceError(f"Minting admin JWT failed: {res.stderr.decode('utf-8', errors='replace')}")
    token = res.stdout.decode().strip()
    if not token or token.count(".") != 2:
        raise AcceptanceError("Invalid JWT token format minted from container.")
    return token


def make_https_request(
    method: str,
    url_path: str,
    ca_file: Path,
    headers: dict[str, str] | None = None,
    payload: dict | None = None,
) -> tuple[int, dict]:
    """Execute verified HTTPS API call using strict TLS, no proxy, no redirects."""
    opener = create_https_opener(ca_file)
    req_headers = dict(headers or {})
    data_bytes = None
    if payload is not None:
        data_bytes = json.dumps(payload).encode("utf-8")
        req_headers["Content-Type"] = "application/json"

    full_url = f"{LOOPBACK_HTTPS_URL}{url_path}"
    req = urllib.request.Request(full_url, data=data_bytes, headers=req_headers, method=method)

    try:
        with opener.open(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body) if body else {}
            return resp.status, data
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8")
        try:
            data = json.loads(body)
        except Exception:
            data = {"raw_error": err.reason}
        return err.code, data


def issue_invitation_via_controller(
    lab_dir: Path,
    source_dir: Path,
    project: str,
    node_name: str,
    output_path: Path,
) -> Path:
    """Issue invite in root-owned container /run/zt-invite directory and export securely to host."""
    runner_script = (
        "import subprocess, sys, os\n"
        "os.makedirs('/run/zt-invite', mode=0o700, exist_ok=True)\n"
        "out = '/run/zt-invite/invite.json'\n"
        "if os.path.exists(out): os.unlink(out)\n"
        f"cmd = ['python3', '{source_dir}/deploy/automation/gateway.py', 'invite', "
        f"'--project', '{project}', '--node-name', '{node_name}', '--worker-os', 'linux', '--output', out]\n"
        "res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)\n"
        "if res.returncode != 0:\n"
        "    sys.stderr.write(res.stderr.decode())\n"
        "    sys.exit(res.returncode)\n"
        "with open(out, 'rb') as f:\n"
        "    sys.stdout.buffer.write(f.read())\n"
    )

    cmd = [
        "docker", "run", "--rm",
        "--entrypoint", "python3",
        "--network", "host",
        "--add-host", f"{GATEWAY_FQDN}:127.0.0.1",
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        "-v", f"{lab_dir}:{lab_dir}",
        "-i",
        CONTROLLER_IMAGE,
        "-c", runner_script,
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if res.returncode != 0:
        raise AcceptanceError(f"Gateway invite issuance failed: {res.stderr.decode('utf-8', errors='replace')}")

    try:
        data = json.loads(res.stdout)
    except Exception:
        raise AcceptanceError("Failed to parse JSON invitation exported from controller.")

    write_private_json(output_path, data)
    return output_path


# -----------------------------------------------------------------------------
# Acceptance Execution Actions (1 to 5)
# -----------------------------------------------------------------------------

def run_step_setup(repo: Path, lab_dir: Path, checkpoint: LabCheckpoint, skip_build: bool) -> dict:
    """Action: setup - Prepare clean lab source copy, build images, compile agent."""
    if checkpoint.is_step_done("setup"):
        return checkpoint.get_step_data("setup")

    source_dir, pinned_shas = setup_source_copy(repo, lab_dir)
    gw_tag = f"{checkpoint.project}_gateway:latest"
    wg_tag = f"{checkpoint.project}_wireguard:latest"

    if not skip_build:
        build_owned_images(source_dir, gw_tag, wg_tag)

    agent_bin, agent_sha = build_agent_binary(source_dir, lab_dir)

    step_data = {
        "source_dir": str(source_dir),
        "gateway_image": gw_tag,
        "wireguard_image": wg_tag,
        "agent_binary": str(agent_bin),
        "agent_sha256": agent_sha,
        "pinned_file_count": len(pinned_shas),
    }
    checkpoint.record_step("setup", step_data)
    return step_data


def run_step_install(lab_dir: Path, checkpoint: LabCheckpoint) -> dict:
    """Action: install - Prerequisites, baseline recording, SCP transfer, worker install (Check 1)."""
    if checkpoint.is_step_done("install"):
        return checkpoint.get_step_data("install")

    setup_data = checkpoint.get_step_data("setup")
    source_dir = Path(setup_data["source_dir"])
    ca_file = lab_dir / "tls" / "ca.crt"
    if not ca_file.exists():
        raise AcceptanceError(f"CA certificate missing: {ca_file}")

    # 1. Boot VM and ensure console ready
    ensure_vm_running(lab_dir)
    console_mod = load_console_module(lab_dir)

    # 2. Install Guest prerequisites if missing
    apt_update = console_exec(console_mod, ["apt-get", "update"], timeout=180)
    if apt_update.get("exit_code") != 0:
        raise AcceptanceError("apt-get update failed on lab VM.")

    apt_inst = console_exec(
        console_mod,
        ["apt-get", "install", "-y", "--no-install-recommends", "wireguard-tools", "nftables", "openssh-server", "ca-certificates"],
        timeout=300,
    )
    if apt_inst.get("exit_code") != 0:
        raise AcceptanceError("Failed to install guest tool prerequisites on lab VM.")

    # Ensure SSH daemon running for pre-lockdown SCP transfer
    admin_pub = (lab_dir / "admin-key.pub").read_text(encoding="utf-8").strip()
    console_exec(console_mod, ["mkdir", "-p", "/root/.ssh"])
    console_exec(console_mod, ["chmod", "0700", "/root/.ssh"])
    console_exec(console_mod, ["sh", "-c", f"grep -qF '{admin_pub}' /root/.ssh/authorized_keys 2>/dev/null || echo '{admin_pub}' >> /root/.ssh/authorized_keys"])
    console_exec(console_mod, ["chmod", "0600", "/root/.ssh/authorized_keys"])
    console_exec(console_mod, ["systemctl", "restart", "ssh"])

    # 3. Record Baseline State in VM (Check 1)
    ssh_hostkey_res = console_exec(console_mod, ["sha256sum", "/etc/ssh/ssh_host_ed25519_key.pub"])
    sshd_conf_res = console_exec(console_mod, ["sha256sum", "/etc/ssh/sshd_config"])
    ssh_active_res = console_exec(console_mod, ["systemctl", "is-active", "ssh"])
    ssh_enabled_res = console_exec(console_mod, ["systemctl", "is-enabled", "ssh"])

    hostkey_hash = ssh_hostkey_res.get("stdout", "").strip().split()[0] if ssh_hostkey_res.get("exit_code") == 0 else ""
    sshd_hash = sshd_conf_res.get("stdout", "").strip().split()[0] if sshd_conf_res.get("exit_code") == 0 else ""

    if len(hostkey_hash) != 64 or len(sshd_hash) != 64:
        raise AcceptanceError("Invalid or empty baseline hash captured for SSH hostkey or sshd_config.")

    baseline = {
        "ssh_hostkey_hash": hostkey_hash,
        "sshd_config_hash": sshd_hash,
        "ssh_active": ssh_active_res.get("stdout", "").strip(),
        "ssh_enabled": ssh_enabled_res.get("stdout", "").strip(),
    }

    # Create unrelated nftables table
    nft_add = console_exec(console_mod, ["nft", "add", "table", "inet", "zt_keep_on_uninstall"])
    if nft_add.get("exit_code") != 0:
        raise AcceptanceError("Failed to create unrelated nftables table zt_keep_on_uninstall.")

    # 4. Transfer full public source tree & Agent binary via SCP before install
    tar_path = lab_dir / "zt-source.tar.gz"
    scp_cmd = [
        "scp",
        "-P", str(SSH_PORT),
        "-i", str(lab_dir / "admin-key"),
        "-o", "StrictHostKeyChecking=yes",
        "-o", f"UserKnownHostsFile={lab_dir / 'known_hosts'}",
        "-o", "ConnectTimeout=15",
        str(tar_path),
        str(lab_dir / "zt-agent"),
        f"root@127.0.0.1:/root/",
    ]
    scp_res = subprocess.run(scp_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if scp_res.returncode != 0:
        raise AcceptanceError(f"SCP transfer of zt-source and zt-agent failed: {scp_res.stderr.decode('utf-8', errors='replace')}")

    console_exec(console_mod, ["tar", "-xzf", "/root/zt-source.tar.gz", "-C", "/root"])
    console_exec(console_mod, ["rm", "-f", "/root/zt-source.tar.gz"])
    console_exec(console_mod, ["chmod", "0755", "/root/zt-agent"])

    # 5. Install Gateway
    run_gateway_install(
        lab_dir, source_dir, checkpoint.project,
        setup_data["gateway_image"], setup_data["wireguard_image"], ca_file,
    )

    health_status, _ = make_https_request("GET", "/healthz", ca_file)
    if health_status != 200:
        raise AcceptanceError(f"Gateway /healthz returned status {health_status}")

    # 6. Issue Worker invitation and transfer via console writer
    admin_jwt = mint_jwt_in_container(checkpoint.project)
    invite_path = lab_dir / "invite.json"
    if invite_path.exists():
        invite_path.unlink()
    issue_invitation_via_controller(lab_dir, source_dir, checkpoint.project, NODE_NAME, invite_path)

    console_write_file(console_mod, invite_path.read_bytes(), "/root/invite.json", "0600")
    console_write_file(console_mod, ca_file.read_bytes(), "/root/ca.crt", "0644")

    # 7. Execute /root/zt-source/deploy/automation/worker.py install
    agent_sha = setup_data["agent_sha256"]
    install_cmd = [
        "python3", "/root/zt-source/deploy/automation/worker.py", "install",
        "--dedicated-worker",
        "--invite", "/root/invite.json",
        "--agent-binary", "/root/zt-agent",
        "--agent-sha256", agent_sha,
        "--ca-file", "/root/ca.crt",
    ]
    install_res = console_exec(console_mod, install_cmd, timeout=180)
    if install_res.get("exit_code") != 0:
        raise AcceptanceError(f"VM worker.py install failed: {install_res.get('stderr')}")

    # 8. Create user sentinel file now that ztuser is created
    sentinel_cmd = (
        "echo 'user-sentinel-data' > /home/ztuser/user-sentinel.txt && "
        "chown ztuser:ztuser /home/ztuser/user-sentinel.txt && "
        "chmod 0600 /home/ztuser/user-sentinel.txt"
    )
    sent_res = console_exec(console_mod, ["bash", "-c", sentinel_cmd])
    if sent_res.get("exit_code") != 0:
        raise AcceptanceError("Failed to create /home/ztuser/user-sentinel.txt")

    # 9. Verify Check 1 Invariants: actual zt-worker interface, zt_worker_auto table, active unit
    wg_check = console_exec(console_mod, ["ip", "link", "show", "zt-worker"])
    if wg_check.get("exit_code") != 0:
        raise AcceptanceError("WireGuard zt-worker link was not created on the VM.")

    nft_check = console_exec(console_mod, ["nft", "list", "table", "inet", "zt_worker_auto"])
    if nft_check.get("exit_code") != 0:
        raise AcceptanceError("Owned nftables table zt_worker_auto was not created on the VM.")

    agent_check = console_exec(console_mod, ["systemctl", "is-active", "zt-agent"])
    if agent_check.get("stdout", "").strip() != "active":
        raise AcceptanceError(f"zt-agent service is not active: {agent_check.get('stdout')}")

    # Query active node UUID from Gateway API (route returns { success: true, data: [...] })
    headers = {"Authorization": f"Bearer {admin_jwt}"}
    status, nodes_resp = make_https_request("GET", "/api/nodes", ca_file, headers=headers)
    if status != 200 or not isinstance(nodes_resp, dict) or "data" not in nodes_resp:
        raise AcceptanceError(f"Failed to query nodes list: status {status}")

    node_entry = next((n for n in nodes_resp["data"] if n.get("name") == NODE_NAME), None)
    if not node_entry:
        raise AcceptanceError(f"Node {NODE_NAME} not found in Gateway active node registry.")

    step_data = {
        "node_id": node_entry["id"],
        "node_ip": node_entry.get("ip_address"),
        "baseline": baseline,
    }
    checkpoint.record_step("install", step_data)
    return step_data


def run_step_offboard(lab_dir: Path, checkpoint: LabCheckpoint) -> dict:
    """Action: offboard - Initiate offboarding, poll lifecycle_state to REVOKED, beacon 401 check (Check 2)."""
    if checkpoint.is_step_done("offboard"):
        return checkpoint.get_step_data("offboard")

    install_data = checkpoint.get_step_data("install")
    node_id = install_data["node_id"]
    ca_file = lab_dir / "tls" / "ca.crt"
    admin_jwt = mint_jwt_in_container(checkpoint.project)
    headers = {"Authorization": f"Bearer {admin_jwt}"}

    # 1. POST /api/nodes/:id/offboarding
    status, begin_resp = make_https_request(
        "POST", f"/api/nodes/{node_id}/offboarding", ca_file,
        headers=headers, payload={"confirm_node_name": NODE_NAME},
    )
    if status not in (200, 202):
        raise AcceptanceError(f"POST /api/nodes/{node_id}/offboarding failed: status {status}")

    # 2. Bounded poll until offboarding.lifecycle_state reaches REVOKED
    revoked = False
    for _ in range(30):
        time.sleep(2)
        st, poll_resp = make_https_request("GET", f"/api/nodes/{node_id}/offboarding", ca_file, headers=headers)
        if st == 200 and isinstance(poll_resp, dict):
            lifecycle_state = poll_resp.get("offboarding", {}).get("lifecycle_state")
            if lifecycle_state == "REVOKED":
                revoked = True
                break
    if not revoked:
        raise AcceptanceError("Offboarding lifecycle_state did not reach REVOKED within timeout.")

    # 3. Check 2: Verify guest beacon returns 401 REVOKED_NODE_TOKEN using node UUID
    console_mod = load_console_module(lab_dir)
    beacon_test_script = (
        "import urllib.request, ssl, json, re, time\n"
        "env_lines = open('/opt/zt-serverops/agent/.env').read().splitlines()\n"
        "env_dict = dict(l.split('=', 1) for l in env_lines if '=' in l)\n"
        "tok = env_dict.get('NODE_TOKEN', '')\n"
        f"nid = '{node_id}'\n"
        "ctx = ssl.create_default_context(cafile='/root/ca.crt')\n"
        "payload = json.dumps({\n"
        "    'node_id': nid,\n"
        "    'timestamp': int(time.time()),\n"
        "    'metrics': {\n"
        "        'cpu': {'percent': 25.0},\n"
        "        'memory': {'total_bytes': 2048, 'used_bytes': 1024, 'percent': 50.0},\n"
        "        'disk': {'total_bytes': 8192, 'used_bytes': 4096, 'percent': 50.0},\n"
        "        'network': {'rx_bytes_total': 100, 'tx_bytes_total': 200},\n"
        "        'uptime_seconds': 500\n"
        "    }\n"
        "}).encode()\n"
        "req = urllib.request.Request('https://gateway.offboarding.test:24444/api/telemetry/beacon', "
        "data=payload, headers={'X-Node-Token': tok, 'Content-Type': 'application/json'})\n"
        "try:\n"
        "    with urllib.request.urlopen(req, context=ctx) as r:\n"
        "        print(json.dumps({'status': r.status}))\n"
        "except urllib.error.HTTPError as e:\n"
        "    err_body = json.loads(e.read().decode())\n"
        "    print(json.dumps({'status': e.code, 'code': err_body.get('code')}))\n"
    )
    b_res = console_exec(console_mod, ["python3", "-c", beacon_test_script], timeout=30)
    try:
        b_json = json.loads(b_res.get("stdout", "").strip().splitlines()[-1])
    except Exception:
        raise AcceptanceError("Beacon verification check produced invalid output.")

    if b_json.get("status") != 401 or b_json.get("code") != "REVOKED_NODE_TOKEN":
        raise AcceptanceError(f"Beacon check failed: expected 401 REVOKED_NODE_TOKEN, got {b_json.get('status')} {b_json.get('code')}")

    # 4. Fetch private offboarding authorization bundle
    st, auth_resp = make_https_request("POST", f"/api/nodes/{node_id}/offboarding/authorization", ca_file, headers=headers)
    if st != 200 or not isinstance(auth_resp, dict) or "cleanup_token" not in auth_resp:
        raise AcceptanceError(f"Failed to retrieve authorization bundle: status {st}")

    auth_file = lab_dir / "offboarding.json"
    write_private_json(auth_file, auth_resp)

    # 5. Transfer authorization bundle to VM via root console writer
    console_write_file(console_mod, auth_file.read_bytes(), "/root/offboarding.json", "0600")

    step_data = {
        "operation_id": auth_resp.get("operation_id"),
        "beacon_check_status": b_json.get("status"),
        "beacon_check_code": b_json.get("code"),
    }
    checkpoint.record_step("offboard", step_data)
    return step_data


def run_step_verify(lab_dir: Path, checkpoint: LabCheckpoint) -> dict:
    """Action: verify - Execute Worker uninstall, verify full cleanup, test retry & reinstall (Checks 3 & 4)."""
    if checkpoint.is_step_done("verify"):
        return checkpoint.get_step_data("verify")

    install_data = checkpoint.get_step_data("install")
    old_node_id = install_data["node_id"]
    baseline = install_data["baseline"]
    ca_file = lab_dir / "tls" / "ca.crt"
    admin_jwt = mint_jwt_in_container(checkpoint.project)
    headers = {"Authorization": f"Bearer {admin_jwt}"}
    console_mod = load_console_module(lab_dir)

    # 1. Execute worker.py uninstall via root console (Check 3)
    uninst_res = console_exec(
        console_mod,
        ["python3", "/root/zt-source/deploy/automation/worker.py", "uninstall", "--authorization", "/root/offboarding.json", "--ca-file", "/root/ca.crt"],
        timeout=180,
    )
    if uninst_res.get("exit_code") != 0:
        raise AcceptanceError("Worker uninstall command failed on VM.")

    # 2. Bounded poll Gateway remote status to REMOVED
    removed = False
    for _ in range(30):
        time.sleep(2)
        st, poll_resp = make_https_request("GET", f"/api/nodes/{old_node_id}/offboarding", ca_file, headers=headers)
        if st == 200 and isinstance(poll_resp, dict):
            lifecycle_state = poll_resp.get("offboarding", {}).get("lifecycle_state")
            if lifecycle_state == "REMOVED":
                removed = True
                break
    if not removed:
        raise AcceptanceError("Gateway offboarding lifecycle_state did not reach REMOVED.")

    # 3. Independent Local VM Verification (Check 3)
    # 3.1 Agent unit inactive & binary removed
    agent_unit = console_exec(console_mod, ["systemctl", "is-active", "zt-agent"])
    if agent_unit.get("stdout", "").strip() == "active":
        raise AcceptanceError("zt-agent systemd service is still active after uninstall.")

    if console_exec(console_mod, ["test", "-f", "/opt/zt-serverops/agent/zt-agent"]).get("exit_code") == 0:
        raise AcceptanceError("Agent binary was not removed.")
    if console_exec(console_mod, ["test", "-f", "/opt/zt-serverops/agent/.env"]).get("exit_code") == 0:
        raise AcceptanceError("Agent .env secret file was not removed.")
    if console_exec(console_mod, ["test", "-f", "/etc/wireguard/zt-worker.conf"]).get("exit_code") == 0:
        raise AcceptanceError("WireGuard tunnel configuration was not removed.")
    if console_exec(console_mod, ["test", "-f", "/var/lib/zt-serverops/enrollment/cleanup.capability"]).get("exit_code") == 0:
        raise AcceptanceError("cleanup.capability was not wiped.")

    # 3.2 WireGuard tunnel down
    if console_exec(console_mod, ["ip", "link", "show", "zt-worker"]).get("exit_code") == 0:
        raise AcceptanceError("WireGuard zt-worker link still exists on VM.")

    # 3.3 Owned firewall rules removed
    if console_exec(console_mod, ["nft", "list", "table", "inet", "zt_worker_auto"]).get("exit_code") == 0:
        raise AcceptanceError("Owned nftables table zt_worker_auto was not removed.")

    # 3.4 Unrelated firewall rules intact
    if console_exec(console_mod, ["nft", "list", "table", "inet", "zt_keep_on_uninstall"]).get("exit_code") != 0:
        raise AcceptanceError("Unrelated nftables table zt_keep_on_uninstall was unexpectedly removed.")

    # 3.5 Sentinel file intact
    sentinel_res = console_exec(console_mod, ["cat", "/home/ztuser/user-sentinel.txt"])
    if sentinel_res.get("stdout", "").strip() != "user-sentinel-data":
        raise AcceptanceError("/home/ztuser/user-sentinel.txt was damaged or altered.")

    # 3.6 SSH hostkey and service states preserved
    ssh_hostkey_res = console_exec(console_mod, ["sha256sum", "/etc/ssh/ssh_host_ed25519_key.pub"])
    if ssh_hostkey_res.get("stdout", "").strip().split()[0] != baseline["ssh_hostkey_hash"]:
        raise AcceptanceError("OS SSH host key was altered during uninstall.")

    sshd_conf_res = console_exec(console_mod, ["sha256sum", "/etc/ssh/sshd_config"])
    if sshd_conf_res.get("stdout", "").strip().split()[0] != baseline["sshd_config_hash"]:
        raise AcceptanceError("sshd_config does not match baseline after uninstall.")

    ssh_act = console_exec(console_mod, ["systemctl", "is-active", "ssh"]).get("stdout", "").strip()
    if ssh_act != baseline["ssh_active"]:
        raise AcceptanceError(f"SSH service active state altered: {ssh_act} != {baseline['ssh_active']}")

    # 4. Cleanup Retry / Idempotency Check
    retry_res = console_exec(
        console_mod,
        ["python3", "/root/zt-source/deploy/automation/worker.py", "cleanup-retry", "--authorization", "/root/offboarding.json", "--ca-file", "/root/ca.crt"],
        timeout=60,
    )
    if retry_res.get("exit_code") != 0:
        raise AcceptanceError("cleanup-retry failed on idempotent invocation.")

    # 5. Reinstall Test (Check 4)
    setup_data = checkpoint.get_step_data("setup")
    source_dir = Path(setup_data["source_dir"])
    agent_sha = setup_data["agent_sha256"]

    invite2_path = lab_dir / "invite2.json"
    if invite2_path.exists():
        invite2_path.unlink()
    issue_invitation_via_controller(lab_dir, source_dir, checkpoint.project, NODE_NAME, invite2_path)

    console_write_file(console_mod, invite2_path.read_bytes(), "/root/invite2.json", "0600")

    install2_res = console_exec(
        console_mod,
        [
            "python3", "/root/zt-source/deploy/automation/worker.py", "install",
            "--dedicated-worker",
            "--invite", "/root/invite2.json",
            "--agent-binary", "/root/zt-agent",
            "--agent-sha256", agent_sha,
            "--ca-file", "/root/ca.crt",
        ],
        timeout=180,
    )
    if install2_res.get("exit_code") != 0:
        raise AcceptanceError("Worker re-installation failed.")

    # Verify new node registration and distinct UUID / identity
    st, nodes_resp2 = make_https_request("GET", "/api/nodes?lifecycle=all", ca_file, headers=headers)
    if st != 200 or "data" not in nodes_resp2:
        raise AcceptanceError("Failed to query nodes after reinstallation.")

    old_node_record = next((n for n in nodes_resp2["data"] if n.get("id") == old_node_id), None)
    if not old_node_record or old_node_record.get("lifecycle_state") != "REMOVED":
        raise AcceptanceError("Gateway history retention failed: old node record is not REMOVED.")

    active_nodes = [n for n in nodes_resp2["data"] if n.get("name") == NODE_NAME and n.get("lifecycle_state") == "ACTIVE"]
    if not active_nodes:
        raise AcceptanceError("Reinstalled node is not active in Gateway.")
    new_node = active_nodes[0]
    if new_node["id"] == old_node_id:
        raise AcceptanceError("Reinstalled node reused previous Node UUID.")

    # Positive control: Active reinstalled node sends valid beacon and succeeds with 200
    pos_beacon_script = (
        "import urllib.request, ssl, json, time\n"
        "env_lines = open('/opt/zt-serverops/agent/.env').read().splitlines()\n"
        "env_dict = dict(l.split('=', 1) for l in env_lines if '=' in l)\n"
        "tok = env_dict.get('NODE_TOKEN', '')\n"
        f"nid = '{new_node['id']}'\n"
        "ctx = ssl.create_default_context(cafile='/root/ca.crt')\n"
        "payload = json.dumps({\n"
        "    'node_id': nid,\n"
        "    'timestamp': int(time.time()),\n"
        "    'metrics': {\n"
        "        'cpu': {'percent': 10.0},\n"
        "        'memory': {'total_bytes': 2048, 'used_bytes': 512, 'percent': 25.0},\n"
        "        'disk': {'total_bytes': 8192, 'used_bytes': 1024, 'percent': 12.5},\n"
        "        'network': {'rx_bytes_total': 10, 'tx_bytes_total': 20},\n"
        "        'uptime_seconds': 100\n"
        "    }\n"
        "}).encode()\n"
        "req = urllib.request.Request('https://gateway.offboarding.test:24444/api/telemetry/beacon', "
        "data=payload, headers={'X-Node-Token': tok, 'Content-Type': 'application/json'})\n"
        "try:\n"
        "    with urllib.request.urlopen(req, context=ctx) as r:\n"
        "        print(json.dumps({'status': r.status}))\n"
        "except urllib.error.HTTPError as e:\n"
        "    print(json.dumps({'status': e.code}))\n"
    )
    pos_b_res = console_exec(console_mod, ["python3", "-c", pos_beacon_script], timeout=30)
    pos_json = json.loads(pos_b_res.get("stdout", "").strip().splitlines()[-1])
    if pos_json.get("status") != 200:
        raise AcceptanceError(f"Reinstalled active beacon failed positive control: status {pos_json.get('status')}")

    # Assert old authorization bundle is rejected against new installation
    old_auth_exec = console_exec(
        console_mod,
        ["python3", "/root/zt-source/deploy/automation/worker.py", "uninstall", "--authorization", "/root/offboarding.json", "--ca-file", "/root/ca.crt"],
        timeout=60,
    )
    if old_auth_exec.get("exit_code") == 0:
        raise AcceptanceError("Reinstalled node accepted obsolete offboarding authorization bundle.")

    # Reinstalled agent must remain active
    agent2_check = console_exec(console_mod, ["systemctl", "is-active", "zt-agent"])
    if agent2_check.get("stdout", "").strip() != "active":
        raise AcceptanceError("Reinstalled zt-agent was improperly disrupted by obsolete authorization.")

    step_data = {
        "old_node_id": old_node_id,
        "new_node_id": new_node["id"],
        "history_retained": True,
        "positive_beacon_verified": True,
        "obsolete_authorization_rejected": True,
    }
    checkpoint.record_step("verify", step_data)
    return step_data


def run_step_cleanup(lab_dir: Path, checkpoint: LabCheckpoint) -> dict:
    """Action: cleanup - Stop owned compose project, remove owned images and QEMU (Check 5)."""
    setup_data = checkpoint.get_step_data("setup")
    source_dir_str = setup_data.get("source_dir")
    project = checkpoint.project

    # 1. Stop owned docker compose project using its generated automation.env
    if source_dir_str and Path(source_dir_str).exists():
        env_file = Path(source_dir_str) / "keys" / "automation.env"
        if env_file.exists():
            compose_cmd = [
                "docker", "compose",
                "-f", str(Path(source_dir_str) / "docker-compose.yml"),
                "-f", str(Path(source_dir_str) / "deploy" / "automation" / "compose.enrollment.yml"),
                "--env-file", str(env_file),
                "-p", project,
                "down", "-v",
            ]
            res_comp = subprocess.run(compose_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if res_comp.returncode != 0:
                raise AcceptanceError(f"Compose teardown failed: {res_comp.stderr.decode('utf-8', errors='replace')}")

    # Ensure no leftover containers for this exact project label
    ps_proc = subprocess.run(
        ["docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={project}"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
    )
    remaining_cids = ps_proc.stdout.decode().split()
    if remaining_cids:
        subprocess.run(["docker", "stop", *remaining_cids], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        subprocess.run(["docker", "rm", "-v", *remaining_cids], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)

    # 2. Remove unique owned images matching exact project tag
    for img_tag in (f"{project}_gateway:latest", f"{project}_wireguard:latest"):
        insp = subprocess.run(["docker", "image", "inspect", img_tag], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if insp.returncode == 0:
            subprocess.run(["docker", "rmi", img_tag], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    # 3. Stop owned QEMU process cleanly
    stop_vm(lab_dir)

    # 4. Save structured final acceptance proof
    final_evidence = {
        "timestamp": time.time(),
        "project": project,
        "checks": {
            "check1_install_baseline_recorded": checkpoint.is_step_done("install"),
            "check2_revocation_and_beacon_401": checkpoint.is_step_done("offboard"),
            "check3_uninstall_and_vm_cleanup": checkpoint.is_step_done("verify"),
            "check4_reinstall_and_auth_isolation": checkpoint.is_step_done("verify"),
            "check5_owned_runtime_cleanup": True,
        },
        "limits": {
            "native_windows": "NOT_RUN",
            "independent_internet": "NOT_RUN",
            "metrics_collector": "NOT_RUN",
        },
        "steps": checkpoint.state.get("steps", {}),
    }

    result_path = lab_dir / "acceptance-result.json"
    write_private_json(result_path, final_evidence)

    checkpoint.record_step("cleanup", {"result_file": str(result_path)})
    return final_evidence


# -----------------------------------------------------------------------------
# Main Entrypoint
# -----------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Native Linux Worker Offboarding Acceptance Driver",
    )
    parser.add_argument(
        "--lab-dir",
        type=Path,
        default=Path(os.environ.get("ZT_LAB_DIR", "")),
        help="Private prepared VM lab directory (must be outside repository).",
    )
    parser.add_argument(
        "--repo",
        type=Path,
        default=Path.cwd(),
        help="Path to ZT-ServerOps repository root.",
    )
    parser.add_argument(
        "action",
        nargs="?",
        choices=("setup", "install", "offboard", "verify", "cleanup", "all"),
        default="all",
        help="Lifecycle action to execute (default: all with resumable checkpoints).",
    )
    parser.add_argument(
        "--skip-build",
        action="store_true",
        help="Skip Docker image building if images were previously generated.",
    )
    return parser.parse_args()


def main() -> int:
    os.umask(0o077)
    args = parse_args()

    if not args.lab_dir or str(args.lab_dir) == "":
        print(
            json.dumps({"ok": False, "error": "--lab-dir is required or set ZT_LAB_DIR."}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 2

    try:
        guard_paths(args.repo, args.lab_dir)
    except AcceptanceError as err:
        print(json.dumps({"ok": False, "error": str(err)}, ensure_ascii=False), file=sys.stderr)
        return 2

    checkpoint_file = args.lab_dir / "acceptance-checkpoint.json"
    checkpoint = LabCheckpoint(checkpoint_file)

    try:
        if args.action in ("setup", "all"):
            run_step_setup(args.repo, args.lab_dir, checkpoint, args.skip_build)
        if args.action in ("install", "all"):
            run_step_install(args.lab_dir, checkpoint)
        if args.action in ("offboard", "all"):
            run_step_offboard(args.lab_dir, checkpoint)
        if args.action in ("verify", "all"):
            run_step_verify(args.lab_dir, checkpoint)
        if args.action in ("cleanup", "all"):
            run_step_cleanup(args.lab_dir, checkpoint)

        summary = {
            "ok": True,
            "action": args.action,
            "project": checkpoint.project,
            "lab_dir": str(args.lab_dir),
            "completed_steps": list(checkpoint.state.get("steps", {}).keys()),
            "limits": {
                "native_windows": "NOT_RUN",
                "independent_internet": "NOT_RUN",
                "metrics_collector": "NOT_RUN",
            },
        }
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return 0

    except AcceptanceError as err:
        err_summary = {
            "ok": False,
            "action": args.action,
            "error": str(err),
            "completed_steps": list(checkpoint.state.get("steps", {}).keys()),
        }
        print(json.dumps(err_summary, indent=2, ensure_ascii=False), file=sys.stderr)
        return 1
    except Exception as exc:
        err_summary = {
            "ok": False,
            "action": args.action,
            "error": f"Unexpected driver exception: {type(exc).__name__}",
            "completed_steps": list(checkpoint.state.get("steps", {}).keys()),
        }
        print(json.dumps(err_summary, indent=2, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
