# Thêm Worker Windows, Linux và máy vật lý

Gateway hiện tại dùng Compose, API `http://10.100.0.1:3000` qua WireGuard.
Bản native TV box cũ dùng API3100; không trộn bundle của hai Gateway.
Các địa chỉ dưới đây là quy hoạch mẫu, phải kiểm tra chưa được sử dụng.

| Máy | Overlay | Loại | Tài khoản SSH |
|---|---|---|---|
| Gateway | 10.100.0.1 | Gateway | — |
| Docker demo đã có | 10.100.0.2 | DOCKER | ztuser |
| VM Windows | 10.100.0.3 | VM | ztuser |
| VM Linux | 10.100.0.4 | VM | ztuser |
| Máy vật lý Linux riêng | 10.100.0.6 | BARE_METAL | ztuser |

## 1. Chuẩn bị trên từng máy

**Máy phát triển:** dùng source đúng commit và Go theo `agent/go.mod` để build
binary tĩnh; không cần Go trên Worker. Ví dụ từ thư mục repo:

```sh
cd agent
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /tmp/zt-agent-linux-amd64 .
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags='-s -w' -o /tmp/zt-agent-linux-arm64 .
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /tmp/zt-agent-windows-amd64.exe .
```

Gửi binary đúng kiến trúc, script cài và bundle qua kênh riêng. So sánh SHA256
binary ở hai đầu. Không gửi private key/token vào chat hoặc đưa vào Git.

**Host VM:** chọn NAT, không port-forward vào VM. Có console trước khi sửa
firewall/SSH. Máy vật lý phải có quyền quản trị và đường truy cập console;
nếu đang phục vụ ứng dụng khác, cần kiểm tra chính sách mạng trước khi áp dụng
bộ cấu hình dành cho máy riêng. TV box đang chạy Worker namespace giữ nguyên
cấu hình hiện có, không chạy các bước cài mới dưới đây lên nó.

## 2. Tạo bundle trên Gateway

Chạy trong repo ở Gateway, không chạy lại init-secrets. Ví dụ Linux:

```sh
python3 deploy/scripts/register-node.py --project zt_ec2 --env-file keys/ec2.env prepare \
  --node-name node-linux-01 --node-ip 10.100.0.4 \
  --gateway-endpoint 192.0.2.10:51820 --worker-os linux --node-type VM \
  --bundle keys/linux-worker-01
python3 deploy/scripts/worker_check.py --bundle keys/linux-worker-01 --worker-os linux
```

Thay `192.0.2.10` bằng endpoint thật. Với Windows dùng `--worker-os windows`,
node/IP `.3` và bundle riêng. Máy vật lý Linux dùng `--worker-os linux
--node-type BARE_METAL`, IP `.6`, tên và bundle riêng. `prepare` không sửa DB
hoặc peer và từ chối ghi đè bundle. Token sinh từ 48 byte ngẫu nhiên, mã hóa
URL-safe khoảng 64 ký tự; không phải token cố định 48 ký tự.

Bundle `0700`, tệp `0600`: `zt-worker.conf`, `node.token`, `agent-config.json`,
`metadata.json`, `bastion_id_ed25519.pub`. Chuyển riêng từng bundle cho đúng
máy; giao diện mặc định `zt-worker`, Linux đo đĩa `/`, Windows đo `C:\`.
`worker_check.py` chỉ kiểm file, không chứng minh handshake/firewall/reboot.

## 3. VM Windows — PowerShell quản trị trong VM

Cài WireGuard chính thức và OpenSSH Server; đặt bundle ở `C:\staging\worker`.
Chép thư mục `deploy\windows` và `agent\install-windows.ps1` từ đúng source.

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
ssh-keygen -A
Get-NetAdapter
```

Tạo `ztuser` nếu chưa có, là tài khoản thường, không thuộc Administrators.
Mật khẩu nhập riêng, không chép vào tài liệu/lệnh:

```powershell
New-LocalUser -Name ztuser -Password (Read-Host 'Mat khau tai khoan Windows' -AsSecureString)
```

Từ console VM, thay `Ethernet0` bằng đúng NIC NAT; liệt kê mọi NIC transport
đang hoạt động. Script chỉ dành cho máy Windows lab riêng; không chạy trên
Windows host đang làm việc của người dùng với `-DedicatedVm`.

