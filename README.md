# ZT-ServerOps

Đồ án cơ sở ngành Nhóm 9: giám sát và quản trị máy chủ qua WireGuard.

- Dashboard CPU, RAM, disk, network, uptime và trạng thái kết nối.
- Web SSH phân quyền ADMIN/VIEWER, khóa Ed25519 và nhật ký hoạt động.
- Cảnh báo CPU ≥85% (phục hồi <75%) và mất kết nối qua Telegram.
- Fastify/TypeScript · React · PostgreSQL · Go Agent cho Linux/Windows.

## Chạy demo

Gateway cần Linux hỗ trợ WireGuard, Docker Compose v2, Python 3.9+, OpenSSL
và `ssh-keygen`. Khóa bind-mount cần cho container UID1000 đọc được.

```sh
python3 deploy/scripts/demo.py up
python3 deploy/scripts/demo.py doctor
```

Mở **https://localhost**, chấp nhận chứng chỉ demo.
Tài khoản `demo-admin` / `demo-viewer`; mật khẩu trong `keys/demo-login.env`.
Khóa và cấu hình được tạo tự động, không đưa vào Git.

```sh
make test    # Unit tests; DB/HTTP của Gateway dùng mock
make e2e     # API/SSH thật; thu hồi phiên tài khoản demo
make maintenance # Dọn metrics quá 7 ngày, chạy thủ công
make down    # Dừng demo, giữ dữ liệu
```

Đã kiểm chứng Docker, Debian12 và Windows Server2022. Agent Windows khoảng
13MiB RAM; số dịch vụ ứng dụng không gồm RAM hệ điều hành VM.
Kiểm thử từ Internet độc lập **chưa thực hiện**. Telegram mặc định `dry-run`;
chế độ `live` cần token và ghép nối chat.
