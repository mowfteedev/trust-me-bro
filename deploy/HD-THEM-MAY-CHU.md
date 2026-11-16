# Hướng dẫn thêm máy chủ giám sát (Worker Node) vào hệ thống ZT-ServerOps

Tài liệu này cung cấp quy trình chuẩn hóa để đăng ký và kết nối một máy chủ mới (**Worker Node**) vào cụm giám sát **ZT-ServerOps**, áp dụng cho cả môi trường máy ảo và máy vật lý.

---

## 1. Nguyên tắc kiến trúc & An ninh cốt lõi

1. **Mô hình kết nối M2M WireGuard (Overlay Network)**:
   - Toàn bộ lưu lượng telemetry (CPU, RAM, Disk, Uptime) và quản trị từ xa (Web SSH) đều lưu thông qua mạng ảo WireGuard (dải `10.100.0.0/24`).
   - Gateway có IP overlay cố định: `10.100.0.1`.
   - Mỗi Worker được cấp một địa chỉ IP overlay riêng biệt (`10.100.0.2` đến `10.100.0.254`).
2. **Nguyên tắc Zero Inbound & Cấm mở SSH ra Internet**:
   - Dịch vụ OpenSSH Server trên Worker **chỉ được phép lắng nghe trên IP overlay VPN** (`10.100.0.x:22`).
   - Tường lửa trên Worker (nftables/iptables trên Linux, Windows Defender Firewall trên Windows) bắt buộc thiết lập chính sách mặc định **DROP / BLOCK** toàn bộ lưu lượng vào từ card mạng ngoài (LAN / Internet).
   - Tắt hoàn toàn xác thực bằng mật khẩu (`PasswordAuthentication no`), tắt đăng nhập tài khoản root (`PermitRootLogin no`), chỉ cho phép xác thực bằng khóa công khai (Ed25519) từ Bastion Gateway `10.100.0.1`.
3. **Danh tính độc lập (Per-Node Identity)**:
   - Mỗi máy bắt buộc phải có: `node-name` duy nhất, IP overlay duy nhất, token ngẫu nhiên riêng (48 ký tự), cặp khóa WireGuard riêng và cặp khóa SSH Host riêng.
   - **Tuyệt đối không sao chép danh tính, token hoặc khóa riêng tư giữa các máy**.
4. **Xác thực khóa máy chủ qua kênh tin cậy (Out-of-Band Host Key Pinning)**:
   - Khóa công khai của SSH Server (`ssh_host_ed25519_key.pub`) trên Worker phải được sao chép sang Gateway qua kênh tin cậy (console nội bộ, thư mục chia sẻ có bảo vệ hoặc sao chép ngoại tuyến).
   - Không sử dụng `ssh-keyscan` qua mạng chưa xác thực để tránh tấn công giả mạo (Man-In-The-Middle). Gateway sẽ ghim chặt vân tay SHA256 của khóa này vào cơ sở dữ liệu.

---

## 2. Bảng phân định dải IP và tài khoản chuẩn

| Máy | Vai trò | IP Overlay VPN | Tài khoản Web SSH | Cổng SSH |
| :--- | :--- | :--- | :--- | :--- |
| **Gateway EC2** | Máy chủ trung tâm | `10.100.0.1` | — | N/A |
| **node-worker-01** | Docker Worker (laptop) | `10.100.0.2` | `ztuser` | `10.100.0.2:22` |
| **node-windows-01** | Máy ảo Windows | `10.100.0.3` | `ztuser` | `10.100.0.3:22` |
| **node-linux-01** | Máy ảo Linux | `10.100.0.4` | `ztuser` | `10.100.0.4:22` |
| **node-armbian-01** | Máy vật lý (TV box) | `10.100.0.5` | `ztuser` | `10.100.0.5:22` |
| *Máy mới tiếp theo* | Worker kế tiếp | `10.100.0.6...` | `ztuser` | `10.100.0.x:22` |

---

## 3. Quy trình chuẩn bị trên Gateway

