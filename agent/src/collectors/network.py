import os

class NetworkCollector:
    """
    Bộ trích xuất thông lượng mạng tích lũy (Bytes Rx/Tx) và thời gian hoạt động (Uptime).
    LÝ DO PHI TRỰC GIÁC (RATIONALE):
    Đọc trực tiếp từ /proc/net/dev và /proc/uptime. Tự động loại trừ giao diện loopback ('lo')
    để không tính trùng lặp lưu lượng giao tiếp nội bộ giữa các tiến trình trên cùng máy.
    """

    def get_network_io(self) -> tuple[int, int]:
        rx_total = 0
        tx_total = 0
        if os.path.exists("/proc/net/dev"):
            try:
                with open("/proc/net/dev", "r", encoding="utf-8") as f:
                    lines = f.readlines()[2:]  # Bỏ qua 2 dòng header
                    for line in lines:
                        parts = line.split(":")
                        if len(parts) == 2:
                            iface = parts[0].strip()
                            if iface == "lo":
                                continue  # Bỏ qua loopback
                            data = parts[1].split()
                            rx_bytes = int(data[0])
                            tx_bytes = int(data[8])
                            rx_total += rx_bytes
                            tx_total += tx_bytes
            except Exception:
                pass
        return rx_total, tx_total

    def get_uptime_seconds(self) -> int:
        """Đọc thời gian hoạt động liên tục của máy chủ từ /proc/uptime."""
        if os.path.exists("/proc/uptime"):
            try:
                with open("/proc/uptime", "r", encoding="utf-8") as f:
                    uptime_str = f.read().split()[0]
                    return int(float(uptime_str))
            except Exception:
                pass
        return 0

    def collect(self) -> dict:
        rx_bytes, tx_bytes = self.get_network_io()
        uptime = self.get_uptime_seconds()
        return {
            "network": {
                "rx_bytes_total": rx_bytes,
                "tx_bytes_total": tx_bytes,
            },
            "uptime_seconds": uptime,
        }
