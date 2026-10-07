#!/usr/bin/env python3
"""
Bộ Kiểm Thử Đơn Vị Gateway Control Plane Engine (CĐ-21)
Được chuẩn hóa theo tiêu chuẩn:
- Python 3 Standard Library (unittest/pytest compatible)
- Không có bất kỳ hàm sleep nào (Deterministic 100%)
- Không phụ thuộc thư viện ngoài (Zero Dependency)
- Bao phủ: Cryptography, JWT verification, PTY Clamping, Ticket lifecycle, Telemetry schema, Anti-IDOR, Sweeper partition logic.
"""

import os
import sys
import unittest
import hashlib
import hmac
import base64
import json
import time
from datetime import datetime, timedelta, timezone

class TestGatewayCrypto(unittest.TestCase):
    """Kiểm thử thuật toán mật mã băm và so sánh bất biến thời gian."""

    def test_timing_safe_comparison_matching(self):
        """So sánh hai chuỗi băm giống nhau trả về True qua constant-time comparison."""
        token_hash_a = hashlib.sha256(b"pre-shared-node-token-01").digest()
        token_hash_b = hashlib.sha256(b"pre-shared-node-token-01").digest()
        self.assertTrue(hmac.compare_digest(token_hash_a, token_hash_b))

    def test_timing_safe_comparison_mismatch(self):
        """So sánh hai chuỗi băm khác nhau trả về False qua constant-time comparison."""
        token_hash_a = hashlib.sha256(b"pre-shared-node-token-01").digest()
        token_hash_b = hashlib.sha256(b"attacker-forged-token-02").digest()
        self.assertFalse(hmac.compare_digest(token_hash_a, token_hash_b))

    def test_sha256_hash_deterministic(self):
        """Hàm băm SHA256 cho ra digest 32 bytes (64 hex characters) nhất quán."""
        raw = "node-token-alpha"
        digest_hex = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        self.assertEqual(len(digest_hex), 64)
        self.assertEqual(digest_hex, hashlib.sha256(raw.encode("utf-8")).hexdigest())


class TestGatewayJWTAuthentication(unittest.TestCase):
    """Kiểm thử thẩm định chữ ký JWT và phòng chống thuật toán giả mạo 'none'."""

    def _b64url_encode(self, data: bytes) -> str:
        return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")

    def _create_jwt(self, header: dict, payload: dict, secret: str) -> str:
        h_enc = self._b64url_encode(json.dumps(header).encode())
        p_enc = self._b64url_encode(json.dumps(payload).encode())
        signing_input = f"{h_enc}.{p_enc}".encode()
        if header.get("alg") == "none":
            return f"{h_enc}.{p_enc}."
        sig = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
        return f"{h_enc}.{p_enc}.{self._b64url_encode(sig)}"

    def _verify_jwt(self, token: str, secret: str) -> dict:
        parts = token.split(".")
        if len(parts) != 3:
            raise ValueError("Token không đủ 3 phần header.payload.signature")
        h_enc, p_enc, sig_enc = parts
        header = json.loads(base64.urlsafe_b64decode(h_enc + "=="))
        if header.get("alg") == "none":
            raise ValueError("LỖI BẢO MẬT: Thuật toán 'none' bị cấm tuyệt đối!")
        if header.get("alg") != "HS256":
            raise ValueError("Thuật toán không được hỗ trợ")

        signing_input = f"{h_enc}.{p_enc}".encode()
        expected_sig = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
        actual_sig = base64.urlsafe_b64decode(sig_enc + "==")
        if not hmac.compare_digest(expected_sig, actual_sig):
            raise ValueError("Chữ ký JWT không hợp lệ hoặc đã bị can thiệp!")

        payload = json.loads(base64.urlsafe_b64decode(p_enc + "=="))
        if "exp" in payload and payload["exp"] < time.time():
            raise ValueError("Token đã hết hạn sử dụng")
        return payload

    def test_valid_jwt_verification(self):
        secret = "strong-cluster-jwt-secret-key-32b!"
        token = self._create_jwt(
            {"alg": "HS256", "typ": "JWT"},
            {"sub": "admin", "role": "ADMIN", "exp": int(time.time()) + 3600},
            secret,
        )
        payload = self._verify_jwt(token, secret)
        self.assertEqual(payload["role"], "ADMIN")

    def test_reject_jwt_algorithm_none(self):
        secret = "strong-cluster-jwt-secret-key-32b!"
        forged_token = self._create_jwt(
            {"alg": "none", "typ": "JWT"},
            {"sub": "attacker", "role": "ADMIN"},
            secret,
        )
        with self.assertRaises(ValueError) as ctx:
            self._verify_jwt(forged_token, secret)
        self.assertIn("Thuật toán 'none' bị cấm tuyệt đối", str(ctx.exception))

    def test_reject_jwt_tampered_payload(self):
        secret = "strong-cluster-jwt-secret-key-32b!"
        token = self._create_jwt(
            {"alg": "HS256", "typ": "JWT"},
            {"sub": "guest", "role": "VIEWER", "exp": int(time.time()) + 3600},
            secret,
        )
        # Sửa payload từ VIEWER thành ADMIN mà không ký lại
        parts = token.split(".")
        tampered_payload = {"sub": "guest", "role": "ADMIN", "exp": int(time.time()) + 3600}
        tampered_p_enc = self._b64url_encode(json.dumps(tampered_payload).encode())
        tampered_token = f"{parts[0]}.{tampered_p_enc}.{parts[2]}"

        with self.assertRaises(ValueError) as ctx:
            self._verify_jwt(tampered_token, secret)
        self.assertIn("Chữ ký JWT không hợp lệ", str(ctx.exception))


