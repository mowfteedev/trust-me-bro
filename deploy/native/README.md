# Gateway native Debian 12 ARM64

Gateway chạy bằng systemd với Node.js, PostgreSQL, Caddy và WireGuard; Dashboard React đã build. Cách khôi phục laptop và Worker nằm trong [RECOVERY.md](../RECOVERY.md).

Git giữ mã installer, helper, template, unit test và `runtime-lock.json`. Thư mục `app/`, runtime ARM64, dependency và manifest của gói được phát hành dưới dạng **Release asset**, không nằm trong Git. Vì vậy không chạy `deploy/native/install.sh` trực tiếp từ một bản clone chỉ có source; dùng `install.sh` trong gói đã giải nén.

## Lấy đúng gói đã bàn giao

Trên máy có GitHub CLI (`gh`), đăng nhập bằng tài khoản có quyền đọc repo nếu cần:

```sh
gh auth login
```

Tải vào một thư mục mới:

```sh
gh release download native-tvbox-20261031-r3 \
  --repo mowfteedev/trust-me-bro \
  --dir native-kit \
  --pattern 'zt-serverops-native-debian12-arm64-697e902.tar.gz' \
  --pattern 'SHA256SUMS'
```

Kiểm checksum và giải nén. Khối này dừng khi lỗi và từ chối giải nén đè thư mục đã có:

```sh
sh -eu <<'VERIFY_KIT'
cd native-kit
sha256sum --check SHA256SUMS
test ! -e zt-serverops-native
test ! -L zt-serverops-native
tar -xzf zt-serverops-native-debian12-arm64-697e902.tar.gz
VERIFY_KIT
```

Gói chứa `BUILD-INFO.json`, `VERIFICATION.json` và checksum nội bộ. Runtime khóa theo bản bàn giao gồm Node 22.23.4, PostgreSQL 16.15 và Caddy 2.11.7; xem lock để biết URL/checksum của từng thành phần. Release này dùng application source `697e902`; thay source hiện tại không tự rebuild nội dung Release.

## TV box đang chạy: chỉ kiểm tra

TV box hiện có bản cài tại `/opt/zt-serverops-native`. Cài lại laptop không cần chạy lại installer trên TV box.

Trên TV box:

```sh
sudo python3 /opt/zt-serverops-native/scripts/doctor.py --require-worker
```

Doctor đọc service, listener, DB, quyền khóa, peer và heartbeat. Nó không thay cho kiểm Web SSH, phân quyền, logout hoặc cảnh báo thực tế.

## Cài một Gateway mới

Chỉ dùng cho **máy mới chưa có bản native**, chạy Debian 12 ARM64 (`aarch64`), boot bằng systemd và kernel có WireGuard. Máy cần có sẵn Python 3, Bash, `wg`, `wg-quick`, `iptables`, `ip`, `openssl`, `ssh-keygen`, `runuser`, `useradd`, `sha256sum`. Installer không tự cài package.

Chép gói và `SHA256SUMS` tới máy đích qua kênh riêng, kiểm checksum rồi giải nén như trên. Trong thư mục `zt-serverops-native` đã giải nén, kiểm điều kiện trước:

```sh
sudo ./install.sh --preflight-only
```

Chỉ khi preflight đạt mới cài:

```sh
sudo ./install.sh
sudo python3 /opt/zt-serverops-native/scripts/doctor.py
```

Installer từ chối cấu hình, user, unit, runtime directory, cổng hoặc route trùng; không ghi đè bản cũ. Nếu lỗi giữa chừng hoặc mất phiên SSH, giữ log và kiểm trạng thái trước, không xóa DB/config rồi chạy lại. Gói chưa cung cấp quy trình nâng cấp hoặc tiếp tục cài dở.

| Thành phần | Mặc định |
|---|---|
| Chương trình | `/opt/zt-serverops-native` |
| Cấu hình | `/etc/zt-serverops-native` |
| DB/khóa/TLS | `/var/lib/zt-serverops-native` |
| WireGuard | `ztgw0`, `10.100.0.1/24`, UDP 51820, MTU 1200 |
| API | `10.100.0.1:3100` |
| PostgreSQL | `127.0.0.1:55432` |
| Dashboard HTTPS | `127.0.0.1:8443` |