> **Thực hiện trên máy Gateway EC2** `[GATEWAY]`.

### Bước G1. Khởi tạo gói danh tính riêng cho máy mới (Prepare Bundle)
Chạy script `register-node.py` với hành động `prepare` để sinh bộ khóa WireGuard, token xác thực và cấu hình định danh độc lập:

```bash
# [GATEWAY] Chạy trong thư mục gốc của dự án trên Gateway
python3 deploy/scripts/register-node.py \
  --project zt_ec2 \
  --env-file keys/ec2.env \
  prepare \
  --node-name <TEN_NODE_MOI> \
  --node-ip <IP_OVERLAY_MOI> \
  --gateway-endpoint <IP_PUBLIC_GATEWAY>:51820 \
  --bundle keys/<TEN_THU_MUC_BUNDLE>
```

*Ví dụ minh họa:*
```bash
python3 deploy/scripts/register-node.py \
  --project zt_ec2 \
  --env-file keys/ec2.env \
  prepare \
  --node-name node-windows-01 \
  --node-ip 10.100.0.3 \
  --gateway-endpoint 198.51.100.10:51820 \
  --bundle keys/windows-worker-01
```

Sau khi chạy xong, thư mục `keys/<TEN_THU_MUC_BUNDLE>` sẽ được tạo với quyền `0700`, chứa các tệp bảo mật:
- `zt-worker.conf`: File cấu hình giao thức WireGuard của Worker.
- `node.token`: Token xác thực telemetry của node (48 ký tự ngẫu nhiên).
- `agent-config.json`: File cấu hình cho Mini-Agent.
- `bastion_id_ed25519.pub`: Khóa công khai của Bastion Gateway (dùng cấp quyền cho `ztuser`).
- `metadata.json`: Bản ghi metadata định danh node.

---

## 4. Hướng dẫn chi tiết cho từng trường hợp

---

### TRƯỜNG HỢP 1: Máy ảo Windows (Windows 10 / 11 / Server 2022)

#### Điều kiện ban đầu:
- Hypervisor hỗ trợ: VMware Workstation/ESXi, VirtualBox, Hyper-V, KVM.
- **Thiết lập card mạng trên Hypervisor** `[HOST MÁY ẢO]`:
  - Chọn chế độ mạng **NAT** (khuyến nghị) để máy ảo tự do kết nối Internet ra Gateway mà không nhận kết nối trực tiếp từ mạng LAN ngoài.
  - **Tắt toàn bộ Inbound Port Forwarding** trên hypervisor liên quan đến máy ảo này.
- **Yêu cầu phần mềm trong máy ảo Windows** `[WORKER]`:
  - Cài đặt ứng dụng **WireGuard for Windows** chính thức (từ `https://www.wireguard.com/install/`).
  - Cài đặt tính năng **OpenSSH Server** của Windows:
    ```powershell
    # [WORKER: PowerShell Admin] Cài đặt OpenSSH Server
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
    ```

#### Bước W1. Lấy khóa công khai máy chủ SSH trên Windows `[WORKER]`
Tạo host key Ed25519 cho OpenSSH nếu chưa có:
```powershell
# [WORKER: PowerShell Admin] Khởi tạo Host Key
ssh-keygen -A
```
Khóa công khai máy chủ nằm tại: `C:\ProgramData\ssh\ssh_host_ed25519_key.pub`.
Xuất vân tay SHA256 để đối chiếu:
```powershell
# [WORKER: PowerShell Admin] Kiểm tra Fingerprint
ssh-keygen -lf C:\ProgramData\ssh\ssh_host_ed25519_key.pub
```
Sao chép tệp `ssh_host_ed25519_key.pub` này ra kênh tin cậy (kéo qua thư mục chia sẻ riêng hoặc chuyển qua Gateway) và lưu vào `keys/<TEN_THU_MUC_BUNDLE>/host_ed25519.pub` trên máy Gateway.

