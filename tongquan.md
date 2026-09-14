# 📑 TỔNG QUAN DỰ ÁN: ZT-SERVEROPS
> **Tên đề tài chính thức trên Sheet:** Thiết lập máy chủ VPN sử dụng WireGuard để quản lý máy chủ  
> **Tên khoa học chính thức:** Hệ thống quản trị máy chủ không mở cổng dịch vụ (Zero Inbound Ports) qua mạng ngầm WireGuard  
> **Mã sản phẩm:** `ZT-ServerOps` (Zero-Trust Server Operations Platform)  
> **Đơn vị thực hiện:** Nhóm 9 — Đồ án Cơ sở ngành (GVHD: Thầy Nguyễn Đắc Hải)  
> **Thời gian đọc:** ~2 phút để nắm trọn vẹn toàn bộ dự án

---

## 1. DỰ ÁN NÀY LÀ GÌ? (TÓM TẮT TRONG 3 CÂU)
1. **Xuất phát điểm:** Đề tài gốc của trường giao là dựng VPN WireGuard để quản lý máy chủ.
2. **Nâng cấp thành sản phẩm:** Nhóm nâng cấp WireGuard thành **Lớp mạng ngầm bảo mật (Security Underlay)** và phát triển **Nền tảng Quản trị & Giám sát Tập trung** trên giao diện Web Console.
3. **Giá trị cốt lõi:** Kỹ sư có thể mở **Web Terminal gõ lệnh SSH trực tiếp trên trình duyệt web** mà các máy chủ con **đóng 100% cổng kết nối (Zero Inbound Ports) ra Internet**. Toàn bộ bề mặt tấn công được thu hẹp về một điểm ngõ vào duy nhất có kiểm soát (**Single Controlled Ingress Point**) tại Gateway qua WireGuard với cơ chế tàng hình tự nhiên *Silent Drop*.

---

## 2. BẢNG THÔNG SỐ ĐỊNH LƯỢNG HỆ THỐNG (METRICS AT A GLANCE)

| Tiêu chí kỹ thuật | Thông số đo kiểm thực tế | Ý nghĩa thực tiễn |
| :--- | :---: | :--- |
| **Công nghệ Backend** | **Node.js + TypeScript + Fastify** | RAM siêu nhẹ (~40MB), hiệu năng socket cao gấp 2 lần Express. |
| **Tổng mức tiêu thụ RAM toàn hệ thống** | **< 500 MB** *(Toàn bộ cụm Docker)* | Chạy mượt mà trên laptop cá nhân, không bị đơ lag khi demo. |
| **Mức tiêu thụ RAM của Mini-Agent** | **~5 MB RAM** / Máy con | Nhẹ hơn gấp 300 lần so với Zabbix Agent hoặc Prometheus. |
| **Dung lượng Cơ sở dữ liệu** | **< 5 MB** *(Rolling Window 20 điểm/node)* | Dữ liệu tự xoay vòng dọn dẹp, không bao giờ lo phình đĩa. |
| **Cổng dịch vụ mở ra Internet** | **Đúng 1 cổng duy nhất (UDP 51820)** | Tận dụng cơ chế Silent Drop tự nhiên của WireGuard chống nmap. |
| **Thời gian triển khai toàn hệ thống** | **1 câu lệnh (`docker compose up`)** | Khởi tạo trọn gói 1 Gateway + 2 Node con + 1 DB + 1 Web Console. |

---

## 3. BA (3) TÍNH NĂNG CỐT LÕI CỦA HỆ THỐNG

```mermaid
flowchart LR
    A["🛡️ 1. MẠNG ZERO TRUST\nMáy con đóng 100% Inbound Internet (Keepalive = 25s).\nGateway thu hẹp ngõ vào duy nhất UDP 51820 (Silent Drop tự nhiên)."] 
    --> B["💻 2. WEB TERMINAL SSH\nMở terminal SSH trực tiếp trên Web (xterm.js).\nBảo mật qua Application-layer WSS Handshake, phân quyền RBAC."]
    --> C["📊 3. GIÁM SÁT & BÁO ĐỘNG\nMini-Agent 30 dòng đọc CPU/RAM gửi qua VPN (Defense-in-Depth 2 lớp).\nWeb có biểu đồ sóng 20 điểm/node, quá tải 90% là rung chuông Telegram."]
```

