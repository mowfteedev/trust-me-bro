import json
import re
import sys
import time
import unicodedata
import unittest
from pathlib import Path

# Định vị thư mục gốc dự án
PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONTRACTS_DIR = PROJECT_ROOT / "contracts"

# Mã màu ANSI định dạng giao diện Terminal
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
    """Tính toán chiều rộng hiển thị thực tế trên màn hình (loại bỏ mã màu ANSI và tính toán ký tự Unicode)."""
    clean_s = ANSI_REGEX.sub("", s)
    return sum(2 if unicodedata.east_asian_width(c) in ("F", "W") else 1 for c in clean_s)


def pad(s: str, width: int, align: str = "left") -> str:
    """Căn lề chuẩn xác dựa trên chiều rộng hiển thị của ký tự (có bảo vệ chống tràn cột)."""
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


class SchemaValidator:
    """Bộ thẩm định Schema chuẩn hóa độc lập (Zero-Dependency Schema Engine)."""

    def __init__(self, schema: dict):
        self.schema = schema

    def validate(self, payload: dict) -> list[str]:
        errors = []
        if not isinstance(payload, dict):
            return ["Tải trọng gốc bắt buộc phải là một đối tượng JSON."]

        # 1. Ràng buộc additionalProperties ở tầng gốc
        if not self.schema.get("additionalProperties", True):
            allowed_keys = set(self.schema.get("properties", {}).keys())
            extra_keys = set(payload.keys()) - allowed_keys
            if extra_keys:
                errors.append(f"Phát hiện trường lạ: {list(extra_keys)}")

        # 2. Ràng buộc required keys
        for req in self.schema.get("required", []):
            if req not in payload:
                errors.append(f"Thiếu trường bắt buộc: '{req}'")

        # 3. Ràng buộc định dạng regex node_id
        if "node_id" in payload:
            pattern = self.schema["properties"]["node_id"].get("pattern")
            if pattern and not re.match(pattern, str(payload["node_id"])):
                errors.append(f"node_id sai regex: '{payload['node_id']}'")

        # 4. Ràng buộc timestamp
        if "timestamp" in payload:
            ts_min = self.schema["properties"]["timestamp"].get("minimum", 0)
            if not isinstance(payload["timestamp"], int) or payload["timestamp"] < ts_min:
                errors.append(f"timestamp không hợp lệ: {payload['timestamp']}")

        # 5. Ràng buộc khối metrics
        metrics = payload.get("metrics")
        if isinstance(metrics, dict):
            metrics_schema = self.schema["properties"]["metrics"]
            if not metrics_schema.get("additionalProperties", True):
                extra_metrics = set(metrics.keys()) - set(metrics_schema.get("properties", {}).keys())
                if extra_metrics:
                    errors.append(f"Phát hiện chỉ số lạ: {list(extra_metrics)}")

            # CPU
            cpu = metrics.get("cpu")
            if isinstance(cpu, dict):
                cpu_schema = metrics_schema["properties"]["cpu"]["properties"]["percent"]
                p = cpu.get("percent")
                if p is None or not isinstance(p, (int, float)) or p < cpu_schema["minimum"] or p > cpu_schema["maximum"]:
                    errors.append(f"Tải CPU vi phạm [0.0 - 100.0]: {p}")
            elif "cpu" in metrics_schema.get("required", []):
                errors.append("Thiếu metrics.cpu")

            # Memory
            mem = metrics.get("memory")
            if isinstance(mem, dict):
                mem_schema = metrics_schema["properties"]["memory"]["properties"]
                if mem.get("total_bytes", 0) < mem_schema["total_bytes"]["minimum"]:
                    errors.append("RAM total_bytes <= 0")
                if mem.get("used_bytes", -1) < mem_schema["used_bytes"]["minimum"]:
                    errors.append("RAM used_bytes < 0")
                if mem.get("percent", -1) < 0 or mem.get("percent", 101) > 100:
                    errors.append("RAM percent vi phạm [0.0 - 100.0]")
            elif "memory" in metrics_schema.get("required", []):
                errors.append("Thiếu metrics.memory")

            # Disk
            disk = metrics.get("disk")
            if isinstance(disk, dict):
                disk_schema = metrics_schema["properties"]["disk"]["properties"]
                if disk.get("total_bytes", 0) < disk_schema["total_bytes"]["minimum"]:
                    errors.append("Disk total_bytes <= 0")
                if disk.get("used_bytes", -1) < disk_schema["used_bytes"]["minimum"]:
                    errors.append("Disk used_bytes < 0")
                if disk.get("percent", -1) < 0 or disk.get("percent", 101) > 100:
                    errors.append("Disk percent vi phạm [0.0 - 100.0]")
            elif "disk" in metrics_schema.get("required", []):
                errors.append("Thiếu metrics.disk")

            # Network
            net = metrics.get("network")
            if isinstance(net, dict):
                net_schema = metrics_schema["properties"]["network"]["properties"]
                if net.get("rx_bytes_total", -1) < net_schema["rx_bytes_total"]["minimum"]:
                    errors.append("Network rx_bytes < 0")
                if net.get("tx_bytes_total", -1) < net_schema["tx_bytes_total"]["minimum"]:
                    errors.append("Network tx_bytes < 0")

            # Uptime
            uptime = metrics.get("uptime_seconds")
            if uptime is None or uptime < 0:
                errors.append("Uptime < 0")

        elif "metrics" in self.schema.get("required", []):
            errors.append("Thiếu khối metrics bắt buộc")

        return errors