#### Bước W2. Đăng ký node vào Gateway `[GATEWAY]`
Sau khi đã có file `host_ed25519.pub` trên Gateway, thực hiện lệnh đăng ký:
```bash
# [GATEWAY] Đăng ký node vào Database và kích hoạt WireGuard peer
python3 deploy/scripts/register-node.py \
  --project zt_ec2 \
  --env-file keys/ec2.env \
  register \
  --bundle keys/windows-worker-01 \
  --host-public-key keys/windows-worker-01/host_ed25519.pub \
  --ssh-user ztuser
```

#### Bước W3. Thiết lập tài khoản và VPN/SSH trên Windows `[WORKER]`
Chuyển 2 tệp `zt-worker.conf` và `bastion_id_ed25519.pub` từ bundle về máy ảo Windows (ví dụ lưu tại `C:\staging`).
1. Tạo tài khoản cục bộ `ztuser` (không cấp quyền Administrator):
   ```powershell
   # [WORKER: PowerShell Admin] Tạo tài khoản ztuser không có quyền admin
   $pass = ConvertTo-SecureString -String ([System.Guid]::NewGuid().ToString()) -AsPlainText -Force
   New-LocalUser -Name "ztuser" -Password $pass -FullName "ZT Worker Service User" -Description "Unprivileged Web SSH account"
   ```
2. Chạy script thiết lập tự động có sẵn trong repo:
   ```powershell
   # [WORKER: PowerShell Admin] Chạy thiết lập mạng & OpenSSH
   powershell.exe -ExecutionPolicy Bypass -File deploy\windows\setup-worker.ps1 `
     -TunnelConfigPath "C:\staging\zt-worker.conf" `
     -GatewaySshPublicKeyPath "C:\staging\bastion_id_ed25519.pub" `
     -TransportInterfaceAlias @("Ethernet0") `
     -VpnAddress "10.100.0.3" `
     -SshUser "ztuser" `
     -DedicatedVm
   ```
   *Lưu ý: Thay `Ethernet0` bằng tên chính xác của card mạng vật lý/NAT trên máy ảo Windows (`Get-NetAdapter`).*

#### Bước W4. Cài đặt Mini-Agent làm Windows Service `[WORKER]`
1. Chép binary `zt-agent.exe` và file `agent-config.json` vào thư mục `C:\Program Files\ZT-ServerOps\agent\`.
2. Phân quyền thư mục chỉ cho phép `SYSTEM` và `Administrators` toàn quyền, cấp quyền đọc cho `LOCAL SERVICE`.
3. Cài đặt và kích hoạt dịch vụ chạy nền:
   ```powershell
   # [WORKER: PowerShell Admin] Cài đặt Windows Service cho Mini-Agent
   New-Service -Name "zt-agent" `
     -BinaryPathName '"C:\Program Files\ZT-ServerOps\agent\zt-agent.exe" --config "C:\Program Files\ZT-ServerOps\agent\agent-config.json"' `
     -DisplayName "ZT-ServerOps Telemetry Agent" `
     -StartupType Automatic
   Start-Service -Name "zt-agent"
   ```

---

### TRƯỜNG HỢP 2: Máy ảo Linux (Debian 12 / Ubuntu 22.04+)

#### Điều kiện ban đầu:
- Hệ điều hành: Debian 12 (Bookworm) hoặc Ubuntu 22.04/24.04 LTS.
- **Card mạng Hypervisor** `[HOST MÁY ẢO]`: Chọn chế độ **NAT**; không cấu hình port forwarding inbound.
- **Yêu cầu gói phần mềm** `[WORKER]`:
  ```bash
  # [WORKER] Cài đặt các tiện ích cần thiết
  sudo apt-get update && sudo apt-get install -y wireguard wireguard-tools openssh-server nftables curl
  ```

#### Bước L1. Khởi tạo và lấy Host Key Ed25519 trên Linux `[WORKER]`
Kiểm tra hoặc sinh host key:
```bash
# [WORKER] Sinh SSH host key nếu chưa có
sudo ssh-keygen -A
# [WORKER] Xem khóa công khai và vân tay
cat /etc/ssh/ssh_host_ed25519_key.pub
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```
Lưu nội dung dòng `ssh-ed25519 ...` vào tệp `keys/<TEN_THU_MUC_BUNDLE>/host_ed25519.pub` trên Gateway.

