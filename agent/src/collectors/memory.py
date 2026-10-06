import os

class MemoryCollector:
    """
    Bộ trích xuất chỉ số bộ nhớ vật lý (RAM) từ /proc/meminfo.
    LÝ DO PHI TRỰC GIÁC (RATIONALE):
    Sử dụng MemAvailable thay vì MemFree. Nhân Linux luôn tận dụng RAM nhàn rỗi làm
    Page Cache và Buffer. Đo lường theo MemAvailable phản ánh chính xác lượng RAM thực sự
    sẵn sàng cung cấp cho tiến trình mới mà không gây hoang mang cảnh báo ảo.
    """

    def collect(self) -> dict:
        mem_info = {}
        if os.path.exists("/proc/meminfo"):
            try:
                with open("/proc/meminfo", "r", encoding="utf-8") as f:
                    for line in f:
                        parts = line.split(":")
                        if len(parts) == 2:
                            key = parts[0].strip()
                            val_str = parts[1].strip().split()[0]
                            mem_info[key] = int(val_str) * 1024  # Quy đổi từ kB sang Bytes
            except Exception:
                pass

        total_bytes = mem_info.get("MemTotal", 1024 * 1024 * 1024)
        if "MemAvailable" in mem_info:
            available_bytes = mem_info["MemAvailable"]
        else:
            free = mem_info.get("MemFree", 0)
            buffers = mem_info.get("Buffers", 0)
            cached = mem_info.get("Cached", 0)
            available_bytes = free + buffers + cached

        used_bytes = max(0, total_bytes - available_bytes)
        percent = round((used_bytes / total_bytes) * 100.0, 2) if total_bytes > 0 else 0.0

        return {
            "total_bytes": total_bytes,
            "used_bytes": used_bytes,
            "percent": max(0.0, min(100.0, percent)),
        }