```powershell
powershell.exe -ExecutionPolicy Bypass -File deploy\windows\setup-worker.ps1 `
  -TunnelConfigPath C:\staging\worker\zt-worker.conf `
  -GatewaySshPublicKeyPath C:\staging\worker\bastion_id_ed25519.pub `
  -TransportInterfaceAlias @('Ethernet0') -VpnAddress 10.100.0.3 `
  -SshUser ztuser -DedicatedVm
powershell.exe -ExecutionPolicy Bypass -File agent\install-windows.ps1 `
  -BinaryPath C:\staging\zt-agent-windows-amd64.exe `
  -ConfigPath C:\staging\worker\agent-config.json -ValidateOnly
powershell.exe -ExecutionPolicy Bypass -File agent\install-windows.ps1 `
  -BinaryPath C:\staging\zt-agent-windows-amd64.exe `
  -ConfigPath C:\staging\worker\agent-config.json
```

Installer cài **ZTServerOpsAgent** với `--service`, quyền LocalService,
khởi động tự động; giữ cấu hình cũ nếu không có `-UpdateConfig`. Không dùng
`New-Service` trực tiếp với binary thiếu `--service`.

Lấy **PUBLIC host key** `C:\ProgramData\ssh\ssh_host_ed25519_key.pub` từ
console/kênh tin cậy, chuyển lại Gateway. Đối chiếu:

```powershell
ssh-keygen -lf C:\ProgramData\ssh\ssh_host_ed25519_key.pub
Get-Service ZTServerOpsAgent,sshd,'WireGuardTunnel$zt-worker'
powershell.exe -ExecutionPolicy Bypass -File deploy\windows\check-worker.ps1
```

Máy Windows vật lý dùng cùng Agent; bộ setup mạng ở trên có ràng buộc máy lab
riêng. Với máy có domain/GPO/dịch vụ khác, phải thiết kế rule phù hợp trước,
không mặc định nó tương đương DedicatedVm.

## 4. VM Linux hoặc máy vật lý Linux riêng — console của Worker

Ví dụ Debian/Ubuntu. Thay `.4` bằng `.6` với máy vật lý; binary amd64 hoặc
arm64 phải đúng `uname -m`. Đặt bundle ở `/root/worker-bundle` riêng tư và
repo/scripts ở thư mục quản trị, không đặt khóa trong home dùng chung.

```sh
sudo apt-get update
sudo apt-get install -y wireguard wireguard-tools openssh-server nftables curl
sudo ssh-keygen -A
sudo install -m 600 /root/worker-bundle/zt-worker.conf /etc/wireguard/zt-worker.conf
sudo systemctl enable --now wg-quick@zt-worker
```

Tạo tài khoản thường và cấp Bastion **public** key. Nếu tài khoản đã có, giữ
UID/home/quyền của nó; không chạy `useradd` lại. Thực hiện từ root console:

```sh
id ztuser || useradd -m -s /bin/bash ztuser
usermod -p '*' ztuser
install -d -m 700 -o ztuser -g ztuser /home/ztuser/.ssh
install -m 600 -o ztuser -g ztuser /root/worker-bundle/bastion_id_ed25519.pub /home/ztuser/.ssh/authorized_keys
```

Máy riêng mới: sao lưu `/etc/ssh/sshd_config`, dùng template
`deploy/linux/sshd-worker.conf`, thay `ListenAddress` đúng overlay. Template
chỉ cho key-auth từ Gateway, không root/password/forwarding. Kiểm tra trước
khi restart; giữ console để phục hồi. Dùng template làm cấu hình chính tránh
`ListenAddress` cũ còn hiệu lực qua include; bảo toàn cấu hình cũ riêng.

```sh
cp -an /etc/ssh/sshd_config /etc/ssh/sshd_config.before-zt
install -m 600 deploy/linux/sshd-worker.conf /etc/ssh/sshd_config
# Sửa ListenAddress trong /etc/ssh/sshd_config theo IP Worker trước lệnh sau.
sshd -t
systemctl restart ssh
```

Để SSH chờ overlay sau reboot, tạo `/etc/systemd/system/ssh.service.d/zt.conf`:

```ini
[Unit]
Wants=wg-quick@zt-worker.service
After=wg-quick@zt-worker.service
```

Firewall: sao lưu ruleset, sửa bản sao của `deploy/linux/nftables-worker.conf`
cho đúng interface `zt-worker` và NIC transport (template cũ dùng `wg0`,
`enp1s0`). Kiểm tra bằng `nft -c -f <file>` trước khi cài vào cấu hình
nftables của máy riêng. Không flush hoặc chèn đè ruleset máy đang có dịch vụ.
Rule cho SSH chỉ từ Gateway trên overlay; NAT không thay thế host firewall.
Dùng IPv4/IPv6 độc lập khi kiểm, không kết luận Internet isolation từ một
lệnh ping thất bại.