#### Bước L2. Đăng ký node vào Gateway `[GATEWAY]`
```bash
# [GATEWAY]
python3 deploy/scripts/register-node.py \
  --project zt_ec2 \
  --env-file keys/ec2.env \
  register \
  --bundle keys/linux-worker-01 \
  --host-public-key keys/linux-worker-01/host_ed25519.pub \
  --ssh-user ztuser
```

#### Bước L3. Cấu hình WireGuard & Zero Inbound Tường lửa `[WORKER]`
1. Chép tệp `zt-worker.conf` vào `/etc/wireguard/wg0.conf`:
   ```bash
   # [WORKER]
   sudo cp /path/to/zt-worker.conf /etc/wireguard/wg0.conf
   sudo chmod 600 /etc/wireguard/wg0.conf
   sudo systemctl enable --now wg-quick@wg0
   ```
2. Cấu hình tường lửa `nftables` chặn toàn bộ traffic ngoài, chỉ cho phép SSH qua WireGuard:
   Chép tệp `deploy/linux/nftables-worker.conf` vào `/etc/nftables.conf`:
   ```nftables
   #!/usr/sbin/nft -f
   table inet zt_worker {
     chain input {
       type filter hook input priority 0; policy drop;
       iifname "lo" accept
       ct state established,related accept
       ct state invalid drop
       iifname "wg0" ip saddr 10.100.0.1 tcp dport 22 accept
       # Cho phép DHCP client
       udp sport 67 udp dport 68 accept
     }
     chain forward {
       type filter hook forward priority 0; policy drop;
     }
     chain output {
       type filter hook output priority 0; policy accept;
     }
   }
   ```
   Kích hoạt tường lửa:
   ```bash
   # [WORKER]
   sudo nft -f /etc/nftables.conf
   sudo systemctl enable --now nftables
   ```

#### Bước L4. Cấu hình OpenSSH Server & Tài khoản `ztuser` `[WORKER]`
1. Tạo tài khoản `ztuser` không có quyền sudo, mở khóa cho SSH key auth:
   ```bash
   # [WORKER]
   sudo useradd -m -s /bin/bash ztuser
   sudo usermod -p '*' ztuser
   sudo mkdir -p /home/ztuser/.ssh
   sudo chmod 700 /home/ztuser/.ssh
   sudo cp /path/to/bastion_id_ed25519.pub /home/ztuser/.ssh/authorized_keys
   sudo chmod 600 /home/ztuser/.ssh/authorized_keys
   sudo chown -R ztuser:ztuser /home/ztuser/.ssh
   ```
2. Cấu hình drop-in cho OpenSSH `/etc/ssh/sshd_config.d/99-zt-worker.conf`:
   ```ini
   Port 22
   AddressFamily inet
   ListenAddress 10.100.0.4
   HostKey /etc/ssh/ssh_host_ed25519_key
   PermitRootLogin no
   PasswordAuthentication no
   KbdInteractiveAuthentication no
   AuthenticationMethods publickey
   AllowUsers ztuser@10.100.0.1
   DisableForwarding yes
   ```
3. Khởi động lại dịch vụ SSH:
   ```bash
   # [WORKER]
   sudo sshd -t
   sudo systemctl restart ssh
   ```

#### Bước L5. Cài đặt Mini-Agent `[WORKER]`
1. Chép binary tĩnh `zt-agent` vào `/opt/zt-worker/zt-agent` (chmod 755).
2. Tạo cấu hình `/opt/zt-worker/agent-config.json` từ bundle:
   ```json
   {
     "GATEWAY_URL": "http://10.100.0.1:3000",
     "NODE_ID": "node-linux-01",
     "NODE_TOKEN": "<TOKEN_DOC_TU_FILE_NODE_TOKEN>",
     "NETWORK_INTERFACE": "wg0",
     "DISK_MOUNT_POINT": "/",
     "BEACON_INTERVAL_SECONDS": "3.0",
     "MAX_BACKOFF_SECONDS": "30.0",
     "HTTP_TIMEOUT_SECONDS": "3.0",
     "JITTER_RATIO": "0.0"
   }
   ```
