#!/usr/bin/env python3
"""
==============================================================================
KỊCH BẢN GIẢ LẬP TẢI 50 ENDPOINT HOSTS (mock-nodes.py)
Dự án: ZT-ServerOps (do-an-co-so-nganh)
Phụ trách: tester (chủ trì), devops, database
==============================================================================

LÝ DO PHI TRỰC GIÁC (RATIONALE):
Sử dụng 100% thư viện chuẩn của Python (Zero-dependency) để chạy được trên mọi môi trường
Linux mà không cần pip hay venv. Đa luồng (Multi-threading) giả lập 50 Endpoint Hosts
gửi tín hiệu đo xa đồng thời, tích hợp Jitter ngẫu nhiên để mô phỏng chính xác hành vi
thực tế của cụm máy chủ phân tán lớn phục vụ bảo vệ đồ án trước Hội đồng.
"""

import argparse
import hashlib
import json
import random
import sys
import threading
import time
import urllib.request
import urllib.error


class MockEndpointHost:
    def __init__(self, node_index: int, gateway_url: str, duration_sec: int = 10):
        self.node_id = f"mock-node-{node_index:02d}"
        self.ip_address = f"10.100.0.{10 + node_index}"
        self.gateway_url = gateway_url.rstrip("/")
        self.duration_sec = duration_sec
        # Sinh token giả lập cố định theo ID node
        self.raw_token = f"zt-secret-token-{self.node_id}-secure"
        self.token_hash = hashlib.sha256(self.raw_token.encode("utf-8")).hexdigest()

        self.rx_bytes = random.randint(1000000, 5000000)
        self.tx_bytes = random.randint(500000, 2000000)
        self.sent_count = 0
        self.success_count = 0
        self.fail_count = 0

    def generate_payload(self) -> dict:
        cpu_pct = round(random.uniform(5.0, 75.0), 2)
        load_1 = round(cpu_pct / 100.0 * 2.0, 2)
        load_5 = round(max(0.05, load_1 * 0.9), 2)
        load_15 = round(max(0.05, load_1 * 0.8), 2)

        total_mem = 8 * 1024 * 1024 * 1024  # 8GB
        used_mem = int(total_mem * (random.uniform(25.0, 80.0) / 100.0))

        total_disk = 100 * 1024 * 1024 * 1024  # 100GB
        used_disk = int(total_disk * 0.42)

        self.rx_bytes += random.randint(1024, 65536)
        self.tx_bytes += random.randint(512, 32768)

        return {
            "node_id": self.node_id,
            "timestamp": int(time.time()),
            "cpu": {
                "percent": cpu_pct,
                "load_avg": [load_1, load_5, load_15],
            },
            "memory": {
                "total_bytes": total_mem,
                "used_bytes": used_mem,
                "percent": round((used_mem / total_mem) * 100.0, 2),
            },
            "disk": {
                "total_bytes": total_disk,
                "used_bytes": used_disk,
                "percent": round((used_disk / total_disk) * 100.0, 2),
            },
            "network": {
                "rx_bytes": self.rx_bytes,
                "tx_bytes": self.tx_bytes,
            },
            "uptime_seconds": random.randint(3600, 864000),
        }

    def run(self, dry_run: bool = False):
        end_time = time.time() + self.duration_sec

        while time.time() < end_time:
            payload = self.generate_payload()
            self.sent_count += 1

            if dry_run:
                self.success_count += 1
            else:
                try:
                    data = json.dumps(payload).encode("utf-8")
                    req = urllib.request.Request(
                        f"{self.gateway_url}/api/telemetry/beacon",
                        data=data,
                        headers={
                            "Content-Type": "application/json",
                            "X-Node-Token": self.raw_token,
                            "User-Agent": f"ZT-Agent-Mock/{self.node_id}",
                        },
                        method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=3.0) as res:
                        if res.status == 200:
                            self.success_count += 1
                        else:
                            self.fail_count += 1
                except Exception:
                    self.fail_count += 1

            # Vòng lặp beacon 3s có Jitter ngẫu nhiên ±10%
            jitter = random.uniform(-0.3, 0.3)
            sleep_duration = max(0.5, 3.0 + jitter)
            time.sleep(sleep_duration)


def main():
    parser = argparse.ArgumentParser(description="Mô phỏng chịu tải 50 Endpoint Hosts ZT-ServerOps")
    parser.add_argument("--count", type=int, default=50, help="Số lượng Node giả lập (Mặc định: 50)")
    parser.add_argument("--duration", type=int, default=10, help="Thời gian giả lập tính bằng giây (Mặc định: 10s)")
    parser.add_argument("--url", type=str, default="http://localhost:3000", help="Địa chỉ Gateway")
    parser.add_argument("--dry-run", action="store_true", help="Chế độ chạy thử nghiệm kiểm tra tính toàn vẹn tải trọng")

    args = parser.parse_args()

    print("\n" + "=" * 78)
    print(f"🚀 [ZT-SERVEROPS LOAD BENCHMARK] KHỞI CHẠY MÔ PHỎNG {args.count} ENDPOINT HOSTS")
    print("=" * 78)
    print(f"  • Mục tiêu Gateway: {args.url}")
    print(f"  • Thời gian thử nghiệm: {args.duration} giây")
    print(f"  • Chế độ: {'Dry-run (Kiểm thử tải trọng)' if args.dry_run else 'Live Traffic (Gửi HTTP Beacon thật)'}")
    print("-" * 78)

    threads = []
    hosts = [MockEndpointHost(i + 1, args.url, args.duration) for i in range(args.count)]

    start_time = time.time()
    for host in hosts:
        t = threading.Thread(target=host.run, args=(args.dry_run,))
        t.daemon = True
        threads.append(t)
        t.start()

    for t in threads:
        t.join()

    elapsed = time.time() - start_time
    total_sent = sum(h.sent_count for h in hosts)
    total_success = sum(h.success_count for h in hosts)
    total_fail = sum(h.fail_count for h in hosts)

    rps = total_sent / max(0.001, elapsed)

    print("\n" + "=" * 78)
    print("📊 BÁO CÁO THỐNG KÊ KẾT QUẢ CHỊU TẢI (STRESS TEST REPORT)")
    print("=" * 78)
    print(f"  ✔ Tổng số yêu cầu beacon đã phát: {total_sent}")
    print(f"  ✔ Yêu cầu thành công: {total_success} ({round(total_success / max(1, total_sent) * 100, 1)}%)")
    print(f"  ✖ Yêu cầu thất bại: {total_fail}")
    print(f"  ⏱️  Tổng thời gian: {elapsed:.2f} giây")
    print(f"  ⚡ Tốc độ xử lý trung bình: {rps:.2f} Beacons/giây")
    print("=" * 78 + "\n")


if __name__ == "__main__":
    main()