1. **Mạng Riêng Ẩn Danh (Zero Trust Network - Chuẩn NIST 800-207):** Các máy chủ con đạt trạng thái **Zero Inbound Ports** (hoàn toàn vô hình trước công cụ quét cổng `nmap` từ Internet). Giữ thông kết nối NAT bằng `PersistentKeepalive = 25`. Gateway kiểm soát tập trung và tàng hình trước các cuộc dò quét.
2. **Web Terminal Thao Tác Trực Tiếp (Web SSH Bastion):** Kỹ sư chỉ cần mở trình duyệt, đăng nhập là có ngay màn hình đen dòng lệnh `xterm.js` để điều khiển máy chủ. Kết nối được bảo vệ bằng cơ chế **Application-layer Handshake** và **Pin Host Key** chống tấn công MitM. Phân quyền RBAC tại Middleware: `Admin` vào được mọi máy, `Developer` bị chặn vào máy Database (`403 Forbidden`).
3. **Giám Sát Siêu Nhẹ & Báo Động Telegram:** Mini-Agent chỉ tốn 5MB RAM đọc chỉ số CPU/RAM gửi về Gateway mỗi 5 giây qua mô hình phòng thủ 2 lớp (IP Whitelist + Token, Rate Limit theo từng IP nguồn). Web Console hiển thị biểu đồ sóng trực quan (Rolling Window 20 điểm trên từng node). Khi máy chủ quá tải hoặc mất kết nối quá 15 giây, Bot Telegram tự động gửi tin nhắn báo động rung chuông điện thoại.

---

## 4. CẤU TRÚC MÃ NGUỒN DỰ ÁN (PROJECT DIRECTORY TREE)

```text
do-an-co-so-nganh/
├── docker-compose.yml       # 1 lệnh duy nhất khởi chạy toàn bộ cụm thử nghiệm
├── tailieu.md               # Bản đặc tả kỹ thuật chi tiết toàn diện
├── tongquan.md              # File này (bản tóm tắt giới thiệu nhanh)
│
├── gateway/                 # Mạng ngầm WireGuard Hub (IP nội bộ: 10.8.0.1)
│   └── wg0.conf             # File cấu hình mạng tĩnh nội bộ
│
├── backend/                 # Máy chủ xử lý trung tâm (Fastify + TypeScript + Web SSH)
│   ├── src/                 # Auth JWT, Cầu nối Terminal WSS, Ingestion CPU/RAM, Bot Telegram
│   └── schema.sql           # Cơ sở dữ liệu 4 bảng: users, nodes, metrics_history, access_logs
│
├── frontend/                # Giao diện Web Console (React / Tailwind)
│   └── src/                 # Dashboard 1 trang: Thẻ máy chủ, Biểu đồ sóng, Modal Terminal, Bảng Log
│
├── agent/                   # Mini Telemetry Agent chạy ngầm trên máy con
│   ├── agent.py             # Script 30 dòng đọc thông số CPU/RAM từ Kernel
│   └── agent.env            # File chứa Secret Token (phân quyền chmod 600)
│
└── simulation/              # Kịch bản Demo thực nghiệm trước hội đồng
    ├── stress.sh            # Script bơm tải CPU 100% để kích nổ chuông Telegram
    └── demo-backup.mp4      # Video quay sẵn dự phòng đề phòng mất mạng tại hội trường
```

---

## 5. ĐOẠN ĐIỀN CỘT H (MÔ TẢ TÓM TẮT TRÊN GOOGLE SHEET CỦA LỚP)

> **Mô tả đề xuất để Nhóm 9 điền vào Cột H (Bảng Thầy Hải):**  
> *"Nghiên cứu và xây dựng nền tảng quản trị máy chủ tập trung (Web Console & Web SSH) dựa trên mạng ngầm WireGuard theo mô hình Zero Trust. Hệ thống thu hẹp bề mặt tấn công với cơ chế Zero Inbound Ports trên máy chủ con và bảo mật ngõ vào Gateway. Tích hợp Mini-Agent siêu nhẹ tự động thu thập chỉ số hiệu năng (CPU/RAM) hiển thị thời gian thực và kích hoạt cảnh báo chủ động qua Telegram Bot khi có sự cố."*

---

> 📖 **Xem toàn bộ chi tiết kỹ thuật chuyên sâu, sơ đồ Sequence chi tiết và Cheat Sheet phản biện tại:** [tailieu.md](file:///home/mowftee/Projects/do-an-co-so-nganh/tailieu.md)