3. Tạo systemd unit `/etc/systemd/system/zt-agent.service`:
   ```ini
   [Unit]
   Description=ZT-ServerOps Telemetry Agent
   After=network.target wg-quick@wg0.service
   Wants=wg-quick@wg0.service

   [Service]
   Type=simple
   ExecStart=/opt/zt-worker/zt-agent --config /opt/zt-worker/agent-config.json
   Restart=always
   RestartSec=5s

   [Install]
   WantedBy=multi-user.target
   ```
4. Kích hoạt dịch vụ:
   ```bash
   # [WORKER]
   sudo systemctl daemon-reload
   sudo systemctl enable --now zt-agent.service
   ```

---

### TRƯỜNG HỢP 3: Máy vật lý (Bare-Metal / Linux ARM64 / TV box)

Trường hợp máy vật lý dùng chung mạng với các dịch vụ khác (ví dụ TV box Armbian đang chạy sẵn cụm dịch vụ cũ hoặc có dải IP trùng lặp), giải pháp tối ưu và an toàn nhất là sử dụng **Linux Network Namespace (`netns`)** để cô lập hoàn toàn giao diện WireGuard và Mini-Agent, không gây xung đột với bất kỳ tiến trình nào trên máy host.

#### Bước P1. Đăng ký node trên Gateway `[GATEWAY]`
Thực hiện các bước `prepare` và `register` tương tự Trường hợp 2 với tên node và IP riêng (ví dụ `node-armbian-01`, IP `10.100.0.5`).

#### Bước P2. Thiết lập Network Namespace cô lập trên máy vật lý `[WORKER]`
Tạo script điều khiển `/opt/zt-worker/zt-worker-manager.sh`:
```bash
#!/bin/bash
set -euo pipefail

NETNS="zt-worker"
CONF="/opt/zt-worker/zt-worker.conf"
NODE_IP="10.100.0.5"
GW_IP="10.100.0.1"

start() {
    # 1. Tạo network namespace
    if ! ip netns list | grep -qw "$NETNS"; then
        ip netns add "$NETNS"
    fi
    ip netns exec "$NETNS" ip link set lo up

    # 2. Xóa interface cũ nếu tồn tại
    if ip netns exec "$NETNS" ip link show wg0 &>/dev/null; then
        ip netns exec "$NETNS" ip link del wg0 || true
    fi

    # 3. Tạo interface WireGuard và chuyển vào namespace
    ip link add dev wg0 type wireguard
    ip link set wg0 netns "$NETNS"

    # 4. Áp dụng cấu hình và định tuyến
    grep -vE '^\s*Address' "$CONF" | ip netns exec "$NETNS" wg setconf wg0 /dev/stdin
    ip netns exec "$NETNS" ip addr add "${NODE_IP}/32" dev wg0
    ip netns exec "$NETNS" ip link set wg0 up
    ip netns exec "$NETNS" ip route add "${GW_IP}/32" dev wg0

    # 5. Khởi động OpenSSH daemon riêng trong namespace
    if ! ip netns exec "$NETNS" pgrep -f sshd_config_ztworker &>/dev/null; then
        ip netns exec "$NETNS" /usr/sbin/sshd -f /etc/ssh/sshd_config_ztworker
    fi

    # 6. Chạy Mini-Agent
    exec ip netns exec "$NETNS" /opt/zt-worker/zt-agent --config /opt/zt-worker/agent-config.json
}

stop() {
    PID=$(ip netns exec "$NETNS" pgrep -f sshd_config_ztworker || true)
    if [ -n "$PID" ]; then
        kill "$PID" || true
    fi
    if ip netns list | grep -qw "$NETNS"; then
        ip netns exec "$NETNS" ip link del wg0 2>/dev/null || true
        ip netns del "$NETNS" || true
    fi
}

case "${1:-start}" in
    start) start ;;
    stop) stop ;;
    *) echo "Usage: $0 {start|stop}"; exit 1 ;;
esac
```
Phân quyền:
```bash
# [WORKER]
sudo chmod 755 /opt/zt-worker/zt-worker-manager.sh
```

