# Gateway Linux + Worker Windows

Ngày20/10/2026 đã chạy Windows Server2022 Standard Evaluation Desktop Experience
(build20348.587) thật trên KVM: 2vCPU,4GiBRAM,60GiB disk. Gateway vẫn ở Linux;
Windows là Worker, không phải máy chạy toàn bộ Gateway. Phiếu ghi VMware/
VirtualBox; việc dùng KVM thay thế chưa được giảng viên xác nhận.

```text
Arch Linux
├── Docker: Gateway + PostgreSQL + Dashboard/Caddy + WireGuard 10.100.0.1
├── Worker Docker 10.100.0.2
├── Debian12 KVM node-linux-01 10.100.0.4
└── Windows Server2022 KVM node-windows-01 10.100.0.3
    └── NIC NAT → WireGuard + OpenSSH + Go Agent native
```

## Mở lại mô hình đã cài

Bật hai VM trong virt-manager, giữ NIC NAT và không thêm port forwarding.
Từ repository trên host:

```sh
python3 deploy/scripts/demo.py up
python3 deploy/scripts/demo.py doctor
```

Mở **https://localhost**, đăng nhập `demo-admin` bằng mật khẩu trong
`keys/demo-login.env`, chọn `node-windows-01` rồi **Web SSH**. Agent và SSH dùng
Automatic (Delayed Start): chờ khoảng2–3phút sau khi boot trước khi demo.
Windows chạy lệnh PowerShell/Windows, ví dụ:

```powershell
hostname
whoami
powershell -NoProfile -Command "[Environment]::OSVersion.Platform"
```

Kết quả định danh là `node-windows-01`, `node-windows-01\ztuser`, `Win32NT`.
Tài khoản Web SSH không thuộc Administrators. Tài khoản ứng dụng Admin khác tài
khoản quản trị hệ điều hành; không mở SSH quản trị trực tiếp qua NIC transport.

## Cài Worker mới

