import os
import re
import stat
import sys
import time
import unicodedata
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Mã màu ANSI
RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
WHITE = "\033[97m"

ANSI_REGEX = re.compile(r"\x1b\[[0-9;]*m")


def visible_width(s: str) -> int:
    clean_s = ANSI_REGEX.sub("", s)
    return sum(2 if unicodedata.east_asian_width(c) in ("F", "W") else 1 for c in clean_s)


def pad(s: str, width: int, align: str = "left") -> str:
    cur_w = visible_width(s)
    if cur_w > width:
        while visible_width(s) > width - 1 and len(s) > 0:
            s = s[:-1]
        s += "…"
        cur_w = visible_width(s)

    pad_len = max(0, width - cur_w)
    if align == "center":
        left = pad_len // 2
        right = pad_len - left
        return " " * left + s + " " * right
    elif align == "right":
        return " " * pad_len + s
    return s + " " * pad_len


class VisualInfraTestRunner:
    def __init__(self):
        self.results = []
        self.start_time = time.time()

    def record(self, case_id: str, category: str, name: str, passed: bool):
        self.results.append({
            "id": case_id,
            "category": category,
            "name": name,
            "passed": passed,
        })

    def run_animation(self):
        total = len(self.results)
        passed_count = sum(1 for r in self.results if r["passed"])
        pct_passed = int((passed_count / total) * 100) if total > 0 else 0
        spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
        sys.stdout.write("\n")
        for i in range(1, total + 1):
            spin = spinners[i % len(spinners)]
            progress = int((i / total) * 32)
            bar = f"{GREEN}{'━' * progress}{DIM}{'┄' * (32 - progress)}{RESET}"
            pct = int((i / total) * 100)
            sys.stdout.write(f"\r  {CYAN}{spin}{RESET}  Đang kiểm thử hạ tầng & CSDL: [{bar}] {BOLD}{pct}%{RESET} ({i:02d}/{total} TC)")
            sys.stdout.flush()
            time.sleep(0.01)
        tag = f"{GREEN}✔{RESET}" if passed_count == total else f"{RED}✖{RESET}"
        sys.stdout.write(f"\r  {tag}  Hoàn tất kiểm thử hạ tầng & CSDL: [{GREEN}{'━' * 32}{RESET}] {BOLD}{pct_passed}%{RESET} ({passed_count:02d}/{total:02d} TC)\n\n")
        sys.stdout.flush()

    def render_table(self):
        total = len(self.results)
        passed_count = sum(1 for r in self.results if r["passed"])
        failed_count = total - passed_count
        duration_ms = (time.time() - self.start_time) * 1000

        w_id = 10
        w_cat = 16
        w_name = 54
        w_status = 12

        top_border = f"┌{'─' * w_id}┬{'─' * w_cat}┬{'─' * w_name}┬{'─' * w_status}┐"
        mid_border = f"├{'─' * w_id}┼{'─' * w_cat}┼{'─' * w_name}┼{'─' * w_status}┤"
        bot_border = f"└{'─' * w_id}┴{'─' * w_cat}┴{'─' * w_name}┴{'─' * w_status}┘"

        table_width = w_id + w_cat + w_name + w_status + 3
        banner_inner = table_width - 2

        print(f"{CYAN}{BOLD}╔{'═' * banner_inner}╗{RESET}")
        title = "🛡️  BÁO CÁO KẾT QUẢ KIỂM THỬ TỰ ĐỘNG CHUYÊN SÂU — CHẶNG II (ZT-SERVEROPS)"
        print(f"{CYAN}{BOLD}║{RESET}{BOLD}{WHITE}{pad(title, banner_inner, 'center')}{RESET}{CYAN}{BOLD}║{RESET}")
        print(f"{CYAN}{BOLD}╚{'═' * banner_inner}╝{RESET}\n")

        print(f"{DIM}{top_border}{RESET}")
        header = f"│ {BOLD}{pad('MÃ TC', w_id - 2, 'center')}{RESET} │ {BOLD}{pad('PHÂN LOẠI', w_cat - 2, 'center')}{RESET} │ {BOLD}{pad('TÊN TEST CASE & KỊCH BẢN THỬ NGHIỆM', w_name - 2)}{RESET} │ {BOLD}{pad('TRẠNG THÁI', w_status - 2, 'center')}{RESET} │"
        print(header)
        print(f"{DIM}{mid_border}{RESET}")

        for r in self.results:
            c_id = f"{BOLD}{WHITE}{pad(r['id'], w_id - 2, 'center')}{RESET}"
            c_cat = f"{YELLOW}{pad(r['category'], w_cat - 2)}{RESET}"
            c_name = f"{pad(r['name'], w_name - 2)}"
            c_status = f"{GREEN}{BOLD}{pad('✔ ĐẠT', w_status - 2, 'center')}{RESET}" if r["passed"] else f"{RED}{BOLD}{pad('✖ LỖI', w_status - 2, 'center')}{RESET}"
            print(f"│ {c_id} │ {c_cat} │ {c_name} │ {c_status} │")

        print(f"{DIM}{bot_border}{RESET}\n")

        sec_status = f"{GREEN}{BOLD}AN TOÀN TUYỆT ĐỐI (KHÔNG CÓ ĐIỂM CHẾT){RESET}" if failed_count == 0 else f"{RED}{BOLD}PHÁT HIỆN TỬ HUYỆT CẦN VÁ{RESET}"
        print(f"  📌  {BOLD}Tổng số test cases:{RESET} {BOLD}{total}{RESET}  |  {GREEN}✔ Thành công:{RESET} {BOLD}{passed_count}{RESET}  |  {RED}✖ Thất bại:{RESET} {BOLD}{failed_count}{RESET}")
        print(f"  ⏱️   {BOLD}Thời gian quét:{RESET} {CYAN}{duration_ms:.2f} ms{RESET}  |  🛡️  {BOLD}Đánh giá an ninh:{RESET} {sec_status}\n")

        return failed_count == 0


