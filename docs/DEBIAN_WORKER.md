# Debian 12 Worker

Đã chạy thật ngày 20/10/2026: Gateway Docker trên Arch Linux, một Worker Docker
và một Worker Debian 12 trên KVM/virt-manager. Phiếu giao ghi **VMware/VirtualBox**;
KVM có bằng chứng chức năng nhưng chưa được xác nhận là thay thế được yêu cầu đó.
Không cần cài Docker, Node.js hoặc Go lên Worker.

| Thành phần | Địa chỉ / cấu hình |
|---|---|
| Gateway | VPN `10.100.0.1`, endpoint `192.168.122.1:51820/udp` |
| Worker Docker có sẵn | `node-worker-01`, `10.100.0.2` |
| Worker Debian mới | `node-linux-01`, `10.100.0.4`, WireGuard `wg0` |
| VM | libvirt `debian12`, 2 vCPU, RAM cấp 1536 MiB, disk 15 GiB |
| NIC transport lúc setup | `enp1s0`, DHCP `192.168.122.233` |
| SSH ứng dụng | `ztuser`, chỉ public key từ Gateway, không có quyền sudo |
| Quản trị VM | `linux`, khóa setup riêng, chỉ truy cập qua Gateway/VPN |

## Dùng VM đã cấu hình

Bật `debian12` trong virt-manager nếu đang tắt, rồi tại thư mục dự án trên host:

```sh
python3 deploy/scripts/demo.py doctor
```

Mở **https://localhost**, đăng nhập `demo-admin`, chọn `node-linux-01` và mở
**Web SSH**. Chạy `hostname; whoami; uname -sr`: kết quả là `node-linux-01`,
`ztuser`, Linux. Tiêu đề terminal hiển thị `ztuser@node-linux-01` sau khi kết nối.
Viewer xem được thông số nhưng không được mở SSH.
Mật khẩu Dashboard ở `keys/demo-login.env`; mật khẩu VM không phải mật khẩu web.

Console quản trị thường dùng **`linux`**, Web SSH dùng **`ztuser`** riêng.
Để đối chiếu cùng tệp trên console VM:

```sh
sudo -iu ztuser
whoami; pwd; readlink -f a.txt
```

Console và Web SSH lúc này cùng thao tác `/home/ztuser/a.txt`, không cần sao chép
hoặc đồng bộ tệp. Sau khi một phiên lưu, phiên kia đọc lại thấy thay đổi; editor
đang mở cần tải lại nội dung. `/home/linux/a.txt` là tệp khác, được giữ riêng với
home quyền 700. ADMIN của Dashboard được mở SSH, không tự có root/sudo trong VM.

## Tài khoản SSH riêng từng node

Migration 009 thêm `nodes.ssh_username`; node cũ để NULL tiếp tục dùng
`BASTION_DEFAULT_USER` (`ztuser` trong Compose). Chỉ CLI quản trị cục bộ được
đổi tài khoản sau khi khớp name/IP/token/host key; trình duyệt không chọn user.
Bản hiện tại chốt `ztuser` cho cả Debian và Docker. Public Bastion key chỉ cấp
cho `ztuser`; quyền Bastion tạm thêm cho `linux` trong lượt thử đã gỡ, khóa quản
trị riêng của `linux` giữ nguyên. Password/root login vẫn tắt. Lệnh đã áp dụng:

```sh
python3 deploy/scripts/register-node.py register \
  --bundle keys/linux-worker-01 \
  --host-public-key keys/linux-worker-01/ssh_host_ed25519_key.pub --ssh-user ztuser
```

Lệnh này giữ định danh/khóa/token và các node khác; bỏ `--ssh-user` khi đăng ký
lại sẽ giữ cấu hình tài khoản đang có. Docker `.2` vẫn dùng `ztuser`.

SSH quản trị từ host sử dụng khóa đã cấp và host key đã ghim:

```sh
ssh -i keys/debian12-setup_ed25519 \
  -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=keys/debian12-known_hosts \
  -o 'ProxyCommand=docker compose --env-file keys/demo.env -p zt_demo exec -T wireguard_gateway nc %h %p' \
  linux@10.100.0.4
```

Sau hardening, `ssh linux@192.168.122.233` sẽ không kết nối được. Dùng đường VPN
ở trên hoặc console virt-manager; không mở lại port 22 trên transport để demo.
DHCP có thể đổi IP transport; địa chỉ VPN `.4` vẫn giữ nguyên.

## Các bước cài đã thực hiện

Các bước dưới dành cho **Worker riêng chưa có cấu hình**. Máy hiện tại đã hoàn
thành; không chạy lại `prepare` lên bundle cũ hoặc ghi đè cấu hình đang dùng.
Backup cấu hình ban đầu nằm trong `/root/zt-before-20261020/` của guest.

1. SSH bootstrap bằng tài khoản `linux`, cấp public key setup một lần. Đã đối
   chiếu fingerprint Ed25519 với kênh guest-agent của hypervisor. Khóa setup
   riêng, known_hosts và bundle chỉ lưu trong `keys/`, không vào Git.