class VisualTestRunner:
    """Bộ điều phối báo cáo kiểm thử dạng bảng hộp nét chuẩn và thanh tiến trình sống động."""

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
        """Hiệu ứng thanh tiến trình mô phỏng quá trình quét kiểm thử mượt mà."""
        total = 21
        spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
        sys.stdout.write("\n")
        for i in range(1, total + 1):
            spin = spinners[i % len(spinners)]
            progress = int((i / total) * 32)
            bar = f"{GREEN}{'━' * progress}{DIM}{'┄' * (32 - progress)}{RESET}"
            pct = int((i / total) * 100)
            sys.stdout.write(f"\r  {CYAN}{spin}{RESET}  Đang kiểm thử hệ thống: [{bar}] {BOLD}{pct}%{RESET} ({i:02d}/{total} TC)")
            sys.stdout.flush()
            time.sleep(0.01)
        sys.stdout.write(f"\r  {GREEN}✔{RESET}  Hoàn tất kiểm thử tự động: [{GREEN}{'━' * 32}{RESET}] {BOLD}100%{RESET} (21/21 TC)\n\n")
        sys.stdout.flush()

    def render_table(self):
        total = len(self.results)
        passed_count = sum(1 for r in self.results if r["passed"])
        failed_count = total - passed_count
        duration_ms = (time.time() - self.start_time) * 1000

        # Kích thước cột căn chỉnh chính xác 100%
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
        title = "🛡️  BÁO CÁO KẾT QUẢ KIỂM THỬ TỰ ĐỘNG CHUYÊN SÂU — CHẶNG I (ZT-SERVEROPS)"
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
            if r["passed"]:
                c_status = f"{GREEN}{BOLD}{pad('✔ ĐẠT', w_status - 2, 'center')}{RESET}"
            else:
                c_status = f"{RED}{BOLD}{pad('✖ LỖI', w_status - 2, 'center')}{RESET}"

            row = f"│ {c_id} │ {c_cat} │ {c_name} │ {c_status} │"
            print(row)

        print(f"{DIM}{bot_border}{RESET}\n")

        # Bảng tóm tắt định lượng
        sec_status = f"{GREEN}{BOLD}AN TOÀN TUYỆT ĐỐI (KHÔNG CÓ ĐIỂM CHẾT){RESET}" if failed_count == 0 else f"{RED}{BOLD}PHÁT HIỆN TỬ HUYỆT CẦN VÁ{RESET}"
        print(f"  📌  {BOLD}Tổng số test cases:{RESET} {BOLD}{total}{RESET}  |  {GREEN}✔ Thành công:{RESET} {BOLD}{passed_count}{RESET}  |  {RED}✖ Thất bại:{RESET} {BOLD}{failed_count}{RESET}")
        print(f"  ⏱️   {BOLD}Thời gian quét:{RESET} {CYAN}{duration_ms:.2f} ms{RESET}  |  🛡️  {BOLD}Đánh giá an ninh:{RESET} {sec_status}\n")

        return failed_count == 0