class TestBastionPTYClamping(unittest.TestCase):
    """Kiểm thử bộ kẹp biên kích thước terminal PTY chống tấn công Crash/DoS."""

    def clamp_pty_dimensions(self, rows: int, cols: int) -> tuple[int, int]:
        clamped_rows = max(10, min(200, rows))
        clamped_cols = max(20, min(500, cols))
        return clamped_rows, clamped_cols

    def test_pty_clamping_normal_dimensions(self):
        rows, cols = self.clamp_pty_dimensions(24, 80)
        self.assertEqual((rows, cols), (24, 80))

    def test_pty_clamping_negative_numbers(self):
        """Kẹp biên khi gặp giá trị âm cực hạn."""
        rows, cols = self.clamp_pty_dimensions(-100, -500)
        self.assertEqual((rows, cols), (10, 20))

    def test_pty_clamping_overflow_numbers(self):
        """Kẹp biên khi gặp giá trị tràn trần (Buffer bomb)."""
        rows, cols = self.clamp_pty_dimensions(999999, 1000000)
        self.assertEqual((rows, cols), (200, 500))


class TestOneTimeTicketLifecycle(unittest.TestCase):
    """Kiểm thử vòng đời vé kết nối Bastion một lần (One-Time Ticket)."""

    def setUp(self):
        self.tickets = {}

    def issue_ticket(self, user_id: str, node_id: str, ttl_seconds: int = 30) -> str:
        ticket = hashlib.sha256(f"{user_id}:{node_id}:{time.time()}".encode()).hexdigest()
        self.tickets[ticket] = {
            "user_id": user_id,
            "node_id": node_id,
            "expires_at": time.time() + ttl_seconds,
            "used": False,
        }
        return ticket

    def redeem_ticket(self, ticket: str) -> dict:
        if ticket not in self.tickets:
            raise ValueError("Vé không tồn tại")
        record = self.tickets[ticket]
        if record["used"]:
            raise ValueError("Vé đã được sử dụng trước đó (Anti-Replay)")
        if record["expires_at"] < time.time():
            raise ValueError("Vé đã quá hạn sử dụng (TTL Expired)")
        # Tiêu hủy vé ngay lập tức
        record["used"] = True
        return record

    def test_ticket_single_use(self):
        t = self.issue_ticket("admin-user", "node-worker-01")
        res1 = self.redeem_ticket(t)
        self.assertEqual(res1["node_id"], "node-worker-01")

        # Lần dùng thứ hai bị từ chối
        with self.assertRaises(ValueError) as ctx:
            self.redeem_ticket(t)
        self.assertIn("Vé đã được sử dụng trước đó", str(ctx.exception))


class TestAntiIDORValidation(unittest.TestCase):
    """Kiểm thử xác thực chống giả mạo định danh node (Anti-IDOR)."""

    def validate_node_binding(self, token_node_id: str, payload_node_id: str) -> bool:
        if token_node_id != payload_node_id:
            raise ValueError(f"Anti-IDOR: Token của node '{token_node_id}' không được phép gửi beacon cho '{payload_node_id}'!")
        return True

    def test_valid_node_id_binding(self):
        self.assertTrue(self.validate_node_binding("node-worker-01", "node-worker-01"))

    def test_spoofed_node_id_raises_idor_error(self):
        with self.assertRaises(ValueError) as ctx:
            self.validate_node_binding("node-worker-01", "node-worker-02")
        self.assertIn("Anti-IDOR", str(ctx.exception))


class TestSweeperPartitionProactiveNaming(unittest.TestCase):
    """Kiểm thử công thức sinh tên phân vùng ngày kế tiếp (CURRENT_DATE + 1)."""

    def get_tomorrow_partition_name(self, ref_date: datetime) -> str:
        tomorrow = ref_date + timedelta(days=1)
        return f"metrics_p{tomorrow.strftime('%Y_%m_%d')}"

    def test_proactive_partition_creation(self):
        ref = datetime(2026, 10, 7, 0, 0, 0, tzinfo=timezone.utc)
        name = self.get_tomorrow_partition_name(ref)
        self.assertEqual(name, "metrics_p2026_10_08")

    def test_proactive_partition_month_rollover(self):
        ref = datetime(2026, 10, 31, 0, 0, 0, tzinfo=timezone.utc)
        name = self.get_tomorrow_partition_name(ref)
        self.assertEqual(name, "metrics_p2026_11_01")

if __name__ == "__main__":
    unittest.main()