Cần Windows64-bit workgroup, PowerShell64-bit5.1+, tài khoản local `ztuser`
enabled và không thuộc Administrators. Cài
[WireGuard chính thức](https://www.wireguard.com/install/) và
[OpenSSH Server](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse).
Bản WireGuard dùng trong lượt này là1.1.1, Authenticode hợp lệ của WireGuard LLC;
OpenSSH inbox8.1.0.1. Không thêm thư viện Go hay dịch vụ phụ vào dự án.

Trên host, chuẩn bị bundle bằng CLI sẵn có. Xem `--help` trước khi đổi cấu hình;
CLI từ chối ghi đè định danh có sẵn. Ví dụ endpoint NAT của host trong lượt này:

```sh
python3 deploy/scripts/register-node.py prepare --gateway-endpoint 192.168.122.1:51820
```

`keys/windows-worker-01/` chứa token/khóa riêng, không đưa vào Git hoặc ảnh.
Lượt cài thực tế dùng bản sao riêng `keys/windows2022-deploy/`, giữ bundle gốc.
Build Windows executable và test executable từ source Agent hiện tại. Cần Go1.23+
cho đoạn dưới; lượt này đã build trong container `golang:1.27-alpine`:

```sh
cd agent
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /tmp/zt-agent-windows-amd64.exe .
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go test -c -o /tmp/zt-agent-windows.test.exe .
```

Chuyển executable thành `zt-agent.exe`, test executable thành
`zt-agent-tests.exe`; kèm `agent/install-windows.ps1` và đủ bốn script
`deploy/windows/*.ps1`. Chuyển bundle qua kênh tin cậy vào thư mục chỉ quản trị
viên được ghi. Không chép khóa riêng Gateway sang Worker.

Tại console Windows, PowerShell Administrator ở thư mục bundle:

```powershell
Get-NetAdapter
.\zt-agent-tests.exe '-test.v'
.\zt-agent.exe --validate-config --config .\agent-config.json
.\setup-worker.ps1 -DedicatedVm -TunnelConfigPath .\zt-worker.conf -GatewaySshPublicKeyPath .\bastion_id_ed25519.pub -TransportInterfaceAlias 'Ethernet'
```

Truyền đủ NIC transport thật. Setup giữ state/backup, bindSSH tại VPN`.3`, chỉ
nhận key của `ztuser` từ Gateway`.1`, tắt password/forwarding và chặn TCP22 trên
transport cảIPv4/IPv6. Script giữ những rule khác: cần rà soát riêng, không coi
chạy script xong là đã đóng toàn bộ ingress. Các profile firewall phải enabled,
default inbound Block. Không tự chạy lại khi đã có state.

Chép **chỉ SSH host PUBLIC key** qua kênh tin cậy về host:
`C:\ProgramData\ZT-ServerOps\worker\ssh_host_ed25519_key.pub`, rồi đăng ký:

```sh
python3 deploy/scripts/register-node.py register --host-public-key keys/windows-worker-01/ssh_host_ed25519_key.pub --ssh-user ztuser
```

CLI append peer riêng`.3`, giữ nodeDocker`.2` và Debian`.4`; không restart Gateway.
Không dùng `ssh-keyscan` trên đường chưa xác thực làm nguồn tin cậy ban đầu.
Trở lại console Windows:

```powershell
.\zt-agent.exe --check --config .\agent-config.json
.\install-windows.ps1 -BinaryPath .\zt-agent.exe -ConfigPath .\agent-config.json
Get-Service ZTServerOpsAgent
Get-Content 'C:\ProgramData\ZT-ServerOps\agent\logs\agent.log' -Tail 10
.\check-worker.ps1
```

`--check` chỉ lấy mẫu thật, không gửi HTTP. Service `ZTServerOpsAgent` chạy
LocalService, config/token chỉ đọc, log xoay2x1MiB. Phải có `beacon ACK` và mẫu mới
qua Gateway; chỉ thấy Running chưa chứng minh gửi được dữ liệu.
Native test có cả Win32 collector thật và HTTP loopback giả lập; không gộp hai
loại thành kiểm chứng hệ thống thật.

## Kiểm chứng và giới hạn

```sh
python3 deploy/scripts/verify-vm.py --node-name node-windows-01 --shell windows --ssh-user ztuser
```

Lệnh này thu hồi phiên demo-admin/demo-viewer. Đã đạt16/16 luồng thật trước
và sau reboot: telemetry, RBAC, SSH/PTY, audit START/END, đóng terminal và logout.
Firefox đạt7/7 kiểm tra trên dashboard thật sau reboot. Bằng chứng, kết quả reboot và giới
hạn nằm trong [log Windows](verification/windows-runtime.txt).
Ảnh thật: [dashboard](verification/windows-dashboard.png),
[Web SSH Windows](verification/windows-terminal.png).

Windows Agent đo WorkingSet khoảng46MiB: **chưa đạt mục tiêu khoảng10MB**;
WorkingSet khác private bytes và RAM toàn hệ thống. Không chứng nhận mốcRAM
500MB–1GB cho toàn mô hình. CPU cao riêng trên Windows VM và ingress từ Internet/
IPv6 độc lập **CHƯA KIỂM CHỨNG**. Không suy cross-build hoặc scanIPv4 nội bộ
thành các kết quả đó.

Checker vẫn exit1 khi liệt kê Core Networking inbound rules cần rà soát. Đã
kiểm tra từng rule, giữ các rule mạng hệ điều hành và chạy probe ứng dụng riêng;
không tắt DHCP/ND hoặc sửa checker để tạo PASS. WinRM tạm phục vụ cài đặt đã đóng.

## Hai lỗi khởi động đã gặp

- Host private key tạo dưới Administrator cá nhân có thể qua `sshd -t` với tài
  khoản đó nhưng bị LocalSystem từ chối, service thoát1067. Bộ cài chuẩn hóa
  owner sang nhóm Administrators, chỉ SYSTEM/Administrators FullControl, giữ
  nguyên bytes/fingerprint. Đã kiểm tra cùng cấu hình dưới SYSTEM trước/sau sửa.
- WireGuard service Running có thể trước lúc VPN IP sẵn sàng. Dependency riêng
  chưa đủ: OpenSSH báo `Cannot bind any address` sau reboot. Setup dùng dependency
  cùng Automatic (Delayed Start), giữ nguyên listener chỉ trên VPN.

## Hoàn tác từ console

```powershell
Stop-Service ZTServerOpsAgent
.\restore-worker.ps1
```

Restore chỉ xử lý config/service/rule/tunnel có state, giữ account/hostkeys/files;
không gỡ Agent hoặc đổi DB/peer Gateway. Đã thử phục hồi sau lỗi setup dở dang;
không tuyên bố đã thử gỡ toàn bộ cấu hình cuối cùng đang phục vụ demo.
