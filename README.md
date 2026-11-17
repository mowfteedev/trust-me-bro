# ZT-ServerOps

Giám sát máy chủ và Web SSH qua WireGuard. Fastify/TypeScript, React,
PostgreSQL và Agent Go cho Linux/Windows.

[Bộ cài Gateway/Worker tự động](deploy/automation/README.md): preflight,
mã ghép một lần và kiểm VPN/heartbeat/SSH; Admin mới chỉ lưu hash mật khẩu.

Gateway chạy Docker Compose: PostgreSQL, Gateway, Caddy và WireGuard.
Worker kết nối UDP 51820, không publish SSH. [Triển khai EC2](deploy/ec2/README.md).
Tổng quan đọc tài nguyên host Gateway qua collector chỉ đọc; trang Máy chủ
hiển thị các Worker và Web SSH.

Nhật ký và Sự cố xuất Excel `.xlsx` theo bộ lọc cho Admin/Viewer;
tối đa 10.000 dòng mỗi tệp. Chức năng dọn nhật ký cũ đã bỏ, dữ liệu được giữ nguyên.

Admin quản lý tài khoản; Viewer đọc giám sát, sự cố và nhật ký. Trang Sự cố
hiển thị kết quả gửi Telegram và phục hồi. Đăng xuất thường đóng phiên hiện
tại; trang Tài khoản có đổi mật khẩu và thu hồi tất cả thiết bị.

## Truy cập EC2

```sh
ssh -i ~/.ssh/aws-key.pem -N -L 127.0.0.1:19443:127.0.0.1:8443 admin@EC2_PUBLIC_IP
```

Mở **https://localhost:19443**. Chấp nhận CA demo hoặc cài CA tin cậy.

## Demo cục bộ

Cần Linux, Docker Compose, WireGuard và Python 3.9+.

```sh
python3 deploy/scripts/demo.py up
python3 deploy/scripts/demo.py doctor
make test
make e2e
make down
```

Demo mở tại **https://localhost**; tài khoản trong `keys/demo-login.env`.
`make e2e` thu hồi phiên tài khoản demo. Telegram mặc định dry-run;
live cần token và ghép nối chat. Giữ khóa, env và database ngoài Git.

[Bộ cài native](deploy/native/README.md) · [Khôi phục TV box](deploy/RECOVERY.md)

[Thêm Worker](deploy/HD-THEM-MAY-CHU.md) · [Backup và cập nhật](docs/OPERATIONS.md) ·
[Kiểm chứng](docs/ACCEPTANCE.md) · [Kế hoạch](docs/IMPROVEMENT-PLAN.md)
[Kết quả cải thiện](docs/RENOVATION-RESULTS.md)

Bản source hiện tại cần migration **012–015** sau 011. Sao lưu trước khi cập nhật;
chạy migrator/provisioner đúng image rồi tạo lại Gateway cùng helper WireGuard.
Thông báo được lưu trong PostgreSQL, tối đa ba lần thử; Telegram có thể nhận
trùng nếu kết nối mất sau khi đã tiếp nhận tin.
