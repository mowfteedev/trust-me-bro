import os

class AgentConfig:
    """
    Quản trị nạp cấu hình hệ thống từ biến môi trường cho Worker Daemon.
    """

    def __init__(self):
        # Địa chỉ URL trạm điều khiển Gateway
        self.gateway_url = os.getenv("GATEWAY_URL", "http://10.100.0.1:3000").rstrip("/")
        # Định danh của máy chủ Worker Node
        self.node_id = os.getenv("NODE_ID", "node-worker-01")
        # Khóa bí mật Pre-shared Token dùng để xác thực Telemetry Beacon (bắt buộc)
        self.node_token = os.getenv("NODE_TOKEN", "").strip()
        # Chu kỳ gửi tín hiệu Liveness mặc định (3 giây)
        self.interval = float(os.getenv("BEACON_INTERVAL_SECONDS", "3.0"))
        # Ngưỡng lùi lũy thừa tối đa khi mất mạng (giây)
        self.max_backoff = float(os.getenv("MAX_BACKOFF_SECONDS", "30.0"))
        # Hệ số ngẫu nhiên hóa thời gian ngủ (Jitter ratio)
        self.jitter_ratio = float(os.getenv("JITTER_RATIO", "0.1"))

    def validate(self):
        if not self.gateway_url.startswith(("http://", "https://")):
            raise ValueError(f"GATEWAY_URL không hợp lệ: {self.gateway_url}")
        if not self.node_id or len(self.node_id) < 3:
            raise ValueError(f"NODE_ID quá ngắn hoặc rỗng: {self.node_id}")
        if not self.node_token:
            raise ValueError("LỖI BẢO MẬT: NODE_TOKEN không được để trống! Vui lòng cấu hình biến môi trường NODE_TOKEN.")
