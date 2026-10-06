import json
import os
import random
import signal
import sys
import time
import urllib.error
import urllib.request

# Nạp các module trong cùng package
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from collectors.cpu import CPUCollector
from collectors.memory import MemoryCollector
from collectors.disk import DiskCollector
from collectors.network import NetworkCollector
from config import AgentConfig

running = True


def handle_shutdown(signum, frame):
    global running
    print(f"\n[DAEMON SHUTDOWN] Nhận tín hiệu {signum}. Đang dừng tiến trình an toàn...")
    running = False


signal.signal(signal.SIGINT, handle_shutdown)
signal.signal(signal.SIGTERM, handle_shutdown)


class WorkerDaemon:
    """
    Tiến trình nền (Daemon) gửi tín hiệu Telemetry Beacon về Control Plane Gateway.
    LÝ DO PHI TRỰC GIÁC (RATIONALE):
    1. Jitter (Độ trễ ngẫu nhiên +/- 10%): Triệt tiêu hiện tượng Thundering Herd. Nếu 100 node
       cùng gửi đúng chu kỳ 3.0s, Gateway sẽ hứng chịu các đợt bão I/O đột ngột (Spike). Jitter
       làm phân rã đều các điểm kết nối theo thời gian thực.
    2. Exponential Backoff: Khi Gateway mất kết nối, Daemon tự động giãn chu kỳ thử lại lên
       6s, 12s... tối đa 30s để tránh làm nghẽn CPU và mạng của máy chủ con.
    """

    def __init__(self, config: AgentConfig):
        self.config = config
        self.cpu_collector = CPUCollector()
        self.mem_collector = MemoryCollector()
        self.disk_collector = DiskCollector()
        self.net_collector = NetworkCollector()
        self.current_backoff = self.config.interval

    def build_payload(self) -> dict:
        """Thu thập chỉ số phần cứng và đóng gói theo telemetry.schema.json."""
        net_info = self.net_collector.collect()
        return {
            "node_id": self.config.node_id,
            "timestamp": int(time.time() * 1000),
            "metrics": {
                "cpu": self.cpu_collector.collect(),
                "memory": self.mem_collector.collect(),
                "disk": self.disk_collector.collect(),
                "network": net_info["network"],
                "uptime_seconds": net_info["uptime_seconds"],
            },
        }

    def dispatch_beacon(self, payload: dict) -> bool:
        """Gửi gói tin HTTP POST tới cổng Ingestion của Gateway."""
        url = f"{self.config.gateway_url}/api/telemetry"
        data = json.dumps(payload).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                "X-Node-Token": self.config.node_token,
                "User-Agent": "ZT-Worker-Daemon/1.0",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                if resp.status == 200:
                    return True
        except urllib.error.HTTPError as e:
            print(f"[DAEMON WARNING] Gateway từ chối yêu cầu (HTTP {e.code}): {e.reason}")
        except urllib.error.URLError as e:
            print(f"[DAEMON WARNING] Không thể kết nối tới Gateway tại {url}: {e.reason}")
        except Exception as e:
            print(f"[DAEMON ERROR] Lỗi truyền dữ liệu bất ngờ: {str(e)}")

        return False

    def compute_sleep_time(self, is_success: bool) -> float:
        """Tính toán thời gian ngủ có tích hợp Jitter và Backoff."""
        if is_success:
            self.current_backoff = self.config.interval
        else:
            self.current_backoff = min(self.config.max_backoff, self.current_backoff * 2)

        # Áp dụng Jitter (+/- jitter_ratio)
        jitter_delta = self.current_backoff * self.config.jitter_ratio
        jittered_time = self.current_backoff + random.uniform(-jitter_delta, jitter_delta)
        return max(1.0, round(jittered_time, 2))

    def run(self):
        print(f"🚀 [WORKER DAEMON STARTED] Node ID: {self.config.node_id} | Target: {self.config.gateway_url}")
        while running:
            payload = self.build_payload()
            success = self.dispatch_beacon(payload)

            sleep_duration = self.compute_sleep_time(success)
            status_tag = "ACK" if success else f"FAIL (Lùi lại {sleep_duration}s)"
            print(f"[{time.strftime('%X')}] Beacon {status_tag} | CPU: {payload['metrics']['cpu']['percent']}% | RAM: {payload['metrics']['memory']['percent']}%")

            # Ngủ ngắt quãng để phản ứng nhanh với SIGINT/SIGTERM
            sleep_step = 0.2
            elapsed = 0.0
            while elapsed < sleep_duration and running:
                time.sleep(sleep_step)
                elapsed += sleep_step


def main():
    config = AgentConfig()
    try:
        config.validate()
    except ValueError as e:
        print(f"❌ [CONFIG ERROR] {str(e)}")
        sys.exit(1)

    daemon = WorkerDaemon(config)
    daemon.run()


if __name__ == "__main__":
    main()
