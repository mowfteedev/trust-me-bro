#!/usr/bin/env python3
"""Browser acceptance test harness for Worker offboarding UI.

Runs real Firefox headless against dashboard/dist served via an ephemeral
ThreadingHTTPServer on 127.0.0.1 with an explicitly fake API fixture.
Does not touch real Gateway, PostgreSQL, WireGuard or cloud machines.
"""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import threading
from urllib.parse import parse_qs, unquote, urlsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ISO timestamp helper
def iso_now():
    return datetime.now(timezone.utc).isoformat()

# Node Fixtures
NODE_A = {
    "id": "11111111-aaaa-4111-8aaa-111111111111",
    "name": "worker-alpha",
    "ip_address": "10.100.0.11",
    "node_type": "VM",
    "status": "HEALTHY",
    "last_seen": iso_now(),
    "created_at": iso_now(),
    "lifecycle_state": "ACTIVE",
    "is_token_revoked": False,
    "is_enrolled": True,
    "latest_metric": {
        "cpu_percent": 14.5,
        "memory_used_bytes": 1073741824,
        "memory_total_bytes": 4294967296,
        "disk_used_bytes": 5368709120,
        "disk_total_bytes": 21474836480,
        "recorded_at": iso_now(),
    },
}

NODE_B = {
    "id": "22222222-bbbb-4222-8bbb-222222222222",
    "name": "worker-beta",
    "ip_address": "10.100.0.22",
    "node_type": "VM",
    "status": "HEALTHY",
    "last_seen": iso_now(),
    "created_at": iso_now(),
    "lifecycle_state": "ACTIVE",
    "is_token_revoked": False,
    "is_enrolled": True,
    "latest_metric": {
        "cpu_percent": 27.8,
        "memory_used_bytes": 2147483648,
        "memory_total_bytes": 4294967296,
        "disk_used_bytes": 8589934592,
        "disk_total_bytes": 21474836480,
        "recorded_at": iso_now(),
    },
}

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}

PAGE_ERROR_OBSERVER = b"""<script>
window.ztPageErrors = window.ztPageErrors || [];
window.addEventListener('error', function(e) {
  window.ztPageErrors.push({type: 'error', msg: e.message || String(e), file: e.filename || '', line: e.lineno || 0});
});
window.addEventListener('unhandledrejection', function(e) {
  window.ztPageErrors.push({type: 'unhandledrejection', msg: String(e.reason || e)});
});
</script>"""


class MockServerState:
    def __init__(self):
        self.lock = threading.Lock()
        self.nodes = {
            NODE_A["id"]: dict(NODE_A),
            NODE_B["id"]: dict(NODE_B),
        }
        self.offboarding_ops = {}
        self.error_node_id = None
        self.recorded_offboard_posts = []
        self.recorded_auth_downloads = []

    def reset_b_to_retiring(self):
        with self.lock:
            op_b = {
                "operation_id": "op-22222222",
                "node_id": NODE_B["id"],
                "node_name": NODE_B["name"],
                "node_ip": NODE_B["ip_address"],
                "node_type": NODE_B["node_type"],
                "worker_os": "linux",
                "wireguard_public_key": "fake-wg-pubkey-base64=",
                "state": "PENDING_LOCAL_CLEANUP",
                "lifecycle_state": "RETIRING",
                "created_at": iso_now(),
                "peer_removed_at": iso_now(),
                "completed_at": None,
                "last_error": None,
                "has_cleanup_token": False,
            }
            self.offboarding_ops[NODE_B["id"]] = op_b
            self.nodes[NODE_B["id"]]["lifecycle_state"] = "RETIRING"
            self.nodes[NODE_B["id"]]["is_token_revoked"] = True

    def mark_b_completed(self):
        with self.lock:
            if NODE_B["id"] in self.offboarding_ops:
                self.offboarding_ops[NODE_B["id"]]["state"] = "COMPLETED"
                self.offboarding_ops[NODE_B["id"]]["lifecycle_state"] = "REMOVED"
                self.offboarding_ops[NODE_B["id"]]["completed_at"] = iso_now()
            self.nodes[NODE_B["id"]]["lifecycle_state"] = "REMOVED"
            self.nodes[NODE_B["id"]]["is_token_revoked"] = True


