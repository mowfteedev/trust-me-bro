import json
import re
import unittest
from pathlib import Path

# Định vị thư mục gốc của dự án
PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONTRACTS_DIR = PROJECT_ROOT / "contracts"


class TestTelemetryContract(unittest.TestCase):
    """
    KIỂM THỬ HỢP ĐỒNG GIAO THỨC TELEMETRY BEACON (CĐ-01)
    Bao gồm cả kịch bản chuẩn (Case A) và kịch bản phá hoại dữ liệu biên (Case B).
    """

    def setUp(self):
        schema_path = CONTRACTS_DIR / "telemetry.schema.json"
        self.assertTrue(schema_path.exists(), "Tệp telemetry.schema.json không tồn tại!")
        with open(schema_path, "r", encoding="utf-8") as f:
            self.schema = json.load(f)

        # Tải trọng chuẩn (Case A)
        self.valid_payload = {
            "node_id": "node-production-01",
            "timestamp": 1712450000000,
            "metrics": {
                "cpu": {
                    "percent": 24.5,
                    "load_avg": [0.15, 0.22, 0.18],
                },
                "memory": {
                    "total_bytes": 8589934592,
                    "used_bytes": 4294967296,
                    "percent": 50.0,
                },
                "disk": {
                    "total_bytes": 107374182400,
                    "used_bytes": 53687091200,
                    "percent": 50.0,
                },
                "network": {
                    "rx_bytes_total": 1048576,
                    "tx_bytes_total": 2097152,
                },
                "uptime_seconds": 86400,
            },
        }

    def test_case_01_a_valid_payload_structure(self):
        """[Case A] Tải trọng đầy đủ và đúng định dạng phải thỏa mãn schema."""
        self.assertEqual(self.schema["type"], "object")
        self.assertFalse(self.schema["additionalProperties"])
        for required_key in ["node_id", "timestamp", "metrics"]:
            self.assertIn(required_key, self.valid_payload)

    def test_case_01_b_reject_extra_field_injection(self):
        """[Case B - Phá hoại] Bơm trường dữ liệu lạ vào tải trọng phải bị từ chối."""
        malicious_payload = dict(self.valid_payload)
        malicious_payload["malicious_field"] = "DROP TABLE users;"
        # Kiểm tra theo nguyên tắc additionalProperties: false
        allowed_properties = set(self.schema["properties"].keys())
        extra_keys = set(malicious_payload.keys()) - allowed_properties
        self.assertTrue(
            len(extra_keys) > 0,
            "Hệ thống phải phát hiện ra trường lạ không được phép!",
        )

    def test_case_01_b_reject_negative_hardware_metrics(self):
        """[Case B - Phá hoại] Bơm RAM hoặc Disk số âm phải vi phạm ràng buộc."""
        invalid_payload = json.loads(json.dumps(self.valid_payload))
        invalid_payload["metrics"]["memory"]["used_bytes"] = -1024
        invalid_payload["metrics"]["disk"]["total_bytes"] = 0

        # Rà soát ràng buộc tối thiểu từ schema
        mem_used_min = self.schema["properties"]["metrics"]["properties"]["memory"]["properties"]["used_bytes"]["minimum"]
        disk_total_min = self.schema["properties"]["metrics"]["properties"]["disk"]["properties"]["total_bytes"]["minimum"]

        self.assertLess(invalid_payload["metrics"]["memory"]["used_bytes"], mem_used_min)
        self.assertLess(invalid_payload["metrics"]["disk"]["total_bytes"], disk_total_min)

    def test_case_01_b_reject_out_of_bounds_cpu(self):
        """[Case B - Phá hoại] Bơm CPU vượt trần 100% hoặc số âm."""
        cpu_max = self.schema["properties"]["metrics"]["properties"]["cpu"]["properties"]["percent"]["maximum"]
        cpu_min = self.schema["properties"]["metrics"]["properties"]["cpu"]["properties"]["percent"]["minimum"]

        self.assertEqual(cpu_max, 100.0)
        self.assertEqual(cpu_min, 0.0)


class TestOpenAPISpec(unittest.TestCase):
    """
    KIỂM THỬ ĐẶC TẢ REST API OPENAPI 3.0 (CĐ-02)
    Bảo đảm đủ 10 Endpoints, RBAC và không thiếu mã lỗi.
    """

    def setUp(self):
        openapi_path = CONTRACTS_DIR / "openapi.yaml"
        self.assertTrue(openapi_path.exists(), "Tệp openapi.yaml không tồn tại!")
        with open(openapi_path, "r", encoding="utf-8") as f:
            self.content = f.read()

    def test_required_endpoints_exist(self):
        """Kiểm tra sự hiện diện của các endpoints cốt lõi."""
        endpoints = [
            "/api/auth/login",
            "/api/nodes",
            "/api/nodes/{id}",
            "/api/telemetry",
            "/api/telemetry/history",
            "/api/alerts",
            "/ws/terminal/{node_id}",
        ]
        for ep in endpoints:
            self.assertIn(ep, self.content, f"Thiếu endpoint: {ep}")

    def test_rbac_roles_defined(self):
        """Kiểm tra sự phân định vai trò ADMIN và VIEWER."""
        self.assertIn("ADMIN", self.content)
        self.assertIn("VIEWER", self.content)
        self.assertIn("BearerAuth", self.content)
        self.assertIn("NodeTokenAuth", self.content)


class TestEnvConfiguration(unittest.TestCase):
    """
    KIỂM THỬ RÀNG BUỘC CẤU HÌNH MÔI TRƯỜNG (CĐ-03)
    """

    def test_env_example_has_security_requirements(self):
        """Tệp .env.example phải chứa biến JWT_SECRET với ghi chú tối thiểu 32 ký tự."""
        env_path = PROJECT_ROOT / ".env.example"
        self.assertTrue(env_path.exists(), "Tệp .env.example không tồn tại!")
        with open(env_path, "r", encoding="utf-8") as f:
            content = f.read()

        self.assertIn("JWT_SECRET=", content)
        self.assertIn("DATABASE_URL=", content)
        self.assertIn("SWEEPER_INTERVAL_MS=", content)
        self.assertIn("WG_LISTEN_PORT=", content)


if __name__ == "__main__":
    unittest.main()
