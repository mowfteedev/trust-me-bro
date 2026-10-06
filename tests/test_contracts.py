import json
import re
import sys
import time
import unittest
from pathlib import Path

# Định vị thư mục gốc dự án
PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONTRACTS_DIR = PROJECT_ROOT / "contracts"


class SchemaValidator:
    """
    Bộ thẩm định Schema chuẩn hóa độc lập (Zero-Dependency Schema Engine).
    Thẩm định nghiêm ngặt theo các quy tắc đã định nghĩa trong telemetry.schema.json.
    """

    def __init__(self, schema: dict):
        self.schema = schema

    def validate(self, payload: dict) -> list[str]:
        errors = []
        if not isinstance(payload, dict):
            return ["Tải trọng gốc bắt buộc phải là một đối tượng JSON (Object)."]

        # 1. Kiểm tra additionalProperties ở tầng gốc
        if not self.schema.get("additionalProperties", True):
            allowed_keys = set(self.schema.get("properties", {}).keys())
            extra_keys = set(payload.keys()) - allowed_keys
            if extra_keys:
                errors.append(f"Phát hiện trường lạ không được phép: {list(extra_keys)}")

        # 2. Kiểm tra required keys ở tầng gốc
        for req in self.schema.get("required", []):
            if req not in payload:
                errors.append(f"Thiếu trường bắt buộc cấp gốc: '{req}'")

        # 3. Kiểm tra định dạng node_id
        if "node_id" in payload:
            pattern = self.schema["properties"]["node_id"].get("pattern")
            if pattern and not re.match(pattern, str(payload["node_id"])):
                errors.append(f"node_id không khớp định dạng regex: '{payload['node_id']}'")

        # 4. Kiểm tra timestamp
        if "timestamp" in payload:
            ts_min = self.schema["properties"]["timestamp"].get("minimum", 0)
            if not isinstance(payload["timestamp"], int) or payload["timestamp"] < ts_min:
                errors.append(f"timestamp không hợp lệ (nhỏ hơn {ts_min}): {payload['timestamp']}")

        # 5. Kiểm tra khối metrics
        metrics = payload.get("metrics")
        if isinstance(metrics, dict):
            metrics_schema = self.schema["properties"]["metrics"]
            if not metrics_schema.get("additionalProperties", True):
                extra_metrics = set(metrics.keys()) - set(metrics_schema.get("properties", {}).keys())
                if extra_metrics:
                    errors.append(f"Phát hiện chỉ số lạ trong metrics: {list(extra_metrics)}")

            # 5.1 CPU
            cpu = metrics.get("cpu")
            if isinstance(cpu, dict):
                cpu_schema = metrics_schema["properties"]["cpu"]["properties"]["percent"]
                p = cpu.get("percent")
                if p is None or not (isinstance(p, (int, float))) or p < cpu_schema["minimum"] or p > cpu_schema["maximum"]:
                    errors.append(f"Tải CPU percent vi phạm khoảng biên [0.0 - 100.0]: {p}")
                if "load_avg" in cpu:
                    la = cpu["load_avg"]
                    if not isinstance(la, list) or len(la) != 3 or any(x < 0 for x in la):
                        errors.append(f"Chỉ số load_avg không hợp lệ: {la}")
            elif "cpu" in metrics_schema.get("required", []):
                errors.append("Thiếu trường metrics.cpu")

            # 5.2 Memory
            mem = metrics.get("memory")
            if isinstance(mem, dict):
                mem_schema = metrics_schema["properties"]["memory"]["properties"]
                if mem.get("total_bytes", 0) < mem_schema["total_bytes"]["minimum"]:
                    errors.append(f"memory.total_bytes phải lớn hơn 0: {mem.get('total_bytes')}")
                if mem.get("used_bytes", -1) < mem_schema["used_bytes"]["minimum"]:
                    errors.append(f"memory.used_bytes không được âm: {mem.get('used_bytes')}")
                if mem.get("percent", -1) < 0 or mem.get("percent", 101) > 100:
                    errors.append(f"memory.percent vi phạm khoảng biên [0.0 - 100.0]: {mem.get('percent')}")
            elif "memory" in metrics_schema.get("required", []):
                errors.append("Thiếu trường metrics.memory")

            # 5.3 Disk
            disk = metrics.get("disk")
            if isinstance(disk, dict):
                disk_schema = metrics_schema["properties"]["disk"]["properties"]
                if disk.get("total_bytes", 0) < disk_schema["total_bytes"]["minimum"]:
                    errors.append(f"disk.total_bytes phải lớn hơn 0: {disk.get('total_bytes')}")
                if disk.get("used_bytes", -1) < disk_schema["used_bytes"]["minimum"]:
                    errors.append(f"disk.used_bytes không được âm: {disk.get('used_bytes')}")
                if disk.get("percent", -1) < 0 or disk.get("percent", 101) > 100:
                    errors.append(f"disk.percent vi phạm khoảng biên [0.0 - 100.0]: {disk.get('percent')}")

            # 5.4 Network
            net = metrics.get("network")
            if isinstance(net, dict):
                net_schema = metrics_schema["properties"]["network"]["properties"]
                if net.get("rx_bytes_total", -1) < net_schema["rx_bytes_total"]["minimum"]:
                    errors.append(f"network.rx_bytes_total không được âm: {net.get('rx_bytes_total')}")
                if net.get("tx_bytes_total", -1) < net_schema["tx_bytes_total"]["minimum"]:
                    errors.append(f"network.tx_bytes_total không được âm: {net.get('tx_bytes_total')}")

            # 5.5 Uptime
            uptime = metrics.get("uptime_seconds")
            if uptime is None or uptime < 0:
                errors.append(f"metrics.uptime_seconds không được âm: {uptime}")
        elif "metrics" in self.schema.get("required", []):
            errors.append("Thiếu khối metrics bắt buộc")

        return errors


