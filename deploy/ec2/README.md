# Gateway Compose trên máy Linux có IP public

Cụm chạy bốn service thường trực: PostgreSQL, Gateway Fastify, Caddy phục vụ
React và helper WireGuard. `migrator`/`provisioner` chạy xong rồi thoát;
`maintenance` chỉ chạy khi được gọi. Worker nằm ở máy khác.

## Chuẩn bị và build trên máy phát triển

Tạo bản checkout riêng và bộ khóa mới cho Gateway mới. Lệnh init giữ nguyên
khóa và env đã có; nó không chuyển danh tính từ bản TV box.

```sh
bash deploy/scripts/init-secrets.sh --env-file keys/ec2.env --endpoint EC2_PUBLIC_IP:51820
```

Trong `keys/ec2.env` (0600), đặt `HTTPS_PORT=8443`, `HTTP_PORT=8080`,
`PROXY_BIND_IP=127.0.0.1`, `WG_HOST_PORT=51820` và ba image tag riêng:
`ZT_GATEWAY_IMAGE`, `ZT_PROXY_IMAGE`, `ZT_WIREGUARD_IMAGE`. Giữ Telegram
`dry-run` trong lúc kiểm bản build. Không đưa env hoặc keys vào Git/image.

```sh
docker compose --env-file keys/ec2.env -p zt_ec2 build gateway proxy wireguard_gateway
docker compose --env-file keys/ec2.env -p zt_ec2 pull postgres
```

Xuất đúng bốn image runtime bằng `docker save`, chuyển riêng image archive và
source/config cần thiết qua SSH rồi `docker load` trên EC2. Không cần build
TypeScript/React trên máy 1 GB. Chuyển khóa/env qua kênh riêng, bảo toàn quyền:
thư mục keys 0700, env/config 0600, Bastion private key 0400; Gateway UID1000
phải đọc được key bind-mount. Giữ riêng `keys/demo-login.env` (0600).

## Khởi động trên EC2

Docker/Compose, kernel WireGuard và UDP51820 từ Internet phải sẵn sàng.
Giữ đường SSH quản trị đang dùng. Trong thư mục source/config trên EC2:

```sh
python3 deploy/scripts/demo.py up --project zt_ec2 --env-file keys/ec2.env --core-only --no-build
```

`--core-only` chỉ chạy Gateway, đồng thời tạo hai tài khoản demo và đăng ký
danh tính Worker `.2` đã chuẩn bị; nó không chạy Worker trên EC2.
`--no-build` yêu cầu các image runtime đã được load/pull đúng tag.

Mở tunnel từ máy người dùng (thay host và key bằng thông tin thực tế):

```sh
ssh -i ~/.ssh/aws-key.pem -o ExitOnForwardFailure=yes -N -L 127.0.0.1:19443:127.0.0.1:8443 admin@EC2_PUBLIC_IP
```

Truy cập `https://localhost:19443`; dùng CA demo nội bộ. API trong WireGuard
vẫn là `http://10.100.0.1:3000`, khác API3100 của bản native TV box.
PostgreSQL và API không publish ra IP public.

## Worker, Telegram và kiểm chứng

Worker phải nhận đúng bundle của Gateway này; không trộn khóa/token với TV box.
Với fixture Docker `.2`, chuyển riêng `wg0-node.conf`, Bastion public key,
SSH host key và token đã chuẩn bị; endpoint là IP public EC2, không phải
hostname nội bộ Docker `gateway`. Worker không publish SSH ra Internet.

Đăng ký VM mới bằng `deploy/scripts/register-node.py` với trusted SSH host
PUBLIC key lấy từ console/kênh tin cậy. Agent dùng API3000 và interface đúng
bundle. Worker Windows/Linux mới vẫn cần cài Agent/SSH/firewall theo hướng dẫn.

Telegram dùng token riêng trong env và chat đã ghép OTP. Nếu khôi phục cấu hình,
chỉ khôi phục đúng chat đã ghép với bot tương ứng; không tự nhận chat đầu tiên.
Đổi env của Gateway có thể tạo lại network namespace: khi áp dụng, tạo lại cả
`gateway` và `wireguard_gateway` để helper theo đúng namespace mới.

Sau khi có Worker thật, chạy doctor, kiểm Dashboard/SSH/RBAC/logout/audit,
mất heartbeat và cảnh báo Telegram. Đo RAM cả container, Docker/containerd
và Agent; ghi riêng RAM OS/hypervisor. Các unit/source tests không thay cho
WireGuard handshake và kiểm luồng ứng dụng qua Internet thật.

Gọi tác vụ giữ lịch sử bảy ngày khi cần:

```sh
python3 deploy/scripts/demo.py maintenance --project zt_ec2 --env-file keys/ec2.env --no-build
```

Lệnh bảo trì dùng image Gateway đã có. Không xóa volume hoặc đổi khóa để sửa lỗi.

## Cập nhật schema cảnh báo từ migration 009

Migration `010_normalize_alert_resolution.sql` bỏ cột dẫn xuất `alerts.resolved`;
`resolved_at IS NULL` là sự cố đang mở. Phải dừng Gateway cũ trước khi chạy
migrator bằng image mới, sau đó tạo lại cả Gateway và helper WireGuard. Không
chạy image cũ với schema mới. Sao lưu DB và thử khôi phục trước khi cập nhật;
migration sẽ dừng nếu cờ cũ không khớp timestamp, không tự sửa dữ liệu xung đột.

Nếu cần quay lại image cũ, dừng Gateway mới, chạy
`deploy/db/rollback-010-normalize-alert-resolution.sql` bằng DB owner với
`psql -v ON_ERROR_STOP=1`, rồi dùng lại image cũ và tạo lại hai container.
Script dựng lại cờ từ timestamp, giữ cả sự cố mới phát sinh sau migration.

Agent giữ nhịp gửi thành công theo mốc thời gian 3 giây, trừ thời gian chờ ACK;
khi quá hạn sẽ bỏ nhịp đã lỡ, không gửi dồn hoặc chồng request. Khi lỗi vẫn dùng
backoff. Ngân sách Go mặc định Linux là 4.5 MiB, không phải giới hạn RSS;
phải đo RSS trên Worker thật. Worker Docker chặn INPUT/FORWARD/OUTPUT cả IPv4
và IPv6 trước khi chạy WireGuard/SSH/Agent; chỉ IPv4 có các ngoại lệ VPN đã khai báo.
