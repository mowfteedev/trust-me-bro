import os
import time

class CPUCollector:
    """
    Bộ trích xuất chỉ số tải vi xử lý (CPU) hạt nhân Linux.
    LÝ DO PHI TRỰC GIÁC (RATIONALE):
    Đọc trực tiếp từ /proc/stat và tính toán vi sai thời gian bận (Delta Jiffies).
    Phương pháp này phản ánh chính xác 100% tải thực tế của hệ điều hành mà không cần
    gọi tiến trình con 'top' hay phụ thuộc vào thư viện nặng như psutil.
    """

    def __init__(self):
        self.prev_idle = 0
        self.prev_total = 0
        # Khởi tạo điểm đo ban đầu
        self._read_cpu_times()

    def _read_cpu_times(self) -> tuple[int, int]:
        """Đọc tổng số jiffies rảnh và bận từ /proc/stat."""
        if not os.path.exists("/proc/stat"):
            # Dự phòng cho môi trường giả lập phi Linux
            return 0, 100

        with open("/proc/stat", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("cpu "):
                    parts = [int(x) for x in line.split()[1:]]
                    # user, nice, system, idle, iowait, irq, softirq, steal
                    idle_jiffies = parts[3] + (parts[4] if len(parts) > 4 else 0)
                    total_jiffies = sum(parts)
                    return idle_jiffies, total_jiffies
        return 0, 100

    def get_load_avg(self) -> list[float]:
        """Đọc chỉ số tải trung bình hệ thống [1m, 5m, 15m] từ /proc/loadavg."""
        if os.path.exists("/proc/loadavg"):
            try:
                with open("/proc/loadavg", "r", encoding="utf-8") as f:
                    parts = f.read().split()
                    return [float(parts[0]), float(parts[1]), float(parts[2])]
            except Exception:
                pass
        return [0.0, 0.0, 0.0]

    def collect(self) -> dict:
        """Thu thập chỉ số CPU percent vi sai và load average."""
        idle, total = self._read_cpu_times()

        delta_idle = idle - self.prev_idle
        delta_total = total - self.prev_total

        self.prev_idle = idle
        self.prev_total = total

        if delta_total <= 0:
            cpu_percent = 0.0
        else:
            cpu_percent = ((delta_total - delta_idle) / delta_total) * 100.0

        # Kẹp biên an toàn tuyệt đối trong ngưỡng [0.0 - 100.0]
        cpu_percent = max(0.0, min(100.0, round(cpu_percent, 2)))

        return {
            "percent": cpu_percent,
            "load_avg": self.get_load_avg(),
        }