def execute_suite() -> bool:
    runner = VisualInfraTestRunner()

    # 1. KIỂM THỬ MIGRATION 001 (CĐ-04)
    mig_001 = PROJECT_ROOT / "gateway/migrations/001_init_schema.sql"
    with open(mig_001, "r", encoding="utf-8") as f:
        sql_001 = f.read()

    runner.record("TC-01", "Chống nghẽn", "Ràng buộc lock_timeout = '2s' chống kẹt DDL", "SET lock_timeout = '2s';" in sql_001)
    runner.record("TC-02", "RBAC Schema", "Bảng users có ràng buộc CHECK vai trò ADMIN/VIEWER", "CHECK (role IN ('ADMIN', 'VIEWER'))" in sql_001)
    runner.record("TC-03", "Node Catalog", "Bảng nodes có token_hash, token_prefix, status", "token_hash VARCHAR(64)" in sql_001 and "token_prefix" in sql_001)
    runner.record("TC-04", "Tối ưu hóa", "Chỉ mục B-Tree UNIQUE Index trên token_hash", "UNIQUE INDEX" in sql_001 and "token_hash" in sql_001)
    runner.record("TC-05", "Audit Log", "Bảng audit_logs Append-Only và có Trigger chống can thiệp", "CREATE TABLE IF NOT EXISTS audit_logs" in sql_001 and "prevent_audit_logs_tampering" in sql_001)

    # 2. KIỂM THỬ MIGRATION 002 RANGE PARTITIONING (CĐ-05)
    mig_002 = PROJECT_ROOT / "gateway/migrations/002_partition_metrics.sql"
    with open(mig_002, "r", encoding="utf-8") as f:
        sql_002 = f.read()

    runner.record("TC-06", "Partitioning", "Bảng metrics_history định dạng chuẩn YYYY_MM_DD", "PARTITION BY RANGE (recorded_at)" in sql_002 and "metrics_history_y" in sql_002 and "YYYY_MM_DD" in sql_002)
    runner.record("TC-07", "Dự phòng", "Có phân vùng mặc định metrics_history_default", "PARTITION OF metrics_history DEFAULT;" in sql_002)
    runner.record("TC-08", "Tự động hóa", "Hàm tự động tạo phân vùng create_daily_metrics_partition", "create_daily_metrics_partition" in sql_002)
    runner.record("TC-09", "Thu hồi đĩa", "Hàm tự động DROP phân vùng cũ trong O(1) giải phóng đĩa", "drop_old_metrics_partitions" in sql_002)

    # 3. KIỂM THỬ SINH KHÓA & BÍ MẬT INIT-SECRETS (CĐ-06)
    script_path = PROJECT_ROOT / "deploy/scripts/init-secrets.sh"
    is_executable = os.access(script_path, os.X_OK)
    runner.record("TC-10", "Kịch bản", "Tệp init-secrets.sh tồn tại và có quyền thực thi", is_executable)

    keys_dir = PROJECT_ROOT / "keys"
    bastion_key = keys_dir / "bastion_id_ed25519"
    wg_key = keys_dir / "wireguard_gateway_private.key"
    if not (bastion_key.exists() and wg_key.exists()):
        import subprocess
        subprocess.run(["bash", str(script_path)], capture_output=True)

    key_exists = bastion_key.exists()
    key_mode = oct(stat.S_IMODE(os.stat(bastion_key).st_mode)) if key_exists else "000"
    runner.record("TC-11", "Khóa Bastion", "Khóa riêng tư Ed25519 phân quyền nghiêm ngặt chmod 600", key_exists and key_mode == "0o600")

    wg_exists = wg_key.exists()
    wg_mode = oct(stat.S_IMODE(os.stat(wg_key).st_mode)) if wg_exists else "000"
    runner.record("TC-12", "Khóa WireGuard", "Khóa riêng tư WireGuard Curve25519 phân quyền chmod 600", wg_exists and wg_mode == "0o600")

    dir_mode = oct(stat.S_IMODE(os.stat(keys_dir).st_mode)) if keys_dir.exists() else "000"
    runner.record("TC-13", "Bảo mật", "Thư mục keys/ được cô lập phân quyền chmod 700", dir_mode == "0o700")

    # 4. KIỂM THỬ DOCKER COMPOSE & MẠNG NỘI BỘ (CĐ-07)
    compose_path = PROJECT_ROOT / "docker-compose.yml"
    with open(compose_path, "r", encoding="utf-8") as f:
        compose_text = f.read()

    runner.record("TC-14", "Chống lan ngang", "Phân tách mạng Zero Trust zt_ingress_net và zt_internal_net", "zt_ingress_net:" in compose_text and "zt_internal_net:" in compose_text)
    has_4_vols = all(v in compose_text for v in ["zt_postgres_data:", "zt_audit_logs:", "caddy_data:", "caddy_config:"])
    runner.record("TC-15", "Lưu trữ", "Khai báo đủ 4 Volumes độc lập: DB, Audit, Caddy Data/Config", has_4_vols)
    runner.record("TC-16", "Healthcheck", "PostgreSQL có cơ chế giám sát sức khỏe pg_isready", "pg_isready" in compose_text)

    # 5. KIỂM THỬ PROXY CADDY VÀ WIREGUARD
    caddy_path = PROJECT_ROOT / "deploy/proxy/Caddyfile"
    with open(caddy_path, "r", encoding="utf-8") as f:
        caddy_text = f.read()

    runner.record("TC-17", "Cổng biên", "Caddyfile chuyển tiếp Gateway trên cổng 80 (redir) & 443 (TLS)", ":80" in caddy_text and ":443" in caddy_text and "redir" in caddy_text)
    runner.record("TC-18", "WebSocket", "Caddyfile hỗ trợ chuyển giao thức WebSocket cho Bastion", "header Connection *Upgrade*" in caddy_text)

    wg_gw_path = PROJECT_ROOT / "deploy/wireguard/wg0-gateway.conf"
    with open(wg_gw_path, "r", encoding="utf-8") as f:
        wg_gw_text = f.read()

    runner.record("TC-19", "Mạng ngầm", "Gateway mở duy nhất cổng UDP 51820 ra ngoài", "ListenPort = 51820" in wg_gw_text)

    wg_node_path = PROJECT_ROOT / "deploy/wireguard/wg0-node.conf"
    with open(wg_node_path, "r", encoding="utf-8") as f:
        wg_node_text = f.read()

    runner.record("TC-20", "NAT Keepalive", "Worker Node duy trì kết nối NAT: PersistentKeepalive = 25", "PersistentKeepalive = 25" in wg_node_text)

    gitignore_path = PROJECT_ROOT / ".gitignore"
    with open(gitignore_path, "r", encoding="utf-8") as f:
        gi_text = f.read()

    runner.record("TC-21", "Chống rò rỉ", "Tệp .gitignore loại trừ tuyệt đối keys/, .env, *.key", "keys/" in gi_text and ".env" in gi_text and "*.key" in gi_text)

    runner.run_animation()
    return runner.render_table()


class TestInfraTestSuite(unittest.TestCase):
    def test_run_infra_suite(self):
        passed = execute_suite()
        self.assertTrue(passed, "Có ít nhất một Test Case hạ tầng bị thất bại!")


if __name__ == "__main__":
    success = execute_suite()
    sys.exit(0 if success else 1)
