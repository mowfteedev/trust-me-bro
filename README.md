# 🛡️ ZT-ServerOps (Zero-Trust Server Operations Platform)

> **Hệ thống quản trị máy chủ không mở cổng dịch vụ (Zero Inbound Ports) qua mạng ngầm WireGuard theo chuẩn Zero Trust NIST SP 800-207.**

Dự án xây dựng giải pháp thu hẹp bề mặt tấn công của toàn bộ máy chủ con về trạng thái **Zero Inbound Ports** (đóng 100% cổng kết nối từ Internet), quản trị tập trung qua **Web Console & Web SSH Bastion** trên mạng ngầm WireGuard với ngõ vào bảo vệ bằng cơ chế *Silent Drop*.

---

## 🧭 Điều Hướng Tài Liệu (Documentation Map)

Để nắm bắt và thẩm định dự án theo từng mức độ chi tiết, vui lòng xem các tài liệu chuyên sâu:

| Tài liệu | Thời gian đọc | Đối tượng & Nội dung chính |
| :--- | :---: | :--- |
| 📑 **[tongquan.md](tongquan.md)** | ~2 phút | **Tóm tắt nhanh:** Bảng thông số định lượng RAM/CPU/DB, 3 tính năng cốt lõi, cây thư mục mã nguồn và đoạn mô tả ngắn nộp đề tài. |
| 🏛️ **[tailieu.md](tailieu.md)** | ~10 phút | **Đặc tả kiến trúc kỹ thuật toàn diện (v1.1):** Ánh xạ Zero Trust NIST SP 800-207, sơ đồ tuần tự Web SSH, cơ sở dữ liệu 3NF (Rolling Window 60 điểm), cơ chế phân đoạn mạng iptables chống lan ngang và Cheat Sheet phản biện. |

---

## ⚡ Khởi Chạy Nhanh (1-Click Run)

Toàn bộ cụm thử nghiệm (1 Gateway + 2 Node con + 1 DB + 1 Web Console) được khởi tạo bằng 1 câu lệnh duy nhất:

```bash
docker compose up -d
```
> Truy cập Web Console tại: `http://localhost:3000`

---

## 👥 Thông Tin Đồ Án
* **Đơn vị thực hiện:** Nhóm 9 — Đồ án Cơ sở ngành (GVHD: Thầy Nguyễn Đắc Hải).
* **Mã nguồn:** `trust-me-bro` (Phiên bản kiến trúc MVP tinh gọn).
