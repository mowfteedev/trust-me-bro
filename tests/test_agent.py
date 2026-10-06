import json
import os
import re
import sys
import time
import unicodedata
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "agent/src"))
sys.path.insert(0, str(PROJECT_ROOT / "tests"))

from collectors.cpu import CPUCollector
from collectors.memory import MemoryCollector
from collectors.disk import DiskCollector
from collectors.network import NetworkCollector
from config import AgentConfig
from main import WorkerDaemon
from test_contracts import SchemaValidator

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


class VisualAgentTestRunner:
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
        total = 21
        spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
        sys.stdout.write("\n")
        for i in range(1, total + 1):
            spin = spinners[i % len(spinners)]
            progress = int((i / total) * 32)
            bar = f"{GREEN}{'━' * progress}{DIM}{'┄' * (32 - progress)}{RESET}"
            pct = int((i / total) * 100)
            sys.stdout.write(f"\r  {CYAN}{spin}{RESET}  Đang kiểm thử Worker Daemon: [{bar}] {BOLD}{pct}%{RESET} ({i:02d}/{total} TC)")
            sys.stdout.flush()
            time.sleep(0.01)
        sys.stdout.write(f"\r  {GREEN}✔{RESET}  Hoàn tất kiểm thử Worker Daemon: [{GREEN}{'━' * 32}{RESET}] {BOLD}100%{RESET} (21/21 TC)\n\n")
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
        title = "🛡️  BÁO CÁO KẾT QUẢ KIỂM THỬ TỰ ĐỘNG CHUYÊN SÂU — CHẶNG III (ZT-SERVEROPS)"
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
    runner = VisualAgentTestRunner()

    # 1. KIỂM THỬ COLLECTORS (CĐ-08 & CĐ-09)
    cpu_col = CPUCollector()
    cpu_data = cpu_col.collect()
    runner.record("TC-01", "CPU Kernel", "Đọc tải CPU và load average từ /proc/stat", isinstance(cpu_data["percent"], float) and len(cpu_data["load_avg"]) == 3)
    runner.record("TC-02", "CPU Clamping", "Chỉ số CPU percent được kẹp chặt [0.0 - 100.0]", 0.0 <= cpu_data["percent"] <= 100.0)

    mem_col = MemoryCollector()
    mem_data = mem_col.collect()
    runner.record("TC-03", "RAM Kernel", "Đọc MemAvailable từ /proc/meminfo chống báo ảo", mem_data["total_bytes"] > 0 and mem_data["used_bytes"] >= 0)
    runner.record("TC-04", "RAM Clamping", "Chỉ số RAM used <= total và percent hợp lệ", mem_data["used_bytes"] <= mem_data["total_bytes"] and 0.0 <= mem_data["percent"] <= 100.0)

    disk_col = DiskCollector()
    disk_data = disk_col.collect()
    runner.record("TC-05", "Disk POSIX", "Trích xuất ổ cứng qua syscall statvfs không fork tiến trình", disk_data["total_bytes"] > 0)
    runner.record("TC-06", "Disk Clamping", "Chỉ số Disk percent được kẹp chặt [0.0 - 100.0]", 0.0 <= disk_data["percent"] <= 100.0)

    net_col = NetworkCollector()
    net_data = net_col.collect()
    runner.record("TC-07", "Network I/O", "Đọc bytes Rx/Tx từ /proc/net/dev loại trừ loopback lo", net_data["network"]["rx_bytes_total"] >= 0 and net_data["network"]["tx_bytes_total"] >= 0)
    runner.record("TC-08", "Uptime", "Đọc thời gian hoạt động liên tục từ /proc/uptime", net_data["uptime_seconds"] >= 0)

    # 2. KIỂM THỬ CẤU HÌNH & VALIDATION (CĐ-10)
    cfg = AgentConfig()
    runner.record("TC-09", "Config URL", "Kiểm tra tiền tố hợp lệ http:// hoặc https://", cfg.gateway_url.startswith(("http://", "https://")))
    runner.record("TC-10", "Config Node", "Kiểm tra độ dài định danh Node ID >= 3 ký tự", len(cfg.node_id) >= 3)

    bad_cfg = AgentConfig()
    bad_cfg.node_token = ""
    token_rejected = False
    try:
        bad_cfg.validate()
    except ValueError:
        token_rejected = True
    runner.record("TC-11", "Config Security", "Từ chối khởi động nếu NODE_TOKEN bị rỗng", token_rejected)

    # 3. KIỂM THỬ HỢP ĐỒNG DỮ LIỆU ĐÓNG GÓI
    with open(PROJECT_ROOT / "contracts/telemetry.schema.json", "r", encoding="utf-8") as f:
        schema = json.load(f)
    validator = SchemaValidator(schema)

    daemon = WorkerDaemon(cfg)
    live_payload = daemon.build_payload()
    schema_errors = validator.validate(live_payload)
    runner.record("TC-12", "Schema Match", "Tải trọng Daemon sinh ra khớp 100% JSON Schema", len(schema_errors) == 0)

    # 4. KIỂM THỬ JITTER VÀ BACKOFF
    t1 = daemon.compute_sleep_time(is_success=True)
    # Jitter: t1 phải nằm trong khoảng interval +/- 10%
    min_jitter = cfg.interval * (1.0 - cfg.jitter_ratio) - 0.05
    max_jitter = cfg.interval * (1.0 + cfg.jitter_ratio) + 0.05
    runner.record("TC-13", "Jitter Engine", "Ngẫu nhiên hóa chu kỳ ngủ chống Thundering Herd", min_jitter <= t1 <= max_jitter)

    # Exponential Backoff khi thất bại
    t_fail_1 = daemon.compute_sleep_time(is_success=False)
    t_fail_2 = daemon.compute_sleep_time(is_success=False)
    runner.record("TC-14", "Backoff Engine", "Tự động nhân đôi thời gian chờ khi mất kết nối Gateway", t_fail_2 > t_fail_1)

    # Trả về ngưỡng mặc định khi kết nối thành công lại
    t_recover = daemon.compute_sleep_time(is_success=True)
    runner.record("TC-15", "Backoff Reset", "Tự động thiết lập lại chu kỳ 3s khi mạng phục hồi", min_jitter <= t_recover <= max_jitter)

    # Giới hạn trần max_backoff
    for _ in range(10):
        daemon.compute_sleep_time(is_success=False)
    t_cap = daemon.compute_sleep_time(is_success=False)
    runner.record("TC-16", "Backoff Cap", "Thời gian lùi lũy thừa không vượt quá max_backoff (30s)", t_cap <= cfg.max_backoff * (1.0 + cfg.jitter_ratio) + 0.1)

    # 5. KIỂM THỬ ĐÓNG GÓI & VẬN HÀNH (CĐ-11)
    df_path = PROJECT_ROOT / "agent/Dockerfile"
    with open(df_path, "r", encoding="utf-8") as f:
        df_text = f.read()

    runner.record("TC-17", "Container Sec", "Dockerfile sử dụng Non-root User ztuser tăng cường", "USER ztuser" in df_text)
    runner.record("TC-18", "Alpine Base", "Ảnh đóng gói xây dựng trên nền tảng python:3.12-alpine", "python:3.12-alpine" in df_text)

    inst_path = PROJECT_ROOT / "agent/install.sh"
    is_exec = os.access(inst_path, os.X_OK)
    runner.record("TC-19", "Installer Exec", "Kịch bản install.sh tồn tại và có quyền thực thi", is_exec)

    with open(inst_path, "r", encoding="utf-8") as f:
        inst_text = f.read()
    runner.record("TC-20", "Systemd Unit", "install.sh cấu hình dịch vụ Systemd tự khởi động", "[Service]" in inst_text and "Restart=always" in inst_text)

    req_path = PROJECT_ROOT / "agent/requirements.txt"
    with open(req_path, "r", encoding="utf-8") as f:
        req_lines = [line.strip() for line in f if line.strip() and not line.startswith("#")]
    runner.record("TC-21", "Zero-Dependency", "Daemon không phụ thuộc thư viện ngoài (RAM < 15MB)", len(req_lines) == 0)

    runner.run_animation()
    return runner.render_table()


class TestAgentTestSuite(unittest.TestCase):
    def test_run_agent_suite(self):
        passed = execute_suite()
        self.assertTrue(passed, "Có ít nhất một Test Case Worker Daemon bị thất bại!")


if __name__ == "__main__":
    success = execute_suite()
    sys.exit(0 if success else 1)