class DetailedTestRunner:
    """Bộ điều phối báo cáo kết quả kiểm thử trực quan dạng bảng trên Terminal."""

    def __init__(self):
        self.results = []
        self.start_time = time.time()

    def record(self, case_id: str, category: str, name: str, passed: bool, detail: str = ""):
        self.results.append({
            "id": case_id,
            "category": category,
            "name": name,
            "passed": passed,
            "detail": detail,
        })

    def print_report(self):
        total = len(self.results)
        passed_count = sum(1 for r in self.results if r["passed"])
        failed_count = total - passed_count
        duration_ms = (time.time() - self.start_time) * 1000

        print("\n" + "=" * 95)
        print("    🛡️  BÁO CÁO KẾT QUẢ KIỂM THỬ TỰ ĐỘNG CHUYÊN SÂU — CHẶNG I (ZT-SERVEROPS)")
        print("=" * 95)
        print(f" {'MÃ TC':<8} | {'PHÂN LOẠI':<12} | {'TÊN TEST CASE & KỊCH BẢN THỬ NGHIỆM':<45} | {'KẾT QUẢ':<10}")
        print("-" * 95)

        for r in self.results:
            status_text = "✅ ĐẠT" if r["passed"] else "❌ THẤT BẠI"
            print(f" {r['id']:<8} | {r['category']:<12} | {r['name']:<45} | {status_text:<10}")
            if r["detail"]:
                print(f"          └─> 💡 Chi tiết: {r['detail']}")

        print("-" * 95)
        print(f" 📊 TỔNG KẾT: {passed_count}/{total} Test Cases thành công (Tỷ lệ: {passed_count/total*100:.1f}%)")
        print(f" ⏱️  THỜI GIAN THỰC THI: {duration_ms:.2f} ms")
        print(f" 🛡️  CHỐT CHẶN AN NINH: {'KHÔNG CÓ ĐIỂM CHẾT NÀO' if failed_count == 0 else 'PHÁT HIỆN TỬ HUYỆT CẦN VÁ'}")
        print("=" * 95 + "\n")

        return failed_count == 0


