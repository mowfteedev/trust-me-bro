# Gateway Linux + Worker Windows VM

**CHƯA KIỂM CHỨNG trên Windows thật.** Hiện không có VMware/VirtualBox hoặc guest
image. Agent đã cross-build; script được PowerShell parser và một số guard trên
Linux kiểm tra. Các bước dưới là trình tự cần chạy trong guest, chưa được nghiệm
thu Win32/SCM/ACL/firewall/SSH/reboot/RAM. Không dùng WSL làm bằng chứng Windows.

```text
Máy Arch Linux hiện tại
├── Docker: Gateway + DB + Dashboard/Caddy + WireGuard (10.100.0.1)
├── Worker Docker cũ: 10.100.0.2, giữ nguyên
└── VMware/VirtualBox: Windows VM, NIC NAT, không port forwarding
    └── WireGuard + OpenSSH + Mini-Agent: 10.100.0.3
```

## Chuẩn bị

- Windows64-bit, PowerShell64-bit5.1+, VM workgroup chuyên dụng. Cài
  [WireGuard chính thức](https://www.wireguard.com/install/) và
  [OpenSSH Server](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse).
  Chưa chạy cài hypervisor/OS/capability trong phiên này.
- Có tài khoản local `ztuser`, enabled, không thuộc Administrators. SSH chỉ dùng
  key; mật khẩu local giữ riêng. `BASTION_DEFAULT_USER` Gateway mặc định là `ztuser`.
- NIC dùng NAT, không forward cổng Worker. Biết đủ tên NIC transport thật từ
  `Get-NetAdapter`. Firewall profiles enabled/default inbound Block, NIC không
  được miễn firewall. Thực hiện bộ cài từ console VM có quyền quản trị.
- Endpoint WireGuard là IPv4 của host Arch mà VM truy cập được, cổngUDP51820.
  Tên Docker `gateway` và localhost của guest không phải endpoint của host.
  Script không sửa firewall host/router hoặc mở PostgreSQL/Fastify ra Internet.

## Bundle trên Gateway

`register-node.py --help` và `prepare --help` đã chạy. Ví dụ tạo bundle, thay
endpoint bằng IP thật:

```sh
python3 deploy/scripts/register-node.py prepare --gateway-endpoint 192.168.1.10:51820
```

Phiên này đã tạo thật `keys/windows-worker-01/` bằng khóa riêng mới, endpoint LAN
hiện tại; chưa xác nhận guest truy cập được. Mode thư mục0700/tệp0600; chạy lại
từ chối ghi đè. **Không đổi DB hoặc peer Gateway.** Bundle chứa token, config
Agent, `zt-worker.conf`, metadata và public key Bastion. Bản local còn có exe,
test exe, script và `SHA256SUMS.txt`. Chuyển nguyên bundle qua kênh tin cậy; không
đưa vào Git/chat/ảnh hoặc chép private Gateway key sang Worker.

Nếu build lại, lệnh đã chạy trên Linux:

```sh
cd agent
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /tmp/zt-agent-windows-amd64.exe .
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go test -c -o /tmp/zt-agent-windows.test.exe .
```

Chép executable thành `zt-agent.exe`, test exe thành `zt-agent-tests.exe`, cùng
`agent/install-windows.ps1` và đủ bốn script `deploy/windows/*.ps1` vào bundle.
arm64 cũng cross-build được; chọn đúng kiến trúc guest. Cross-build không phải
PASS native Windows.

## Trong guest — các lệnh chưa chạy Windows

Mở PowerShell64-bit có quyền quản trị ở thư mục bundle, cho phép chạy script
local đã xem xét theo policy của VM. Thay `Ethernet` bằng tên NIC thật, truyền
đủ danh sách nếu nhiều NIC:

```powershell
Get-NetAdapter
.\zt-agent-tests.exe -test.v
.\zt-agent.exe --validate-config --config .\agent-config.json
.\setup-worker.ps1 -DedicatedVm -TunnelConfigPath .\zt-worker.conf -GatewaySshPublicKeyPath .\bastion_id_ed25519.pub -TransportInterfaceAlias 'Ethernet'
```

Test executable có ca gọi Win32 collector thật và các ca HTTP loopback giả lập;
phải phân biệt hai loại kết quả. Nó không tự cấu hình SSH/firewall/service.
Setup giữ backup/state, cài tunnel `zt-worker`, bind SSH ở `.3`, chỉ nhận `ztuser`
từ Gateway `.1` bằng khóa, tắt password/forwarding. Nó chỉ tạo hai rule ZT: cho
SSH qua VPN và chặn TCP22 qua NIC transport cả IPv4/IPv6; giữ rule khác. `sshd`
phụ thuộc tunnel để có IP khi boot. Guard từ chối junction/reparse, owner hoặc
state không tin cậy; lần setup sau không ghi đè state cũ.

Chép **chỉ host PUBLIC key** về Gateway qua console/shared folder tin cậy:
`C:\ProgramData\ZT-ServerOps\worker\ssh_host_ed25519_key.pub`.
Không lấy fingerprint từ `ssh-keyscan` trên đường chưa xác thực.

Trên Gateway, dùng đường dẫn public key đã chép về:

```sh
python3 deploy/scripts/register-node.py register --host-public-key keys/windows-worker-01/ssh_host_ed25519_key.pub
```

CLI dùng stdin qua one-shot migrator, chặn trùng name/IP/token/fingerprint;
append/apply peer `.3` không restart Gateway. Backup private Gateway nằm ngoài
Worker bundle. **Chưa register Windows thật** vì chưa có host key guest; kiểm tra
CLI idempotence/xung đột đã chạy trên PostgreSQL thật trong DB tạm.

Trở lại Windows:

```powershell
.\zt-agent.exe --check --config .\agent-config.json
.\install-windows.ps1 -BinaryPath .\zt-agent.exe -ConfigPath .\agent-config.json
Get-Content 'C:\ProgramData\ZT-ServerOps\agent\logs\agent.log' -Tail 20
.\check-worker.ps1
```

`--check` lấy một mẫu thật, không gửi HTTP. Service `ZTServerOpsAgent` chạy
LocalService, config/token chỉ đọc, log xoay2x1MiB. Cài lại giữ config trừ khi
dùng `-UpdateConfig`. LocalService là identity dùng chung, không bảo vệ trước
admin hoặc mọi service cùng identity. Xác nhận `beacon ACK` và mẫu mới trên
dashboard; `Running` chưa chứng minh đã gửi được dữ liệu.

Disk Windows dùng total/available theo tài khoản API, có xét NTFS quota. RX/TX
là byte tích lũy trên tunnel được chọn, uptime thuộc Windows; bỏ Linux load_avg.
Checker đọc listener, service, cấu hình sshd hiệu lực, scope firewall, Gateway và
WorkingSet Agent. Rule Windows khác có thể khiến exit1; phải xem từng mục, không
tắt mù rule mạng cần thiết. Kết quả local không chứng nhận Zero Inbound Internet.

## Kiểm chứng trước demo

Sau khi VM có heartbeat thật:

```sh
python3 deploy/scripts/verify-vm.py --node-name node-windows-01 --shell windows
```

Lệnh đợi nodeVM Online, kiểm tra telemetry/Admin/Viewer, chạy PowerShell và nhận
marker `Win32NT`, audit START/END, logout đóng SSH và thu hồi JWT. **Nó đăng xuất
demo-admin/demo-viewer trên Gateway được chọn.** Nhánh Windows chưa chạy; nhánh
Linux đã kiểm tra trên Docker thật. Không đổi nhãn node Docker thànhVM để tạo PASS.

Ghi thêm bằng chứng VM/hypervisor vào `docs/verification/`:

1. NIC/NAT không port forwarding; handshake khác0, transfer tăng.
2. Đối chiếu năm nhóm số liệu với Windows, heartbeat3s.
3. SSH qua dashboard hoạt động; từ máy độc lập ngoài VPN phải bị chặn. Kiểm tra
   IPv6 và Internet nếu tuyên bố đóng Internet ingress; local scan chưa đủ.
4. Dừng Agent: Stale/Offline15–45s, một incident/Telegram; bật lại Online/resolve.
   Thử CPU với tải/ngưỡng thật, không gọi payload99% giả lập là CPU vật lý.
5. Reboot: tunnel/sshd/Agent tự lên và có ACK mới. Đo RAM Agent/cụm dịch vụ;
   RAM Windows OS/hypervisor ghi riêng, không tăng RAM chỉ để lấp mốc500MB.

Mục chưa chạy giữ **CHƯA KIỂM CHỨNG**. Không xuất private keys/token/password,
OTP/chatID hoặc `wg showconf` trong bằng chứng.

## Hoàn tác trong guest — chưa chạy Windows

```powershell
Stop-Service ZTServerOpsAgent
.\restore-worker.ps1
```

Restore khôi phục sshd và gỡ đúng rule/tunnel từ state có đường dẫn cố định.
Giữ account/host keys/files; không xóa Agent service hoặc đổi DB/peer Gateway.
Chạy từ console; không dùng để hoàn tác cấu hình của máy khác.
