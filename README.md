# Đồ Án Cơ Sở Ngành — ZT-ServerOps

Hệ thống quản trị và giám sát máy chủ phân tán bảo vệ theo kiến trúc Zero-Trust (Zero Inbound Ports) trên mạng ngầm WireGuard.
Giải pháp phân tầng độc lập giữa Mặt phẳng Điều khiển (Fastify/TypeScript Control Plane) và Mặt phẳng Dữ liệu (Python POSIX Daemon).

---

## Cấu Trúc Cây Thư Mục Dự Án

```text
do-an-co-so-nganh/
├── .env.example                          # Định nghĩa cấu hình môi trường chuẩn hóa
├── .gitignore                            # Triệt tiêu rò rỉ: Loại trừ keys/, logs/, node_modules/, *.key
├── docker-compose.yml                    # Điều phối cụm: Gateway, PostgreSQL, Reverse Proxy, Worker Nodes
├── Makefile                              # Tự động hóa tác vụ: up, test, lint, seed, mock
├── README.md                             # Tài liệu tổng quan và kiến trúc dự án
│
├── contracts/                            # Đặc tả giao thức và lược đồ dữ liệu chuẩn hóa (Single Source of Truth)
│   ├── telemetry.schema.json             # JSON Schema chuẩn hóa tải trọng Telemetry Ingestion
│   └── openapi.yaml                      # Đặc tả RESTful API theo chuẩn OpenAPI 3.0
│
├── deploy/                               # Hạ tầng vận hành và mạng truyền dẫn (Infrastructure & Underlay)
│   ├── proxy/
│   │   └── Caddyfile                     # Cấu hình Reverse Proxy biên, tự động quản lý TLS/ACME
│   ├── wireguard/
│   │   ├── wg0-gateway.conf              # Cấu hình giao diện mạng ngầm tại Control Plane
│   │   └── wg0-node.conf                 # Cấu hình mẫu mạng ngầm cho Endpoint Host
│   └── scripts/
│       ├── init-secrets.sh               # Khởi tạo khóa bất đối xứng Ed25519 & Curve25519 tại runtime
│       ├── seed-db.sh                    # Khởi tạo dữ liệu quản trị viên và đăng ký Node ban đầu
│       └── mock-nodes.py                 # Kịch bản giả lập tải đồng thời từ 20 đến 50 Endpoint Hosts
│
├── gateway/                              # Mặt phẳng điều khiển trung tâm (Control Plane Engine)
│   ├── package.json
│   ├── tsconfig.json
│   ├── migrations/                       # Quản lý phiên bản lược đồ CSDL PostgreSQL v3.1
│   │   ├── 001_init_schema.sql           # Khởi tạo bảng danh mục và phân quyền người dùng
│   │   └── 002_partition_metrics.sql     # Thiết lập phân vùng Range Partitioning cho Telemetry
│   ├── tests/                            # Kiểm thử đơn vị cho nền tảng Control Plane (Vitest)
│   │   ├── token-verify.test.ts          # Thẩm định tính bất biến thời gian của thuật toán so sánh chuỗi
│   │   └── pty-resize.test.ts            # Kiểm thử tính toàn vẹn và kẹp biên tham số PTY SIGWINCH
│   └── src/
│       ├── server.ts                     # Điểm nhập ứng dụng Fastify, nạp Middleware và Plugins
│       ├── config/env.ts                 # Rà soát ràng buộc tham số môi trường bằng Zod Schema
│       ├── routes/                       # Các bộ định tuyến REST Endpoints
│       │   ├── auth.ts                   # Xác thực định danh và cấp phát JSON Web Token (JWT)
│       │   ├── nodes.ts                  # Quản lý vòng đời và trạng thái vận hành của Worker Nodes
│       │   └── telemetry.ts              # Tiếp nhận và xác thực tải trọng Telemetry Beacon (O(1) Lookup)
│       ├── services/                     # Khối xử lý logic nghiệp vụ cốt lõi
│       │   ├── bastion.ts                # Bộ điều phối phiên dòng lệnh giả lập (PTY Bridge over WebSocket)
│       │   ├── sweeper.ts                # Dịch vụ kiểm soát trạng thái Liveness và thanh lọc Dead Tuples
│       │   ├── telegram.ts               # Dịch vụ phát tán cảnh báo On-Call tích hợp xác thực OTP
│       │   └── db.ts                     # Quản lý Connection Pool đến cơ sở dữ liệu PostgreSQL
│       └── middlewares/                  # Bộ lọc an ninh và phân quyền
│           ├── auth.middleware.ts        # Kiểm soát truy cập dựa trên vai trò (RBAC)
│           └── rate-limit.ts             # Cơ chế kiểm soát lưu lượng chống cạn kiệt tài nguyên
│
├── agent/                                # Mặt phẳng dữ liệu cục bộ (Endpoint Worker Daemon)
│   ├── requirements.txt
│   ├── install.sh                        # Kịch bản thiết lập Systemd Unit tự động trên Linux Host
│   ├── Dockerfile                        # Đóng gói Distroless/Alpine tối ưu kích thước
│   ├── tests/                            # Kiểm thử đơn vị cho module trích xuất tài nguyên (Pytest)
│   │   └── test_collectors.py
│   └── src/
│       ├── main.py                       # Vòng lặp phát tín hiệu Liveness Beacon tích hợp Jitter
│       ├── config.py                     # Quản lý nạp cấu hình hệ thống
│       └── collectors/                   # Module trích xuất chỉ số tài nguyên hạt nhân (Kernel Metrics)
│           ├── cpu.py                    # Phân tích trạng thái tải vi xử lý qua /proc/stat
│           ├── memory.py                 # Đo lường phân bổ bộ nhớ vật lý qua /proc/meminfo
│           ├── disk.py                   # Giám sát dung lượng phân vùng lưu trữ
│           └── network.py                # Đo lường thông lượng I/O giao diện mạng
│
├── dashboard/                            # Bảng điều khiển quản trị tập trung (Web Console Interface)
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── App.tsx                       # Cấu trúc định tuyến Single Page Application
│       ├── components/                   # Khối giao diện hiển thị tái sử dụng
│       │   ├── NodeCard.tsx              # Thẻ hiển thị trạng thái Liveness và thông số tóm tắt
│       │   ├── MetricsChart.tsx          # Biểu đồ diễn biến tài nguyên thời gian thực
│       │   └── TerminalModal.tsx         # Khung nhúng PTY tương tác dòng lệnh tích hợp xterm.js
│       └── services/                     # Lớp giao thức kết nối phía Client
│           ├── api.ts                    # Tương tác RESTful Client
│           └── terminalSocket.ts         # Điều phối luồng dữ liệu nhị phân hai chiều qua WebSocket
│
└── tests/                                # Kiểm thử tổng hợp hệ thống
    └── e2e/
        └── smoke-test.sh                 # Kịch bản kiểm thử luồng tích hợp tự động toàn diện
```
