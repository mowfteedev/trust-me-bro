# ZT-ServerOps

Giám sát máy chủ và Web SSH qua WireGuard. Fastify/TypeScript, React,
PostgreSQL và Agent Go cho Linux/Windows.

Gateway chạy Docker Compose: PostgreSQL, Gateway, Caddy và WireGuard.
Worker kết nối UDP 51820, không publish SSH. [Triển khai EC2](deploy/ec2/README.md).
Tổng quan đọc tài nguyên host Gateway qua collector chỉ đọc; trang Máy chủ
hiển thị các Worker và Web SSH.

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