#### Bước P3. Tạo systemd unit quản lý `[WORKER]`
Tạo file `/etc/systemd/system/zt-worker.service`:
```ini
[Unit]
Description=ZT-ServerOps Worker (Isolated Namespace)
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/zt-worker/zt-worker-manager.sh start
ExecStop=/opt/zt-worker/zt-worker-manager.sh stop
Restart=always
RestartSec=5s

[Install]
WantedBy=multi-user.target
```
Kích hoạt tự chạy khi khởi động máy:
```bash
# [WORKER]
sudo systemctl daemon-reload
sudo systemctl enable --now zt-worker.service
```

---

## 5. Bảng kiểm tra nghiệm thu (Verification Checklist)

Sau khi hoàn tất cài đặt, bắt buộc thực hiện kiểm chứng theo 5 bước dưới đây:

### 1. Kiểm tra kết nối WireGuard
Trên Worker, chạy lệnh:
- Linux thông thường: `sudo wg show`
- Linux dùng Namespace: `sudo ip netns exec zt-worker wg show`
- Windows: Xem trạng thái Tunnel trong ứng dụng WireGuard GUI hoặc `Get-Service WireGuardTunnel$zt-worker`.

*Tiêu chí đạt:* Thấy dòng `latest handshake` dưới 30 giây, số bytes `transfer` gửi và nhận đều tăng dần.

### 2. Kiểm tra Telemetry trên Dashboard
1. Truy cập Dashboard ZT-ServerOps qua trình duyệt.
2. Tại menu **Máy chủ (Fleet)**:
   - Node mới xuất hiện với tên đã đăng ký (ví dụ `node-windows-01`, `node-armbian-01`).
   - Cột **Trạng thái** hiển thị badge xanh `HEALTHY` (Online).
   - Chỉ số **CPU**, **RAM**, **Disk** và **Uptime** hiển thị số đo thực tế và cập nhật đều đặn mỗi 3 giây.
   - Nhịp `heartbeat age` luôn duy trì dưới 4 giây.

### 3. Kiểm tra Web SSH Terminal
1. Đăng nhập vào Dashboard bằng tài khoản có quyền `ADMIN`.
2. Bấm nút **Mở Web SSH** tại dòng máy chủ vừa thêm.
3. Cửa sổ dòng lệnh Terminal bật lên:
   - Thấy banner hệ điều hành của node đích.
   - Dấu nhắc hiển thị đúng `ztuser@<node-name>:~$`.
   - Chạy lệnh kiểm tra: `whoami`, `uname -a`, `df -h`.
   - Gõ `exit` để đóng phiên terminal an toàn.
4. Đăng nhập bằng tài khoản `VIEWER`: Xác nhận nút **Mở Web SSH** bị ẩn/vô hiệu hóa hoàn toàn.

### 4. Kiểm tra Cảnh báo Sự cố & Phục hồi Telegram (Offline -> Online)
1. Thử ngắt kết nối Worker (dừng service: `sudo systemctl stop zt-worker` hoặc tắt card mạng).
2. Quan sát trên Dashboard: Sau khoảng 15 giây, trạng thái chuyển sang màu vàng `STALE`.
3. Sau khoảng 30–35 giây: Trạng thái chuyển sang màu đỏ `OFFLINE`.
4. Bot Telegram gửi thông báo khẩn cấp:
   ```text
   🚨 [ZT-ServerOps] CẢNH BÁO MẤT TÍN HIỆU
   Máy chủ: <TEN_NODE>
   IP: 10.100.0.x
   Mức độ: CRITICAL
   Thời gian không nhận tín hiệu: 30s
   ```