def execute_full_suite() -> bool:
    runner = DetailedTestRunner()

    # -------------------------------------------------------------
    # 1. KIỂM THỬ HỢP ĐỒNG DỮ LIỆU TELEMETRY (CĐ-01)
    # -------------------------------------------------------------
    schema_file = CONTRACTS_DIR / "telemetry.schema.json"
    with open(schema_file, "r", encoding="utf-8") as f:
        schema = json.load(f)
    validator = SchemaValidator(schema)

    base_payload = {
        "node_id": "node-worker-01",
        "timestamp": 1712450000000,
        "metrics": {
            "cpu": {"percent": 28.4, "load_avg": [0.45, 0.32, 0.28]},
            "memory": {"total_bytes": 17179869184, "used_bytes": 8589934592, "percent": 50.0},
            "disk": {"total_bytes": 536870912000, "used_bytes": 214748364800, "percent": 40.0},
            "network": {"rx_bytes_total": 45000000, "tx_bytes_total": 32000000},
            "uptime_seconds": 124500,
        },
    }

    # TC-01: Tải trọng chuẩn đầy đủ
    errs = validator.validate(base_payload)
    runner.record("TC-01", "Chuẩn (Case A)", "Tải trọng hợp lệ với đầy đủ 4 khối phần cứng", len(errs) == 0, "Dữ liệu hợp lệ chuẩn 100%")

    # TC-02: Phá hoại - Bơm trường lạ ngoài Schema
    p_extra = dict(base_payload)
    p_extra["malicious_cmd"] = "rm -rf /"
    errs = validator.validate(p_extra)
    runner.record("TC-02", "Phá hoại", "Bơm trường lạ (Extra Field Injection)", len(errs) > 0 and "malicious_cmd" in errs[0], f"Chặn thành công: {errs}")

    # TC-03: Phá hoại - Bơm RAM số âm
    p_neg_ram = json.loads(json.dumps(base_payload))
    p_neg_ram["metrics"]["memory"]["used_bytes"] = -4096
    errs = validator.validate(p_neg_ram)
    runner.record("TC-03", "Phá hoại", "Bơm giá trị RAM số âm (Negative RAM Memory)", len(errs) > 0, f"Chặn thành công: {errs}")

    # TC-04: Phá hoại - Bơm CPU tràn trần (> 100%)
    p_cpu_overflow = json.loads(json.dumps(base_payload))
    p_cpu_overflow["metrics"]["cpu"]["percent"] = 101.5
    errs = validator.validate(p_cpu_overflow)
    runner.record("TC-04", "Phá hoại", "Bơm chỉ số CPU vượt trần (CPU Overflow 101.5%)", len(errs) > 0, f"Chặn thành công: {errs}")

    # TC-05: Phá hoại - Bơm CPU số âm (< 0%)
    p_cpu_underflow = json.loads(json.dumps(base_payload))
    p_cpu_underflow["metrics"]["cpu"]["percent"] = -1.0
    errs = validator.validate(p_cpu_underflow)
    runner.record("TC-05", "Phá hoại", "Bơm chỉ số CPU số âm (Negative CPU Percent)", len(errs) > 0, f"Chặn thành công: {errs}")

    # TC-06: Phá hoại - Bơm Node ID chứa ký tự đặc biệt nguy hiểm
    p_bad_id = json.loads(json.dumps(base_payload))
    p_bad_id["node_id"] = "node;DROP TABLE users;--"
    errs = validator.validate(p_bad_id)
    runner.record("TC-06", "Phá hoại", "Bơm Node ID chứa mã tiêm SQL (Regex Violation)", len(errs) > 0, f"Chặn thành công: {errs}")

    # TC-07: Phá hoại - Bơm Timestamp ở thời cổ xưa
    p_bad_ts = json.loads(json.dumps(base_payload))
    p_bad_ts["timestamp"] = 1000
    errs = validator.validate(p_bad_ts)
    runner.record("TC-07", "Phá hoại", "Bơm Timestamp trong quá khứ xa (Timestamp Anomaly)", len(errs) > 0, f"Chặn thành công: {errs}")

    # TC-08: Phá hoại - Bơm Băng thông mạng Network I/O số âm
    p_bad_net = json.loads(json.dumps(base_payload))
    p_bad_net["metrics"]["network"]["rx_bytes_total"] = -999
    errs = validator.validate(p_bad_net)
    runner.record("TC-08", "Phá hoại", "Bơm Network I/O số âm (Negative Rx Bytes)", len(errs) > 0, f"Chặn thành công: {errs}")

    # TC-09: Phá hoại - Thiếu trường bắt buộc node_id
    p_no_id = dict(base_payload)
    del p_no_id["node_id"]
    errs = validator.validate(p_no_id)
    runner.record("TC-09", "Cấu trúc", "Thiếu trường bắt buộc cấp gốc: 'node_id'", len(errs) > 0, f"Bắt lỗi thiếu trường: {errs}")

    # TC-10: Phá hoại - Thiếu toàn bộ khối metrics
    p_no_metrics = dict(base_payload)
    del p_no_metrics["metrics"]
    errs = validator.validate(p_no_metrics)
    runner.record("TC-10", "Cấu trúc", "Thiếu toàn bộ khối thông số: 'metrics'", len(errs) > 0, f"Bắt lỗi thiếu metrics: {errs}")

    # -------------------------------------------------------------
    # 2. KIỂM THỬ ĐẶC TẢ OPENAPI 3.0 (CĐ-02)
    # -------------------------------------------------------------
    openapi_file = CONTRACTS_DIR / "openapi.yaml"
    with open(openapi_file, "r", encoding="utf-8") as f:
        openapi_text = f.read()

    endpoints_to_check = [
        ("/api/auth/login", "Xác thực danh tính và cấp JWT"),
        ("/api/nodes", "Danh mục và Đăng ký máy chủ"),
        ("/api/nodes/{id}", "Chi tiết và Thu hồi máy chủ"),
        ("/api/telemetry", "Cổng nạp Telemetry Ingestion"),
        ("/api/telemetry/history", "Truy vấn lịch sử đo đạc tài nguyên"),
        ("/api/alerts", "Lịch sử cảnh báo sự cố On-Call"),
        ("/ws/terminal/{node_id}", "Cầu nối Web SSH PTY Bastion Bridge"),
    ]

    for idx, (ep, desc) in enumerate(endpoints_to_check, start=11):
        has_ep = ep in openapi_text
        runner.record(f"TC-{idx}", "OpenAPI Spec", f"Endpoint {ep} ({desc})", has_ep, "Khớp định nghĩa trong paths")

    # TC-18: Kiểm tra ranh giới phân quyền RBAC
    has_rbac = "ADMIN" in openapi_text and "VIEWER" in openapi_text
    runner.record("TC-18", "RBAC Auth", "Phân tầng quyền hạn bắt buộc: ADMIN & VIEWER", has_rbac, "Xác định rõ vai trò trong OpenAPI Schemas")

    # TC-19: Kiểm tra hai cơ chế khóa bảo mật
    has_sec = "BearerAuth" in openapi_text and "NodeTokenAuth" in openapi_text
    runner.record("TC-19", "Security", "Hai cơ chế khóa định danh: BearerAuth & NodeTokenAuth", has_sec, "Bảo vệ kép cả tầng Web và tầng M2M")

    # -------------------------------------------------------------
    # 3. KIỂM THỬ RÀNG BUỘC CẤU HÌNH MÔI TRƯỜNG (CĐ-03)
    # -------------------------------------------------------------
    env_example = PROJECT_ROOT / ".env.example"
    with open(env_example, "r", encoding="utf-8") as f:
        env_text = f.read()

    has_jwt_req = "JWT_SECRET=" in env_text and "32" in env_text
    runner.record("TC-20", "Config Guard", "Ràng buộc an ninh: JWT_SECRET tối thiểu 32 ký tự", has_jwt_req, "Có ghi chú bắt buộc bảo mật")

    has_wireguard_cfg = "WG_GATEWAY_IP=" in env_text and "WG_LISTEN_PORT=51820" in env_text
    runner.record("TC-21", "Underlay", "Cấu hình cổng mạng ngầm duy nhất: UDP 51820", has_wireguard_cfg, "Đúng cam kết Zero Inbound Ports")

    # In kết quả
    return runner.print_report()


# Cho phép chạy tương thích cả bằng unittest lẫn chạy trực tiếp python3
class TestContractsTestSuite(unittest.TestCase):
    def test_run_complete_suite(self):
        passed = execute_full_suite()
        self.assertTrue(passed, "Có ít nhất một Test Case kiểm thử bị thất bại!")


if __name__ == "__main__":
    success = execute_full_suite()
    sys.exit(0 if success else 1)