def make_handler(dist_dir: Path, state: MockServerState):
    dist_resolved = dist_dir.resolve()

    class DashboardHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            # Silence default stderr logging
            pass

        def send_json(self, status: int, payload: dict, headers: dict = None):
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            if headers:
                for k, v in headers.items():
                    self.send_header(k, v)
            self.end_headers()
            self.wfile.write(raw)

        def serve_static(self, clean_path: str):
            # Safe static path traversal guard
            target = (dist_resolved / clean_path.lstrip("/")).resolve()
            try:
                target.relative_to(dist_resolved)
            except ValueError:
                self.send_error(403, "Access denied")
                return

            if not target.is_file():
                # SPA Fallback
                target = dist_resolved / "index.html"

            if not target.is_file():
                self.send_error(404, "Not found")
                return

            ext = target.suffix.lower()
            content_type = MIME_TYPES.get(ext, "application/octet-stream")
            try:
                data = target.read_bytes()
            except OSError:
                self.send_error(500, "Error reading file")
                return

            # Inject error observer snippet directly before app scripts run
            if target.name == "index.html":
                if b"<head>" in data:
                    data = data.replace(b"<head>", b"<head>\n" + PAGE_ERROR_OBSERVER, 1)
                elif b"<!DOCTYPE html>" in data:
                    data = data.replace(b"<!DOCTYPE html>", b"<!DOCTYPE html>\n" + PAGE_ERROR_OBSERVER, 1)
                else:
                    data = PAGE_ERROR_OBSERVER + data

            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            parsed = urlsplit(self.path)
            clean_path = unquote(parsed.path)
            query = parse_qs(parsed.query)

            if clean_path == "/healthz":
                return self.send_json(200, {"status": "ok"})

            if clean_path == "/api/host":
                host_snapshot = {
                    "sampled_at": iso_now(),
                    "stale": False,
                    "host": {
                        "hostname": "gateway-harness",
                        "cpu_percent": 12.0,
                        "memory_used_bytes": 1073741824,
                        "memory_total_bytes": 4294967296,
                        "disk_used_bytes": 5368709120,
                        "disk_total_bytes": 21474836480,
                        "uptime_seconds": 3600,
                        "network_rx_bytes": 100000,
                        "network_tx_bytes": 100000,
                        "network_interface": "wg0",
                    },
                    "services": [
                        {"id": "gateway", "name": "Gateway API", "state": "healthy", "started_at": iso_now(), "restarts": 0, "observations": []},
                        {"id": "proxy", "name": "Reverse Proxy", "state": "healthy", "started_at": iso_now(), "restarts": 0, "observations": []},
                        {"id": "postgres", "name": "PostgreSQL", "state": "healthy", "started_at": iso_now(), "restarts": 0, "observations": []},
                        {"id": "wireguard_gateway", "name": "WireGuard Gateway", "state": "healthy", "started_at": iso_now(), "restarts": 0, "observations": []},
                    ],
                }
                return self.send_json(200, host_snapshot)

            if clean_path == "/api/incidents":
                return self.send_json(200, {"success": True, "data": [], "pagination": {"page": 1, "page_size": 20, "total": 0, "total_pages": 1}})

            if clean_path == "/api/audit/logs":
                return self.send_json(200, {"success": True, "data": [], "page": 1, "page_size": 20, "has_more": False})

            if clean_path == "/api/telemetry/nodes":
                lifecycle_filter = query.get("lifecycle", ["active"])[0]
                with state.lock:
                    node_list = list(state.nodes.values())
                    if lifecycle_filter == "active":
                        matched = [n for n in node_list if n.get("lifecycle_state") == "ACTIVE"]
                    elif lifecycle_filter == "removing":
                        matched = [n for n in node_list if n.get("lifecycle_state") in ("RETIRING", "REVOKED")]
                    elif lifecycle_filter == "removed":
                        matched = [n for n in node_list if n.get("lifecycle_state") == "REMOVED"]
                    else:
                        matched = node_list
                return self.send_json(200, {"success": True, "data": matched})

            if clean_path.startswith("/api/telemetry/nodes/") and clean_path.endswith("/history"):
                parts = clean_path.split("/")
                node_id = parts[4]
                with state.lock:
                    node = state.nodes.get(node_id)
                metric = node["latest_metric"] if node else NODE_A["latest_metric"]
                return self.send_json(200, {"success": True, "data": [metric]})

            if clean_path.startswith("/api/nodes/") and clean_path.endswith("/offboarding"):
                parts = clean_path.split("/")
                node_id = parts[3]
                with state.lock:
                    if state.error_node_id == node_id:
                        return self.send_json(500, {"success": False, "detail": "Internal server error on initial status check"})
                    op = state.offboarding_ops.get(node_id)
                if op:
                    return self.send_json(200, {"success": True, "operation": op})
                return self.send_json(404, {"success": False, "code": "OFFBOARD_NOT_FOUND", "detail": "Node is not currently offboarding"})

            # Fallback to static dist
            self.serve_static(clean_path)

        def do_POST(self):
            parsed = urlsplit(self.path)
            clean_path = unquote(parsed.path)

            length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(length) if length > 0 else b""
            body = {}
            if raw_body:
                try:
                    body = json.loads(raw_body.decode("utf-8"))
                except Exception:
                    pass

            if clean_path == "/api/auth/logout":
                return self.send_json(200, {"success": True})

            if clean_path.startswith("/api/nodes/") and clean_path.endswith("/offboarding/authorization"):
                parts = clean_path.split("/")
                node_id = parts[3]
                with state.lock:
                    state.recorded_auth_downloads.append({"node_id": node_id, "timestamp": iso_now()})
                    node = state.nodes.get(node_id)
                    op = state.offboarding_ops.get(node_id)
                    if op:
                        op["has_cleanup_token"] = True

                node_name = node["name"] if node else "node"
                payload = {
                    "operation_id": op["operation_id"] if op else f"op-{node_id[:8]}",
                    "node_id": node_id,
                    "node_name": node_name,
                    "cleanup_token": f"zt-fake-cleanup-capability-token-{node_id[:8]}",
                    "issued_at": iso_now(),
                    "expires_at": iso_now(),
                }
                raw = json.dumps(payload, indent=2).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Disposition", f'attachment; filename="offboarding-{node_name}.json"')
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return

            if clean_path.startswith("/api/nodes/") and clean_path.endswith("/offboarding"):
                parts = clean_path.split("/")
                node_id = parts[3]
                confirm_name = body.get("confirm_node_name", "").strip()

                with state.lock:
                    state.recorded_offboard_posts.append({
                        "node_id": node_id,
                        "confirm_node_name": confirm_name,
                        "timestamp": iso_now(),
                    })
                    node = state.nodes.get(node_id)
                    if not node:
                        return self.send_json(404, {"success": False, "detail": "Node not found"})

                    if confirm_name != node["name"]:
                        return self.send_json(400, {"success": False, "detail": "Tên máy chủ xác nhận không khớp"})

                    # Transition node
                    node["lifecycle_state"] = "RETIRING"
                    node["is_token_revoked"] = True

                    op = {
                        "operation_id": f"op-{node_id[:8]}",
                        "node_id": node_id,
                        "node_name": node["name"],
                        "node_ip": node["ip_address"],
                        "node_type": node["node_type"],
                        "worker_os": "linux",
                        "wireguard_public_key": "fake-wg-pubkey-base64=",
                        "state": "PENDING_PEER_REMOVAL",
                        "lifecycle_state": "RETIRING",
                        "created_at": iso_now(),
                        "peer_removed_at": None,
                        "completed_at": None,
                        "last_error": None,
                        "has_cleanup_token": False,
                    }
                    state.offboarding_ops[node_id] = op

                return self.send_json(200, {"success": True, "operation": op})

            self.send_error(404, "Not found")

    return DashboardHandler


