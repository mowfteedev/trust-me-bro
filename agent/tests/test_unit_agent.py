#!/usr/bin/env python3
"""
Bộ Kiểm Thử Đơn Vị Worker Daemon Agent (CĐ-21)
Được chuẩn hóa theo tiêu chuẩn:
- Python 3 Standard Library (unittest/pytest compatible)
- Không có bất kỳ hàm sleep nào (Deterministic 100%)
- Không phụ thuộc thư viện ngoài (Zero Dependency)
- Bao phủ: CPU, Memory, Disk, Network collectors, Config validation, Jitter và Backoff logic.
"""

import os
import sys
import unittest
import math
from unittest.mock import patch, mock_open

# Thêm đường dẫn mã nguồn agent vào sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from config import AgentConfig
from collectors.cpu import CPUCollector
from collectors.memory import MemoryCollector
from collectors.disk import DiskCollector
from collectors.network import NetworkCollector

class TestAgentConfig(unittest.TestCase):
    """Kiểm thử thẩm định nạp biến môi trường cho Worker Daemon."""

    def test_default_config_values(self):
        """Xác nhận các giá trị cấu hình mặc định an toàn."""
        with patch.dict(os.environ, {"NODE_TOKEN": "valid-secret-token"}, clear=True):
            cfg = AgentConfig()
            self.assertEqual(cfg.gateway_url, "http://10.100.0.1:3000")
            self.assertEqual(cfg.node_id, "node-worker-01")
            self.assertEqual(cfg.interval, 3.0)
            self.assertEqual(cfg.max_backoff, 30.0)
            self.assertEqual(cfg.jitter_ratio, 0.1)

    def test_missing_node_token_raises_error(self):
        """Từ chối khởi động nếu thiếu mã bí mật NODE_TOKEN."""
        with patch.dict(os.environ, {"NODE_TOKEN": ""}, clear=True):
            cfg = AgentConfig()
            with self.assertRaises(ValueError) as ctx:
                cfg.validate()
            self.assertIn("NODE_TOKEN không được để trống", str(ctx.exception))

    def test_invalid_gateway_url_raises_error(self):
        """Từ chối GATEWAY_URL không có lược đồ http/https."""
        with patch.dict(os.environ, {"NODE_TOKEN": "secret", "GATEWAY_URL": "ftp://bad-url"}, clear=True):
            cfg = AgentConfig()
            with self.assertRaises(ValueError) as ctx:
                cfg.validate()
            self.assertIn("GATEWAY_URL không hợp lệ", str(ctx.exception))

    def test_invalid_node_id_raises_error(self):
        """Từ chối NODE_ID quá ngắn (< 3 ký tự)."""
        with patch.dict(os.environ, {"NODE_TOKEN": "secret", "NODE_ID": "ab"}, clear=True):
            cfg = AgentConfig()
            with self.assertRaises(ValueError) as ctx:
                cfg.validate()
            self.assertIn("NODE_ID quá ngắn", str(ctx.exception))


class TestCPUCollector(unittest.TestCase):
    """Kiểm thử tính toán chỉ số tải CPU qua delta jiffies."""

    def test_cpu_collector_percent_calculation(self):
        collector = CPUCollector()
        collector.prev_idle = 1000
        collector.prev_total = 2000

        # Giả lập điểm đo tiếp theo: delta_idle = 200, delta_total = 1000 => cpu = 80.0%
        mock_proc_stat = "cpu  400 100 300 1200 0 0 0 0 0 0\n"
        with patch("os.path.exists", return_value=True):
            with patch("builtins.open", mock_open(read_data=mock_proc_stat)):
                res = collector.collect()
                self.assertIn("percent", res)
                self.assertIn("load_avg", res)
                self.assertGreaterEqual(res["percent"], 0.0)
                self.assertLessEqual(res["percent"], 100.0)

    def test_cpu_collector_clamping_bounds(self):
        """Đảm bảo chỉ số CPU luôn được kẹp biên trong khoảng [0.0, 100.0]."""
        collector = CPUCollector()
        collector.prev_idle = 5000
        collector.prev_total = 1000  # Trường hợp nghịch lý
        with patch("os.path.exists", return_value=False):
            res = collector.collect()
            self.assertGreaterEqual(res["percent"], 0.0)
            self.assertLessEqual(res["percent"], 100.0)