Cài Agent bằng binary đã build. Các lệnh sau chạy **trong root shell**, token
đọc từ file, không nằm trong argv/history. Installer giữ `.env` khi cài lại:

```sh
read -r NODE_TOKEN < /root/worker-bundle/node.token
export NODE_TOKEN
export NODE_ID=node-linux-01 NETWORK_INTERFACE=zt-worker DISK_MOUNT_POINT=/
export GATEWAY_URL=http://10.100.0.1:3000
export ZT_AGENT_BINARY=/root/zt-agent-linux-amd64
bash agent/install.sh
unset NODE_TOKEN
systemctl daemon-reload
systemctl is-active zt-agent wg-quick@zt-worker ssh
curl --noproxy '*' -m 5 http://10.100.0.1:3000/readyz
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Với máy vật lý đổi `NODE_ID`, IP và binary arm64 nếu cần. Agent chạy bằng
`zt-agent`, không root. Service thật là `zt-agent.service`; đường cài
`/opt/zt-serverops/agent`, khác các script chuyển TV box cũ.

## 5. Đăng ký trên Gateway, sau khi có trusted PUBLIC host key

```sh
python3 deploy/scripts/register-node.py --project zt_ec2 --env-file keys/ec2.env register \
  --bundle keys/linux-worker-01 \
  --host-public-key keys/linux-worker-01/host_ed25519.pub --ssh-user ztuser
```

Làm tương tự với Windows/máy thật và bundle riêng. Không lấy pin bằng
`ssh-keyscan` trên mạng chưa tin cậy. `register` chạy lại cùng bundle + pin
sẽ giữ danh tính; nếu khác token/IP/name/type/pin hoặc đã thu hồi thì từ chối.
Không sửa host pin chỉ để bỏ qua lỗi xác thực.

## 6. Nghiệm thu và thay/gỡ máy

Ghi bằng chứng đúng môi trường, theo [checklist](../docs/ACCEPTANCE.md):

1. WireGuard có handshake mới và byte hai chiều tăng; `/readyz` xác nhận DB.
2. Dashboard thấy CPU/RAM/disk/uptime thật; Agent ACK đều theo nhịp cấu hình.
3. Admin mở Web SSH, `whoami` đúng máy; Viewer gọi trực tiếp API SSH bị chặn.
4. Thử mất/khôi phục kết nối trên node lab, đối chiếu ngưỡng thực tế từ env;
   Telegram mặc định giả lập trong lab, không tự gửi vào nhóm thật.
5. Reboot từng Worker; service tự chạy và danh tính giữ nguyên. Đo RSS thực,
   không coi ngân sách Go heap là RSS. Ghi số đo thay vì cam kết sẵn 4–12MB.
6. Từ máy ngoài độc lập thử cổng Worker, cả IPv4/IPv6 nếu có; chứng minh probe
   đến đúng host. Chưa làm thì ghi CHƯA KIỂM CHỨNG.

**Nâng Agent:** dùng cùng installer, giữ bundle/token/host key; Windows mặc
định giữ config, Linux giữ `.env`. Kiểm lại ACK và Web SSH sau thay binary.
**Thay hẳn máy:** dùng name/IP/bundle mới; không sao chép danh tính máy cũ.

**Gỡ:** đóng Web SSH đang mở; trên Gateway thu hồi token trước, gỡ đúng public
peer cả cấu hình lưu và runtime, không xóa DB/nhật ký để giữ lịch sử. Chỉ làm
trên node được chọn và sao lưu trước; không xóa khóa Gateway hoặc peer khác.
Windows dùng `restore-worker.ps1 -DedicatedVm` để khôi phục SSH/firewall theo
setup-state; Agent gỡ riêng bằng dừng/xóa `ZTServerOpsAgent` sau khi đã sao lưu
config. Linux dừng/disable `zt-agent` và đúng `wg-quick@zt-worker`, khôi phục
SSH/firewall từ bản trước khi cài, giữ console và kiểm đường quản trị rồi mới
xóa file của node. TV namespace dùng đúng lifecycle riêng đã cài; không gỡ
bằng các lệnh cho Worker Linux thông thường.

Tài liệu này mô tả quy trình; không phải bằng chứng Windows/Linux VM mới đã
được cài, reboot hoặc kiểm firewall thành công.