def find_geckodriver(explicit):
    if explicit and Path(explicit).is_file():
        return str(Path(explicit).resolve())
    preferred = Path("/home/mowftee/.cache/selenium/geckodriver/linux64/0.37.1/geckodriver")
    if preferred.is_file():
        return str(preferred)
    cached = sorted((Path.home() / ".cache/selenium/geckodriver").glob("**/geckodriver"))
    if cached:
        return str(cached[-1])
    system = shutil.which("geckodriver")
    if system:
        return system
    raise FileNotFoundError("Could not find geckodriver. Provide --geckodriver.")


def find_firefox(explicit):
    if explicit and Path(explicit).is_file():
        return str(Path(explicit).resolve())
    preferred = Path("/usr/bin/firefox")
    if preferred.is_file():
        return str(preferred)
    system = shutil.which("firefox")
    if system:
        return system
    raise FileNotFoundError("Could not find Firefox. Provide --firefox.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path, help="Private directory outside repo for test artifacts")
    parser.add_argument("--geckodriver", help="Path to geckodriver binary")
    parser.add_argument("--firefox", help="Path to Firefox binary")
    parser.add_argument("--timeout", type=int, default=30, help="WebDriver timeout in seconds")
    parser.add_argument("--headless", action="store_true", default=True, help="Run headless (default True)")
    args = parser.parse_args()

    # Validate output dir
    output_dir = args.output_dir.resolve()
    repo_root = Path(__file__).resolve().parent.parent
    try:
        output_dir.relative_to(repo_root)
        parser.error(f"output-dir must be outside the repo: {output_dir}")
    except ValueError:
        pass

    output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = output_dir.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        parser.error("output-dir must be an owner-only directory owned by current user (mode 0700)")

    download_dir = output_dir / "downloads"
    download_dir.mkdir(mode=0o700, exist_ok=True)

    dist_dir = repo_root / "dashboard" / "dist"
    if not (dist_dir / "index.html").is_file():
        sys.exit(f"Dashboard build not found at {dist_dir}. Build dashboard first.")

    geckodriver_bin = find_geckodriver(args.geckodriver)
    firefox_bin = find_firefox(args.firefox)

    result = {
        "started_utc": iso_now(),
        "scope": "Browser acceptance harness for Worker offboarding UI with explicitly fake API fixture",
        "checks": [],
        "screenshots": [],
        "page_errors": [],
        "ok": False,
    }

    def record(name, passed, detail=""):
        result["checks"].append({"name": name, "pass": bool(passed), "detail": detail})
        if not passed:
            raise AssertionError(f"Check failed: {name} - {detail}")

    # Spin up ephemeral HTTP server
    state = MockServerState()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(dist_dir, state))
    port = server.server_address[1]
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    base_url = f"http://127.0.0.1:{port}"

    driver = None
    sync_page_errors = lambda: None

    # Clear proxy for direct loopback between selenium, geckodriver and ephemeral test server
    for env_k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy"):
        os.environ.pop(env_k, None)
    os.environ["no_proxy"] = "127.0.0.1,localhost"
    os.environ["NO_PROXY"] = "127.0.0.1,localhost"
    try:
        from selenium import webdriver
        from selenium.webdriver.common.by import By
        from selenium.webdriver.common.keys import Keys
        from selenium.webdriver.firefox.options import Options
        from selenium.webdriver.firefox.service import Service
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import WebDriverWait

        # Setup Firefox Options
        options = Options()
        if args.headless:
            options.add_argument("-headless")
        options.binary_location = firefox_bin
        options.accept_insecure_certs = True
        options.set_preference("signon.rememberSignons", False)
        # Configure file downloads into private download_dir
        options.set_preference("browser.download.folderList", 2)
        options.set_preference("browser.download.dir", str(download_dir))
        options.set_preference("browser.download.useDownloadDir", True)
        options.set_preference("browser.helperApps.neverAsk.saveToDisk", "application/json,application/octet-stream")

        geckolog_path = output_dir / "geckodriver.log"
        service = Service(geckodriver_bin, log_output=str(geckolog_path))
        driver = webdriver.Firefox(options=options, service=service)
        driver.set_page_load_timeout(args.timeout)
        driver.set_script_timeout(args.timeout)
        driver.set_window_size(1600, 1000)

        wait = WebDriverWait(driver, args.timeout, poll_frequency=0.2)

        def sync_page_errors():
            try:
                errs = driver.execute_script("return (window.ztPageErrors || []);")
                for err in errs:
                    if err not in result["page_errors"]:
                        result["page_errors"].append(err)
            except Exception:
                pass

        def take_screenshot(name):
            wait.until(lambda d: d.execute_script(
                'return !document.getAnimations().some(a => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity)'
            ))
            path = output_dir / f"{name}.png"
            if driver.save_screenshot(str(path)):
                os.chmod(path, 0o600)
                result["screenshots"].append(f"{name}.png")

        def safe_click(elem):
            driver.execute_script("arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});", elem)
            try:
                elem.click()
            except Exception:
                driver.execute_script("arguments[0].click();", elem)

        def bootstrap_session(role="ADMIN", username="demo-admin"):
            driver.get(base_url)
            driver.execute_script("""
                localStorage.setItem('zt_session_token', 'fake-jwt-token-harness');
                localStorage.setItem('zt_user_profile', JSON.stringify({
                    id: 'usr-harness-1',
                    username: arguments[0],
                    role: arguments[1]
                }));
            """, username, role)
            driver.refresh()
            # Wait for console layout to mount
            wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, ".sidebar, .console-workspace")))
            # Navigate to Máy chủ via actual navigation button
            server_nav_btn = wait.until(EC.element_to_be_clickable(
                (By.XPATH, "//button[contains(@class, 'nav-item') and .//span[text()='Máy chủ']]")
            ))
            safe_click(server_nav_btn)
            wait.until(EC.presence_of_element_located((By.ID, "server-fleet")))

        # --- Test Cases ---

        # Bootstrap as ADMIN
        bootstrap_session(role="ADMIN", username="demo-admin")
        record("bootstrap_admin_navigation", True, "Successfully logged in as ADMIN and navigated to Máy chủ")

        # Case 1: Select A then B opens correct B modal UUID/IP
        node_a_row_btn = wait.until(EC.element_to_be_clickable(
            (By.XPATH, f"//button[contains(@class, 'fleet-table-select') and .//strong[text()='{NODE_A['name']}']]")
        ))
        safe_click(node_a_row_btn)
        # Verify NodeDetails with stable id=worker-details and data-node-id
        wait.until(lambda d: d.find_element(By.ID, "worker-details").get_attribute("data-node-id") == NODE_A["id"])
        wait.until(EC.text_to_be_present_in_element((By.CSS_SELECTOR, "#worker-details .detail-title h2"), NODE_A["name"]))

        node_b_row_btn = wait.until(EC.element_to_be_clickable(
            (By.XPATH, f"//button[contains(@class, 'fleet-table-select') and .//strong[text()='{NODE_B['name']}']]")
        ))
        safe_click(node_b_row_btn)
        wait.until(lambda d: d.find_element(By.ID, "worker-details").get_attribute("data-node-id") == NODE_B["id"])
        wait.until(EC.text_to_be_present_in_element((By.CSS_SELECTOR, "#worker-details .detail-title h2"), NODE_B["name"]))

        offboard_btn = wait.until(EC.element_to_be_clickable(
            (By.XPATH, f"//section[@id='worker-details']//button[@aria-label='Gỡ Worker {NODE_B['name']}']")
        ))
        safe_click(offboard_btn)

        dialog = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "div[role='dialog']")))
        dialog_text = dialog.text
        record(
            "select_a_then_b_opens_correct_b_modal",
            NODE_B["name"] in dialog_text and NODE_B["ip_address"] in dialog_text and NODE_B["id"] in dialog_text
            and NODE_A["name"] not in dialog_text and NODE_A["ip_address"] not in dialog_text,
            f"Dialog explicitly bound to B ({NODE_B['name']}, {NODE_B['ip_address']}, {NODE_B['id']})"
        )

        # Case 2: Modal is not inert and text input accepts
        is_inert = driver.execute_script("return Boolean(arguments[0].inert || arguments[0].closest('[inert]'));", dialog)
        record("modal_not_inert", not is_inert, "OffboardingModal dialog element is not inert")

        # Verify background elements are inert
        bg_inert = driver.execute_script("""
            const ws = document.querySelector('.console-workspace');
            const sb = document.querySelector('.sidebar');
            return (!ws || ws.inert) && (!sb || sb.inert);
        """)
        record("background_is_inert", bg_inert, "Background workspace and sidebar are marked inert")

        confirm_input = wait.until(EC.visibility_of_element_located((By.ID, "confirm-node-name-input")))
        confirm_input.send_keys("test-input")
        wait.until(lambda d: confirm_input.get_attribute("value") == "test-input")
        record("modal_text_input_accepts", True, "Confirm input accepted typing")

        # Case 3: Exact name confirm disabled for wrong
        submit_btn = dialog.find_element(By.CSS_SELECTOR, "button[type='submit']")
        record("confirm_disabled_for_wrong", not submit_btn.is_enabled(), "Submit disabled when name does not match")

        confirm_input.send_keys(Keys.CONTROL, "a")
        confirm_input.send_keys(Keys.BACKSPACE)
        confirm_input.send_keys(NODE_A["name"])
        wait.until(lambda d: confirm_input.get_attribute("value") == NODE_A["name"])
        record("confirm_disabled_for_other_node", not submit_btn.is_enabled(), f"Submit disabled for A name '{NODE_A['name']}'")

        confirm_input.send_keys(Keys.CONTROL, "a")
        confirm_input.send_keys(Keys.BACKSPACE)
        confirm_input.send_keys(NODE_B["name"])
        wait.until(lambda d: submit_btn.is_enabled())
        record("confirm_enabled_for_exact_match", submit_btn.is_enabled(), f"Submit enabled for exact name '{NODE_B['name']}'")

        # Case 4: Submit captured POST correct B once, A unmodified
        safe_click(submit_btn)
        # Wait for dialog to transition to progress state (Phase 2)
        wait.until(EC.text_to_be_present_in_element(
            (By.ID, "offboarding-modal-title"), "Tiến trình gỡ bỏ máy chủ"
        ))
        wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "div[role='dialog'] span.status-badge")))
        record("submit_transitioned_to_progress", True, "Modal transitioned to phase 2 progress")

        with state.lock:
            posts = list(state.recorded_offboard_posts)
            b_posts = [p for p in posts if p["node_id"] == NODE_B["id"]]
            a_posts = [p for p in posts if p["node_id"] == NODE_A["id"]]
            node_a_state = state.nodes[NODE_A["id"]]["lifecycle_state"]
        record("captured_post_b_once", len(b_posts) == 1, f"POST /api/nodes/{NODE_B['id']}/offboarding received once")
        record("node_a_unmodified", len(a_posts) == 0 and node_a_state == "ACTIVE", "Node A completely untouched")

        # Case 5: Simulate remove B from ACTIVE list during refetch -> dialog progress remains for B
        # When refetching 'active', B is RETIRING so server returns only A.
        refresh_btn = wait.until(EC.presence_of_element_located((By.XPATH, "//button[@aria-label='Làm mới']")))
        driver.execute_script("arguments[0].dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));", refresh_btn)
        # Wait for refetch to complete using explicit condition without time.sleep
        wait.until(lambda d: len(d.find_elements(By.CSS_SELECTOR, ".page-heading button .animate-spin")) == 0)

        # Ensure dialog still exists and displays B
        dialog = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "div[role='dialog']")))
        wait.until(lambda d: NODE_B["name"] in dialog.text)
        record("dialog_remains_during_refetch", NODE_B["name"] in dialog.text, "Dialog remains mounted for B after fleet refetch")

        # Case 6: Download bundle actual browser download event or filesystem with fake cleanup token, no token localStorage
        download_btn = wait.until(EC.element_to_be_clickable(
            (By.XPATH, "//button[contains(., 'Tải mã ủy quyền dọn dẹp')]")
        ))
        safe_click(download_btn)

        # Wait for file in download_dir
        expected_file = download_dir / f"offboarding-{NODE_B['name']}.json"
        wait.until(lambda d: expected_file.is_file() and expected_file.stat().st_size > 0)
        file_content = json.loads(expected_file.read_text(encoding="utf-8"))
        record(
            "download_bundle_file_exists",
            "cleanup_token" in file_content and file_content["node_id"] == NODE_B["id"],
            f"Downloaded authorization bundle on filesystem contains fake capability token: {file_content.get('cleanup_token')}"
        )

        # Wait for download success notice to render
        wait.until(EC.visibility_of_element_located(
            (By.XPATH, "//div[@role='status' and contains(., 'Đã tải tệp ủy quyền dọn dẹp thành công')]")
        ))

        has_local_token = driver.execute_script(
            "return Boolean(localStorage.getItem('cleanup_token') || localStorage.getItem('zt_cleanup_token'));"
        )
        record("no_token_in_local_storage", not has_local_token, "Cleanup capability token never leaked into localStorage")

        # Case 7: Close/reopen state and filter Đang gỡ/Đã gỡ; no WebSSH retired
        close_btn = wait.until(EC.element_to_be_clickable((By.XPATH, "//button[@aria-label='Đóng hộp thoại']")))
        safe_click(close_btn)
        wait.until(EC.invisibility_of_element_located((By.CSS_SELECTOR, "div[role='dialog']")))

        # Change lifecycle filter to 'removing'
        fleet_select = wait.until(EC.presence_of_element_located((By.XPATH, "//select[@aria-label='Lọc hạm đội máy chủ']")))
        driver.execute_script("arguments[0].value = 'removing'; arguments[0].dispatchEvent(new Event('change', {bubbles: true}));", fleet_select)

        # In 'removing', node B is shown
        node_b_removing_row = wait.until(EC.element_to_be_clickable(
            (By.XPATH, f"//button[contains(@class, 'fleet-table-select') and .//strong[text()='{NODE_B['name']}']]")
        ))
        safe_click(node_b_removing_row)
        wait.until(lambda d: d.find_element(By.ID, "worker-details").get_attribute("data-node-id") == NODE_B["id"])

        # Web SSH must be disabled for retiring node in #worker-details
        ssh_btn = wait.until(EC.presence_of_element_located(
            (By.XPATH, "//section[@id='worker-details']//button[contains(., 'Web SSH')]")
        ))
        record("no_web_ssh_for_retiring", not ssh_btn.is_enabled(), "Web SSH button disabled for retiring node")

        # Open offboarding progress again via 'Tiến trình gỡ'
        progress_btn = wait.until(EC.element_to_be_clickable(
            (By.XPATH, f"//section[@id='worker-details']//button[@aria-label='Xem tiến trình gỡ {NODE_B['name']}']")
        ))
        safe_click(progress_btn)
        dialog = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "div[role='dialog']")))
        wait.until(EC.text_to_be_present_in_element((By.ID, "offboarding-modal-title"), "Tiến trình gỡ bỏ máy chủ"))
        record("reopen_shows_progress", True, "Reopening offboarding modal shows active progress")

        close_btn = wait.until(EC.element_to_be_clickable((By.XPATH, "//button[@aria-label='Đóng hộp thoại']")))
        safe_click(close_btn)
        wait.until(EC.invisibility_of_element_located((By.CSS_SELECTOR, "div[role='dialog']")))

        # Mark B completed (REMOVED) in server state
        state.mark_b_completed()
        driver.execute_script("arguments[0].value = 'removed'; arguments[0].dispatchEvent(new Event('change', {bubbles: true}));", fleet_select)

        node_b_removed_row = wait.until(EC.element_to_be_clickable(
            (By.XPATH, f"//button[contains(@class, 'fleet-table-select') and .//strong[text()='{NODE_B['name']}']]")
        ))
        safe_click(node_b_removed_row)
        wait.until(lambda d: d.find_element(By.ID, "worker-details").get_attribute("data-node-id") == NODE_B["id"])

        ssh_btn_removed = wait.until(EC.presence_of_element_located(
            (By.XPATH, "//section[@id='worker-details']//button[contains(., 'Web SSH')]")
        ))
        record("no_web_ssh_for_removed", not ssh_btn_removed.is_enabled(), "Web SSH button disabled for removed node")

        # Case 8: Viewer sees progress but not confirm/download controls
        state.reset_b_to_retiring()
        bootstrap_session(role="VIEWER", username="demo-viewer")
        fleet_select = wait.until(EC.presence_of_element_located((By.XPATH, "//select[@aria-label='Lọc hạm đội máy chủ']")))
        driver.execute_script("arguments[0].value = 'removing'; arguments[0].dispatchEvent(new Event('change', {bubbles: true}));", fleet_select)

        node_b_view = wait.until(EC.element_to_be_clickable(
            (By.XPATH, f"//button[contains(@class, 'fleet-table-select') and .//strong[text()='{NODE_B['name']}']]")
        ))
        safe_click(node_b_view)
        wait.until(lambda d: d.find_element(By.ID, "worker-details").get_attribute("data-node-id") == NODE_B["id"])

        progress_btn = wait.until(EC.element_to_be_clickable(
            (By.XPATH, f"//section[@id='worker-details']//button[@aria-label='Xem tiến trình gỡ {NODE_B['name']}']")
        ))
        safe_click(progress_btn)
        dialog = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "div[role='dialog']")))

        # Check viewer restrictions
        confirm_inputs = dialog.find_elements(By.ID, "confirm-node-name-input")
        download_btns = dialog.find_elements(By.XPATH, ".//button[contains(., 'Tải mã ủy quyền dọn dẹp')]")
        record("viewer_no_confirm_form", len(confirm_inputs) == 0, "Viewer does not see confirmation input form")
        record("viewer_no_download_button", len(download_btns) == 0, "Viewer does not have download authorization button")
        notice = wait.until(EC.visibility_of_element_located((By.XPATH, "//div[@role='dialog']//p[contains(., 'Chỉ quản trị viên (ADMIN) mới có quyền')]")))
        record("viewer_notice_visible", notice is not None, "Viewer restriction notice displayed")

        close_btn = wait.until(EC.element_to_be_clickable((By.XPATH, "//button[@aria-label='Đóng hộp thoại']")))
        safe_click(close_btn)
        wait.until(EC.invisibility_of_element_located((By.CSS_SELECTOR, "div[role='dialog']")))

        # In viewer, check active Node A has no 'Gỡ Worker' button in #worker-details
        driver.execute_script("arguments[0].value = 'active'; arguments[0].dispatchEvent(new Event('change', {bubbles: true}));", fleet_select)
        node_a_row = wait.until(EC.element_to_be_clickable(
            (By.XPATH, f"//button[contains(@class, 'fleet-table-select') and .//strong[text()='{NODE_A['name']}']]")
        ))
        safe_click(node_a_row)
        wait.until(lambda d: d.find_element(By.ID, "worker-details").get_attribute("data-node-id") == NODE_A["id"])
        offboard_btns = driver.find_elements(By.XPATH, f"//section[@id='worker-details']//button[@aria-label='Gỡ Worker {NODE_A['name']}']")
        record("viewer_no_offboard_button_active_node", len(offboard_btns) == 0, "Viewer cannot see or trigger Gỡ Worker button on active node")

        # Case 9: Network/500 initial status surfaces retry and no active destructive form; retry recovery
        bootstrap_session(role="ADMIN", username="demo-admin")
        node_a_row = wait.until(EC.element_to_be_clickable(
            (By.XPATH, f"//button[contains(@class, 'fleet-table-select') and .//strong[text()='{NODE_A['name']}']]")
        ))
        safe_click(node_a_row)
        wait.until(lambda d: d.find_element(By.ID, "worker-details").get_attribute("data-node-id") == NODE_A["id"])

        # Inject 500 error for Node A offboarding check
        with state.lock:
            state.error_node_id = NODE_A["id"]

        offboard_a_btn = wait.until(EC.element_to_be_clickable(
            (By.XPATH, f"//section[@id='worker-details']//button[@aria-label='Gỡ Worker {NODE_A['name']}']")
        ))
        safe_click(offboard_a_btn)

        dialog = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "div[role='dialog']")))
        # Wait for error message
        wait.until(EC.visibility_of_element_located((By.XPATH, "//div[@role='dialog']//div[@role='alert']//strong[contains(., 'Không thể kiểm tra trạng thái')]")))
        destructive_inputs = dialog.find_elements(By.ID, "confirm-node-name-input")
        record("network_500_hides_destructive_form", len(destructive_inputs) == 0, "Fail-closed: 500 error hides destructive confirm form")

        retry_btn = wait.until(EC.element_to_be_clickable(
            (By.XPATH, "//div[@role='dialog']//button[contains(., 'Thử lại')]")
        ))

        # Clear error and retry
        with state.lock:
            state.error_node_id = None
        safe_click(retry_btn)

        # Wait for recovery: destructive confirm form surfaces
        recovered_input = wait.until(EC.visibility_of_element_located((By.ID, "confirm-node-name-input")))
        record("retry_recovery_surfaces_confirm_form", recovered_input is not None, "Retry recovered and rendered confirmation input")

        # Case 10: Escape closes; Tab/ShiftTab stay inside
        driver.switch_to.active_element.send_keys(Keys.ESCAPE)
        wait.until(EC.invisibility_of_element_located((By.CSS_SELECTOR, "div[role='dialog']")))
        record("escape_closes_modal", True, "Escape key closed the modal")

        # Reopen modal for Tab trap test
        offboard_a_btn = wait.until(EC.element_to_be_clickable(
            (By.XPATH, f"//section[@id='worker-details']//button[@aria-label='Gỡ Worker {NODE_A['name']}']")
        ))
        safe_click(offboard_a_btn)
        dialog = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "div[role='dialog']")))

        # Tab focus containment test
        focusables = dialog.find_elements(By.CSS_SELECTOR, "button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])")
        first_el = focusables[0]
        last_el = focusables[-1]

        driver.execute_script("arguments[0].focus();", last_el)
        wait.until(lambda d: d.execute_script("return document.activeElement === arguments[0];", last_el))
        last_el.send_keys(Keys.TAB)
        wait.until(lambda d: d.execute_script("return arguments[0].contains(document.activeElement);", dialog))
        record("tab_stays_inside_dialog", True, "Forward Tab stays contained inside modal dialog")

        driver.execute_script("arguments[0].focus();", first_el)
        wait.until(lambda d: d.execute_script("return document.activeElement === arguments[0];", first_el))
        first_el.send_keys(Keys.SHIFT, Keys.TAB)
        wait.until(lambda d: d.execute_script("return arguments[0].contains(document.activeElement);", dialog))
        record("shift_tab_stays_inside_dialog", True, "Shift+Tab stays contained inside modal dialog")

        # Case 11: Desktop/tablet/mobile screenshot + horizontal overflow checks
        # Desktop
        driver.set_window_size(1600, 1000)
        wait.until(lambda d: d.execute_script("return Math.abs(window.innerWidth - 1600) <= 20;"))
        take_screenshot("desktop-offboarding")
        desktop_overflow = driver.execute_script("return document.documentElement.scrollWidth > window.innerWidth;")
        record("desktop_no_overflow", not desktop_overflow, "Desktop 1600px has no horizontal overflow")

        # Tablet
        driver.set_window_size(800, 1024)
        wait.until(lambda d: d.execute_script("return Math.abs(window.innerWidth - 800) <= 20;"))
        take_screenshot("tablet-offboarding")
        tablet_overflow = driver.execute_script("return document.documentElement.scrollWidth > window.innerWidth;")
        record("tablet_no_overflow", not tablet_overflow, "Tablet 800px has no horizontal overflow")

        # Mobile: handle potential Firefox outer viewport minimum width clamp
        driver.set_window_size(390, 844)
        wait.until(lambda d: d.execute_script("return document.readyState === 'complete';"))
        actual_width = driver.execute_script("return window.innerWidth;")
        if actual_width <= 420:
            take_screenshot("mobile-offboarding")
            mobile_overflow = driver.execute_script("return document.documentElement.scrollWidth > window.innerWidth;")
            record("mobile_no_overflow", not mobile_overflow, f"Mobile {actual_width}px has no horizontal overflow")
        else:
            # Use same-origin iframe pattern for strict CSS mobile viewport verification
            frame = driver.execute_script("""
                const frame = document.createElement('iframe');
                frame.id = 'zt-mobile-viewport';
                Object.assign(frame.style, {
                    position: 'fixed', left: '0', top: '0',
                    width: '390px', height: '844px', border: '0', zIndex: '2147483647'
                });
                frame.src = arguments[0];
                document.body.append(frame);
                return frame;
            """, base_url)
            try:
                wait.until(EC.frame_to_be_available_and_switch_to_it(frame))
                wait.until(lambda d: d.execute_script("return document.readyState === 'complete';"))
                frame_overflow = driver.execute_script(
                    "return Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > window.innerWidth + 1;"
                )
                record("mobile_iframe_no_overflow", not frame_overflow, "Mobile 390px iframe has no horizontal overflow")
                driver.switch_to.default_content()
                frame.screenshot(str(output_dir / "mobile-offboarding.png"))
                os.chmod(output_dir / "mobile-offboarding.png", 0o600)
                result["screenshots"].append("mobile-offboarding.png")
            finally:
                driver.switch_to.default_content()
                driver.execute_script("document.getElementById('zt-mobile-viewport')?.remove();")

        # Restore desktop window size
        driver.set_window_size(1600, 1000)
        wait.until(lambda d: d.execute_script("return window.innerWidth === 1600;"))

        # Close dialog
        close_btn = wait.until(EC.element_to_be_clickable((By.XPATH, "//div[@role='dialog']//button[@aria-label='Đóng hộp thoại']")))
        safe_click(close_btn)
        wait.until(EC.invisibility_of_element_located((By.CSS_SELECTOR, "div[role='dialog']")))

        # Check uncaught page errors observed from the static server script injection
        sync_page_errors()
        record("zero_uncaught_page_errors", len(result["page_errors"]) == 0, f"Uncaught page errors count: {len(result['page_errors'])}")

        result["ok"] = True
        print("ALL BROWSER ACCEPTANCE CHECKS PASSED.")

    except Exception as exc:
        sync_page_errors()
        result["error"] = str(exc)
        print(f"HARNESS ERROR: {exc}", file=sys.stderr)
        # Capture failure artifacts for Root diagnosis
        if driver:
            try:
                fail_png = output_dir / "error-failure.png"
                driver.save_screenshot(str(fail_png))
                os.chmod(fail_png, 0o600)
                result["screenshots"].append("error-failure.png")
            except Exception:
                pass
            try:
                fail_dom = output_dir / "error-dom.html"
                fail_dom.write_text(driver.page_source, encoding="utf-8")
                os.chmod(fail_dom, 0o600)
            except Exception:
                pass
        raise
    finally:
        result["completed_utc"] = iso_now()
        res_file = output_dir / "result.json"
        res_file.write_text(json.dumps(result, indent=2), encoding="utf-8")
        os.chmod(res_file, 0o600)

        if driver:
            try:
                driver.quit()
            except Exception:
                pass
        try:
            server.shutdown()
            server.server_close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