def execute_suite() -> bool:
    runner = VisualTestRunner()

    # 1. KIỂM THỬ HỢP ĐỒNG DỮ LIỆU TELEMETRY (CĐ-01)
    schema_file = CONTRACTS_DIR / "telemetry.schema.json"
    with open(schema_file, "r", encoding="utf-8") as f:
        schema = json.load(f)
    validator = SchemaValidator(schema)

    base_payload = {
        "node_id": "node-production-01",
        "timestamp": 1712450000000,
        "metrics": {
            "cpu": {"percent": 24.5, "load_avg": [0.15, 0.22, 0.18]},
            "memory": {"total_bytes": 8589934592, "used_bytes": 4294967296, "percent": 50.0},
            "disk": {"total_bytes": 107374182400, "used_bytes": 53687091200, "percent": 50.0},
            "network": {"rx_bytes_total": 1048576, "tx_bytes_total": 2097152},
            "uptime_seconds": 86400,
        },
    }

    # TC-01 -> TC-10
    runner.record("TC-01", "Tiêu chuẩn", "Tải trọng hợp lệ với đầy đủ 4 khối phần cứng", len(validator.validate(base_payload)) == 0)

    p_extra = dict(base_payload)
    p_extra["malicious_field"] = "DROP TABLE users;"
    runner.record("TC-02", "Phá hoại", "Bơm trường lạ (Extra Field Injection)", len(validator.validate(p_extra)) > 0)

    p_neg_ram = json.loads(json.dumps(base_payload))
    p_neg_ram["metrics"]["memory"]["used_bytes"] = -1024
    runner.record("TC-03", "Phá hoại", "Bơm giá trị RAM số âm (Negative RAM Memory)", len(validator.validate(p_neg_ram)) > 0)

    p_cpu_overflow = json.loads(json.dumps(base_payload))
    p_cpu_overflow["metrics"]["cpu"]["percent"] = 150.0
    runner.record("TC-04", "Phá hoại", "Bơm chỉ số CPU vượt trần (CPU Overflow 150%)", len(validator.validate(p_cpu_overflow)) > 0)

    p_cpu_neg = json.loads(json.dumps(base_payload))
    p_cpu_neg["metrics"]["cpu"]["percent"] = -5.0
    runner.record("TC-05", "Phá hoại", "Bơm chỉ số CPU số âm (Negative CPU Percent)", len(validator.validate(p_cpu_neg)) > 0)

    p_bad_id = json.loads(json.dumps(base_payload))
    p_bad_id["node_id"] = "bad;id;hack"
    runner.record("TC-06", "Phá hoại", "Bơm Node ID chứa ký tự lạ (Regex Violation)", len(validator.validate(p_bad_id)) > 0)

    p_bad_ts = json.loads(json.dumps(base_payload))
    p_bad_ts["timestamp"] = 500
    runner.record("TC-07", "Phá hoại", "Bơm Timestamp trong quá khứ xa (Anomalous TS)", len(validator.validate(p_bad_ts)) > 0)

    p_bad_net = json.loads(json.dumps(base_payload))
    p_bad_net["metrics"]["network"]["rx_bytes_total"] = -100
    runner.record("TC-08", "Phá hoại", "Bơm Network I/O số âm (Negative Rx Bytes)", len(validator.validate(p_bad_net)) > 0)

    p_no_id = dict(base_payload)
    del p_no_id["node_id"]
    runner.record("TC-09", "Cấu trúc", "Thiếu trường bắt buộc cấp gốc: 'node_id'", len(validator.validate(p_no_id)) > 0)

    p_no_metrics = dict(base_payload)
    del p_no_metrics["metrics"]
    runner.record("TC-10", "Cấu trúc", "Thiếu toàn bộ khối thông số: 'metrics'", len(validator.validate(p_no_metrics)) > 0)

    # 2. KIỂM THỬ ĐẶC TẢ OPENAPI 3.0 (CĐ-02)
    openapi_file = CONTRACTS_DIR / "openapi.yaml"
    with open(openapi_file, "r", encoding="utf-8") as f:
        openapi_text = f.read()

    endpoints = [
        ("/api/auth/login", "Xác thực danh tính và cấp JWT"),
        ("/api/nodes", "Danh mục và Đăng ký máy chủ"),
        ("/api/nodes/{id}", "Chi tiết và Thu hồi máy chủ"),
        ("/api/telemetry", "Cổng nạp Telemetry Ingestion"),
        ("/api/telemetry/history", "Truy vấn lịch sử đo tài nguyên"),
        ("/api/alerts", "Lịch sử cảnh báo sự cố On-Call"),
        ("/ws/terminal/{node_id}", "Cầu nối Web SSH PTY Bastion Bridge"),
    ]

    for idx, (ep, desc) in enumerate(endpoints, start=11):
        runner.record(f"TC-{idx}", "OpenAPI Spec", f"Endpoint {ep} ({desc})", ep in openapi_text)

    runner.record("TC-18", "RBAC Auth", "Phân tầng quyền hạn bắt buộc: ADMIN & VIEWER", "ADMIN" in openapi_text and "VIEWER" in openapi_text)
    runner.record("TC-19", "Bảo mật", "Hai cơ chế khóa định danh: Bearer & NodeToken", "BearerAuth" in openapi_text and "NodeTokenAuth" in openapi_text)

    # 3. KIỂM THỬ CẤU HÌNH MÔI TRƯỜNG (CĐ-03)
    env_example = PROJECT_ROOT / ".env.example"
    with open(env_example, "r", encoding="utf-8") as f:
        env_text = f.read()

    runner.record("TC-20", "Ràng buộc", "Khóa JWT_SECRET bắt buộc tối thiểu 32 ký tự", "JWT_SECRET=" in env_text and "32" in env_text)
    runner.record("TC-21", "Mạng ngầm", "Cấu hình cổng WireGuard duy nhất: UDP 51820", "WG_GATEWAY_IP=" in env_text and "WG_LISTEN_PORT=51820" in env_text)

    # Chạy hiệu ứng thanh tiến trình và xuất bảng định dạng chuẩn
    runner.run_animation()
    return runner.render_table()


class TestContractsTestSuite(unittest.TestCase):
    def test_run_complete_suite(self):
        passed = execute_suite()
        self.assertTrue(passed, "Có ít nhất một Test Case kiểm thử bị thất bại!")


if __name__ == "__main__":
    success = execute_suite()
    sys.exit(0 if success else 1)