5. Bật lại dịch vụ Worker: `sudo systemctl start zt-worker`.
6. Quan sát Telegram: Sau 3–5 giây, Bot gửi ngay thông báo phục hồi:
   ```text
   ✅ [ZT-ServerOps] MÁY CHỦ ĐÃ KẾT NỐI LẠI
   Máy chủ: <TEN_NODE>
   IP: 10.100.0.x
   Trạng thái: HEALTHY (Online)
   Thời gian gián đoạn: 35s
   ```

### 5. Kiểm tra Khả năng Tự Khởi Động (Reboot Verification)
1. Khởi động lại máy Worker: `sudo reboot` (Linux) hoặc `Restart-Computer` (Windows).
2. Sau khi máy khởi động lại xong:
   - Dịch vụ WireGuard và Agent tự động chạy ngầm mà không cần người dùng đăng nhập Desktop.
   - Dashboard tự động ghi nhận máy trở lại `HEALTHY` sau 5–10 giây.
   - Kiểm tra mức tiêu thụ RAM thực tế của tiến trình Agent: đảm bảo duy trì trong khoảng **4MB – 12MB RAM**, không gây quá tải cho hệ thống.

---

## 6. Xử lý sự cố thường gặp (Troubleshooting) & Khôi phục (Rollback)

| Hiện tượng | Nguyên nhân gốc rễ | Hướng khắc phục |
| :--- | :--- | :--- |
| **WireGuard không handshake** (transfer: 0 B received) | Sai public key của Gateway, hoặc cổng UDP 51820 trên Gateway bị chặn bởi Security Group / Firewall. | Kiểm tra lại Endpoint trong file conf. Đảm bảo Security Group của Gateway EC2 đã mở Inbound `Custom UDP 51820`. |
| **Agent báo `beacon connection failed`** | Interface WireGuard chưa có route tới `10.100.0.1`, hoặc Gateway Fastify chưa lắng nghe. | Kiểm tra `ip route` xem `10.100.0.1` có trỏ qua interface VPN không. Thử `curl http://10.100.0.1:3000/healthz`. |
| **Web SSH báo `All configured authentication methods failed`** | Tài khoản `ztuser` trên Linux vừa tạo bị khóa mật khẩu (`Account is locked`), hoặc quyền tệp `.ssh` sai. | Chạy lệnh `sudo usermod -p '*' ztuser` để mở khóa cho SSH key auth. Đảm bảo quyền `chmod 700 ~/.ssh` và `chmod 600 ~/.ssh/authorized_keys`. |
| **Web SSH báo `Host key verification failed`** | Khóa host trên máy Worker bị thay đổi hoặc không khớp với vân tay SHA256 đã đăng ký ban đầu. | Cơ chế chống tấn công giả mạo (MITM) đang hoạt động. Cần kiểm tra lại tệp `ssh_host_ed25519_key.pub` trên Worker và cập nhật lại fingerprint qua CLI. |

### Hướng dẫn Hủy đăng ký / Khôi phục (Rollback)
Nếu muốn gỡ bỏ một node khỏi hệ thống:
1. **Trên Gateway**:
   - Xóa peer trong `keys/wg0-gateway.conf`.
   - Áp dụng thay đổi ngay lập tức: `docker compose exec wireguard_gateway wg set wg0 peer <PUBLIC_KEY_CUA_NODE> remove`.
   - Thu hồi token hoặc xóa node trong Database:
     ```sql
     UPDATE nodes SET is_token_revoked = true, status = 'OFFLINE' WHERE name = '<TEN_NODE>';
     ```
2. **Trên Worker**:
   - Dừng và vô hiệu hóa service:
     - Linux: `sudo systemctl disable --now zt-worker.service` (hoặc `zt-agent.service`).
     - Windows: Chạy script `deploy\windows\restore-worker.ps1 -DedicatedVm` để phục hồi nguyên trạng tường lửa và cấu hình SSH cũ.
