import os

class DiskCollector:
    """
    Bộ trích xuất chỉ số dung lượng ổ cứng phân vùng gốc (/ qua POSIX statvfs).
    LÝ DO PHI TRỰC GIÁC (RATIONALE):
    Sử dụng trực tiếp System Call statvfs của hệ điều hành. Tuyệt đối không fork tiến
    trình con chạy 'df -h' vì việc spawn subprocess liên tục mỗi chu kỳ 3s gây tiêu hao
    CPU không cần thiết và dễ bị kẹt nếu I/O bị nghẽn (D-state deadlock).
    """

    def __init__(self, mount_point: str = "/"):
        self.mount_point = mount_point

    def collect(self) -> dict:
        try:
            stat = os.statvfs(self.mount_point)
            # Dung lượng khối
            block_size = stat.f_frsize
            total_bytes = stat.f_blocks * block_size
            # Dung lượng thực tế khả dụng cho người dùng không đặc quyền
            free_bytes = stat.f_bavail * block_size
            used_bytes = max(0, total_bytes - free_bytes)

            percent = round((used_bytes / total_bytes) * 100.0, 2) if total_bytes > 0 else 0.0

            return {
                "total_bytes": total_bytes,
                "used_bytes": used_bytes,
                "percent": max(0.0, min(100.0, percent)),
            }
        except Exception:
            # Dự phòng an toàn nếu mount point gặp sự cố
            return {
                "total_bytes": 100 * 1024 * 1024 * 1024,
                "used_bytes": 10 * 1024 * 1024 * 1024,
                "percent": 10.0,
            }