Bản cài mới sinh danh tính, DB và tài khoản riêng; không mang secret của Gateway cũ sang. Telegram mặc định `dry-run`. Thông tin đăng nhập chỉ đọc tại console Gateway:

```sh
sudo cat /etc/zt-serverops-native/login.json
```

Không đưa nội dung tệp này vào Git hoặc gửi kèm gói cài.

## Mở Dashboard

Từ laptop hoặc máy khác có đường Tailscale tới TV box hiện tại, giữ lệnh sau chạy:

```sh
ssh -o ExitOnForwardFailure=yes -N \
  -L 127.0.0.1:8443:127.0.0.1:8443 root@100.78.198.50
```

Vào `https://localhost:8443` trên chính máy chạy lệnh. Caddy dùng chứng chỉ demo nội bộ. Địa chỉ `100.78.198.50` là TV box đang dùng; nếu thay danh tính Tailscale của TV box thì phải xác định lại địa chỉ.

## Đăng ký Worker mới

Mỗi Worker cần một bộ khóa/token và IP VPN riêng. Ví dụ dưới đây dùng tên/IP mới; **phải kiểm tra chưa có peer/node tương ứng trước khi dùng**, không coi `.5` là địa chỉ được đặt trước:

```sh
sudo python3 /opt/zt-serverops-native/scripts/register-worker.py prepare \
  --node-name node-linux-02 \
  --node-ip 10.100.0.5 \
  --gateway-endpoint 100.78.198.50:51820 \
  --worker-interface wg0 \
  --worker-os linux \
  --mtu 1200 \
  --bundle /root/node-linux-02
```

`prepare` chỉ tạo bundle riêng có mode `0700`; chưa đăng ký DB hoặc thêm peer. Chuyển bundle qua kênh riêng tới Worker, không commit bundle vào Git. Worker cần Agent đọc `agent-config.json`, WireGuard đọc `wg0.conf`, SSH user thường `ztuser` và public key Bastion trong bundle. SSH chỉ nhận từ Gateway qua VPN; Linux shell cần locale UTF-8.

Lấy public host key Ed25519 của SSH server từ console Worker qua kênh tin cậy. Chép public key đó về Gateway, ví dụ `/root/trusted-worker-host.pub`, rồi đăng ký:

```sh
sudo python3 /opt/zt-serverops-native/scripts/register-worker.py register \
  --bundle /root/node-linux-02 \
  --host-public-key /root/trusted-worker-host.pub \
  --ssh-user ztuser
```

Sau khi Worker kết nối, chạy doctor với `--require-worker`, xem số liệu Online và thử Web SSH. Quy trình VM mới và các lưu ý Windows ở [RECOVERY.md](../RECOVERY.md).

## Source và phạm vi kiểm chứng

Chạy unit tests từ gốc repo, không cần Docker hoặc runtime ARM64:

```sh
python3 -B -m unittest discover -s deploy/native/tests -p 'test_*.py'
```

Các unit dùng host/DB/WireGuard fixture có mock; chúng không chứng minh một máy mới đã triển khai thành công. Gói đã được kiểm trong Debian ARM64 giả lập; sau đó người dùng cài trên TV box vật lý và xác nhận doctor, Debian Worker Online, telemetry và Web SSH. Lifecycle WireGuard revision 3 có kiểm lỗi khởi động bằng systemd/kernel thật trong VM ARM64. Chi tiết giới hạn từng lượt nằm trong `VERIFICATION.json` của Release.

Windows Worker chưa được kiểm chạy với Gateway native TV box. Script Windows cũ hiện còn kiểm cổng 3000, cần đồng bộ về 3100 trước khi dùng để nghiệm thu. Không nhận các kết quả Windows/Docker ở Gateway cũ là kết quả trên TV box.

`deploy/linux/migrate-to-tvbox.py` giữ lại quy trình chuyển **Debian đã được cấu hình trước** (`node-linux-01`, `wg0`, `.4`). Đây không phải bộ cài cho VM Debian trắng. Nó có guard đường dẫn/danh tính và lưu bản cấu hình cũ trước khi chuyển.

Firewall native bảo vệ gói đi vào `ztgw0`; API bind IP WireGuard không đồng nghĩa bind riêng interface. WireGuard UDP 51820 lắng nghe địa chỉ host; gói không tự giới hạn outer UDP chỉ từ Tailscale, không sửa router và không chứng nhận public ingress.