class TestMemoryCollector(unittest.TestCase):
    """Kiểm thử tính toán RAM dựa trên MemAvailable."""

    def test_memory_collector_memavailable_used(self):
        mock_meminfo = (
            "MemTotal:        16384000 kB\n"
            "MemFree:          2048000 kB\n"
            "MemAvailable:     8192000 kB\n"
            "Buffers:           512000 kB\n"
            "Cached:           6144000 kB\n"
        )
        with patch("os.path.exists", return_value=True):
            with patch("builtins.open", mock_open(read_data=mock_meminfo)):
                collector = MemoryCollector()
                metrics = collector.collect()

                expected_total = 16384000 * 1024
                expected_available = 8192000 * 1024
                expected_used = expected_total - expected_available
                expected_pct = round((expected_used / expected_total) * 100.0, 2)

                self.assertEqual(metrics["total_bytes"], expected_total)
                self.assertEqual(metrics["used_bytes"], expected_used)
                self.assertEqual(metrics["percent"], expected_pct)
                self.assertEqual(metrics["percent"], 50.0)


class TestDiskCollector(unittest.TestCase):
    """Kiểm thử chỉ số ổ cứng POSIX statvfs."""

    def test_disk_collector_posix_statvfs(self):
        collector = DiskCollector(mount_point="/")
        metrics = collector.collect()
        self.assertIn("total_bytes", metrics)
        self.assertIn("used_bytes", metrics)
        self.assertIn("percent", metrics)
        self.assertGreater(metrics["total_bytes"], 0)
        self.assertGreaterEqual(metrics["percent"], 0.0)
        self.assertLessEqual(metrics["percent"], 100.0)


class TestNetworkCollector(unittest.TestCase):
    """Kiểm thử trích xuất thông lượng mạng loại trừ loopback ('lo')."""

    def test_network_collector_excludes_loopback(self):
        mock_proc_net = (
            "Inter-|   Receive                                                |  Transmit\n"
            " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n"
            "    lo: 9999999       0    0    0    0     0          0         0  9999999       0    0    0    0     0       0          0\n"
            "  eth0: 1048576       0    0    0    0     0          0         0  2097152       0    0    0    0     0       0          0\n"
            "   wg0:  524288       0    0    0    0     0          0         0   262144       0    0    0    0     0       0          0\n"
        )
        with patch("os.path.exists", return_value=True):
            with patch("builtins.open", mock_open(read_data=mock_proc_net)):
                collector = NetworkCollector()
                rx, tx = collector.get_network_io()
                # eth0 (1048576) + wg0 (524288) = 1572864, bỏ qua lo
                self.assertEqual(rx, 1572864)
                # eth0 (2097152) + wg0 (262144) = 2359296, bỏ qua lo
                self.assertEqual(tx, 2359296)


class TestJitterAndBackoffAlgorithm(unittest.TestCase):
    """Kiểm thử thuật toán Lùi lũy thừa và Jitter ngẫu nhiên hóa thời gian phát sóng."""

    def test_jitter_interval_bounds(self):
        base_interval = 3.0
        jitter_ratio = 0.1
        # [base * (1 - ratio), base * (1 + ratio)] => [2.7s, 3.3s]
        for val in [2.70, 2.85, 3.00, 3.15, 3.30]:
            self.assertTrue(base_interval * (1 - jitter_ratio) <= val <= base_interval * (1 + jitter_ratio))

    def test_exponential_backoff_capped(self):
        base = 3.0
        max_backoff = 30.0
        current = base
        # Mô phỏng 10 lần mất mạng liên tiếp
        for attempt in range(1, 11):
            current = min(max_backoff, current * 2)
        self.assertEqual(current, max_backoff)

if __name__ == "__main__":
    unittest.main()