2. Trong Debian, lệnh sau đã chạy, các gói đều có sẵn và không cần thay đổi:

   ```sh
   sudo apt-get install -y --no-install-recommends openssh-server wireguard-tools nftables curl ca-certificates
   ```

3. Trên host, tạo peer/token mới, không dùng lại khóa hoặc IP Docker `.2`:

   ```sh
   python3 deploy/scripts/register-node.py prepare \
     --node-name node-linux-01 --node-ip 10.100.0.4 \
     --gateway-endpoint 192.168.122.1:51820 --bundle keys/linux-worker-01
   ```

   Công cụ tạo bundle ban đầu theo Windows. Trong bundle Linux này đã đổi
   `NETWORK_INTERFACE=wg0`, `DISK_MOUNT_POINT=/`, `tunnel_name=wg0`. Các giá trị
   Agent được ghi vào `agent.env` riêng quyền 600, gồm token đã sinh. Không in
   token ra terminal. Binary Linux amd64 lấy từ image Worker đang chạy:

   ```sh
   docker cp zt_demo-node_worker_01-1:/usr/local/bin/zt-agent keys/linux-worker-01/zt-agent
   ```

4. Chuyển riêng cấu hình peer mới `zt-worker.conf`, public key Bastion, binary,
   `agent.env` và `agent/install.sh` qua SSH vào `/home/linux/zt-setup/` quyền 700.
   Không chuyển private key Gateway/Bastion. Trong guest, bằng root:

   ```sh
   install -m 0600 /home/linux/zt-setup/zt-worker.conf /etc/wireguard/wg0.conf
   systemctl enable --now wg-quick@wg0
   ```

   Cấu hình peer có Address `.4/32`, AllowedIPs `.1/32`, PersistentKeepalive 25.
   Lấy `/etc/ssh/ssh_host_ed25519_key.pub` qua kênh đã xác minh, lưu về bundle host:

   ```sh
   python3 deploy/scripts/register-node.py register \
     --bundle keys/linux-worker-01 \
     --host-public-key keys/linux-worker-01/ssh_host_ed25519_key.pub
   ```

   Register thêm node `VM` và peer `/32`, ghim host key, giữ node/tài khoản cũ;
   Gateway không cần restart. Sau đó guest đã gọi được `/readyz` qua VPN.

5. Tạo `ztuser` có shell và không sudo. Public Bastion key nằm trong
   `/home/ztuser/.ssh/authorized_keys` (owner `ztuser`, thư mục 700, tệp 600).
   Private host key Ed25519 quyền 400, owner root. Agent cài bằng root:

   ```sh
   set -a
   . /home/linux/zt-setup/agent.env
   set +a
   ZT_AGENT_BINARY=/home/linux/zt-setup/zt-agent bash /home/linux/zt-setup/install.sh
   ```

   Installer giữ `.env` hiện có; lần cài này đặt heartbeat 3 giây, rồi đổi
   `JITTER_RATIO=0.0` trong `/opt/zt-serverops/agent/.env`. Service chạy dưới user
   `zt-agent`, tách khỏi tài khoản SSH, cấu hình root:root 600.

6. Hai service `zt-agent` và `ssh` có drop-in `wireguard.conf` tương ứng trong
   `/etc/systemd/system/<tên>.service.d/`, cùng nội dung:

   ```ini
   [Unit]
   Requires=wg-quick@wg0.service
   After=wg-quick@wg0.service
   ```

   Cấu hình SSH thực tế theo [sshd-worker.conf](../deploy/linux/sshd-worker.conf),
   cài ở `/etc/ssh/sshd_config.d/00-zt-worker.conf`. Đã chạy `sshd -t` trước
   reload; kiểm tra SSH bằng khóa qua VPN thành công trước khi đóng transport.

7. Guest ban đầu không có luật firewall. Đã kiểm tra `nft -c -f` rồi cài cấu
   hình [nftables-worker.conf](../deploy/linux/nftables-worker.conf) tại
   `/etc/nftables.conf`, bật `nftables.service`. Luật chỉ nhận SSH từ `.1` qua
   wg0, giữ reply của kết nối outbound, DHCP và IPv6 NDP cần thiết; không mở
   dịch vụ trên transport. Không áp cấu hình này lên host Gateway.

Các tệp chứa token/private peer config trong staging guest đã dọn sau kiểm tra;
cấu hình đang chạy còn ở `/etc/wireguard/` và `/opt/zt-serverops/agent/`.
Bundle host được giữ riêng để khôi phục, không đưa vào Git.

## Kiểm tra lại

```sh
python3 deploy/scripts/verify-vm.py --node-name node-linux-01 --shell linux --ssh-user ztuser
python3 deploy/scripts/demo.py doctor
```

Lệnh verify chạy chức năng thật và **đăng xuất các phiên demo-admin/demo-viewer**
trên Gateway được chọn. Đã đạt 16/16 trước và sau reboot VM; Firefox thật cũng
đã mở terminal Debian. Xem [bằng chứng và giới hạn](verification/debian-vm.md).
Thử dừng Agent thật đã tạo một cảnh báo Offline gửi Telegram; khi bật lại,
node về Online và incident được resolve. Không dùng `demo-liveness.py` hardcode
Worker Docker để kết luận cho VM này.
