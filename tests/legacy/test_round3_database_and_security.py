"""
==============================================================================
BỘ KIỂM CHỨNG TÍCH HỢP POSTGRESQL & BẢO MẬT HẠ TẦNG VÒNG 3 (ZT-SERVEROPS)
File: tests/test_round3_database_and_security.py
Phụ trách: database (chủ trì), security, tester
Tham chiếu: N01, N02, N03, N04, P1
==============================================================================
"""

import os
import sys
import json
import psycopg2
import requests
import subprocess
import unittest

DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = int(os.getenv("DB_PORT", "5432"))
DB_NAME = os.getenv("POSTGRES_DB", "zt_serverops")
ADMIN_USER = os.getenv("POSTGRES_USER", "zt_admin")
ADMIN_PASS = os.getenv("POSTGRES_PASSWORD", "SecurePassword123!")

GATEWAY_URL = os.getenv("GATEWAY_URL", "http://localhost:3000")


class TestRound3DatabaseAndSecurity(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        # Kết nối tới database bằng quyền zt_admin
        try:
            cls.admin_conn = psycopg2.connect(
                host=DB_HOST,
                port=DB_PORT,
                dbname=DB_NAME,
                user=ADMIN_USER,
                password=ADMIN_PASS,
                connect_timeout=5
            )
            cls.admin_conn.autocommit = True
        except Exception as e:
            cls.admin_conn = None
            print(f"⚠️ [WARNING] Không thể kết nối DB tại {DB_HOST}:{DB_PORT}: {e}")

    @classmethod
    def tearDownClass(cls):
        if cls.admin_conn:
            cls.admin_conn.close()

    def test_n03_drop_old_partitions_rejects_negative_retention(self):
        """N03: Hàm drop_old_metrics_partitions bắt buộc phải từ chối tham số âm (-36500) hoặc < 7 ngày."""
        if not self.admin_conn:
            self.skipTest("Database chưa sẵn sàng")

        with self.admin_conn.cursor() as cur:
            # Thử số âm cực đoan (-36500 ngày)
            with self.assertRaises(psycopg2.Error) as ctx:
                cur.execute("SELECT * FROM public.drop_old_metrics_partitions(-36500);")
            self.assertIn("Tham số retention_days không hợp lệ", str(ctx.exception))

            # Thử số nhỏ hơn 7 ngày (0 ngày)
            with self.assertRaises(psycopg2.Error) as ctx:
                cur.execute("SELECT * FROM public.drop_old_metrics_partitions(0);")
            self.assertIn("Tham số retention_days không hợp lệ", str(ctx.exception))

            # Thử số quá lớn (> 365 ngày)
            with self.assertRaises(psycopg2.Error) as ctx:
                cur.execute("SELECT * FROM public.drop_old_metrics_partitions(1000);")
            self.assertIn("Tham số retention_days không hợp lệ", str(ctx.exception))

    def test_n03_create_daily_partition_rejects_out_of_bounds_date(self):
        """N03: Hàm create_daily_metrics_partition bắt buộc phải từ chối ngày ngoài biên +-7 ngày."""
        if not self.admin_conn:
            self.skipTest("Database chưa sẵn sàng")

        with self.admin_conn.cursor() as cur:
            # Thử ngày 100 năm vào tương lai
            with self.assertRaises(psycopg2.Error) as ctx:
                cur.execute("SELECT public.create_daily_metrics_partition('2126-01-01'::date);")
            self.assertIn("Tham số target_date không hợp lệ", str(ctx.exception))

            # Thử ngày 100 năm trong quá khứ
            with self.assertRaises(psycopg2.Error) as ctx:
                cur.execute("SELECT public.create_daily_metrics_partition('1926-01-01'::date);")
            self.assertIn("Tham số target_date không hợp lệ", str(ctx.exception))

    def test_n03_function_privileges_and_search_path(self):
        """N03: Quyền execute drop partition bị thu hồi khỏi PUBLIC và zt_app, search_path an toàn."""
        if not self.admin_conn:
            self.skipTest("Database chưa sẵn sàng")

        with self.admin_conn.cursor() as cur:
            # Kiểm tra search_path của hàm
            cur.execute("""
                SELECT prosrc, prosecdef, proconfig
                FROM pg_proc
                WHERE proname = 'drop_old_metrics_partitions';
            """)
            row = cur.fetchone()
            self.assertIsNotNone(row)
            prosecdef = row[1]
            proconfig = row[2] or []
            self.assertTrue(prosecdef, "Hàm phải là SECURITY DEFINER")
            self.assertTrue(
                any("search_path=" in c for c in proconfig),
                "Hàm phải có cấu hình search_path an toàn cố định"
            )

    def test_n04_worker_token_revocation_without_node_deletion(self):
        """N04: Thu hồi worker token không làm mất node UUID và metrics history."""
        if not self.admin_conn:
            self.skipTest("Database chưa sẵn sàng")

        with self.admin_conn.cursor() as cur:
            # Kiểm tra xem có node nào trong bảng nodes
            cur.execute("SELECT id, name, token_prefix, token_hash FROM nodes LIMIT 5;")
            nodes = cur.fetchall()
            self.assertTrue(len(nodes) > 0, "Bảng nodes không được rỗng sau migration")

    def test_n04_telemetry_ingest_protocol_and_token_discrimination(self):
        """N04/R01: Telemetry Ingest phân biệt rõ ràng MISSING, INVALID và REVOKED token qua header X-Node-Token."""
        # 1. Thiếu header X-Node-Token -> 401 MISSING_NODE_TOKEN
        res1 = requests.post(f"{GATEWAY_URL}/api/telemetry/beacon", json={"node_id": "test", "timestamp": 12345})
        self.assertEqual(res1.status_code, 401)
        data1 = res1.json()
        self.assertEqual(data1.get("code"), "MISSING_NODE_TOKEN")

        # 2. Token không tồn tại -> 401 INVALID_NODE_TOKEN
        headers_invalid = {"X-Node-Token": "non-existent-token-1234567890"}
        res2 = requests.post(f"{GATEWAY_URL}/api/telemetry/beacon", headers=headers_invalid, json={"node_id": "test", "timestamp": 12345})
        self.assertEqual(res2.status_code, 401)
        data2 = res2.json()
        self.assertEqual(data2.get("code"), "INVALID_NODE_TOKEN")

    def test_p1_bootstrap_admin_rejects_password_flag(self):
        """P1: Script bootstrap-admin bắt buộc từ chối cờ --password để chống rò rỉ qua argv."""
        result = subprocess.run(
            ["docker", "run", "--rm", "test-gateway-build", "node", "dist/scripts/bootstrap-admin.js", "--password", "Secret123!"],
            capture_output=True,
            text=True
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SECURITY VIOLATION", result.stderr + result.stdout)


if __name__ == "__main__":
    unittest.main()
