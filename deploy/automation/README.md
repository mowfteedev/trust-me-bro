# Cài Gateway và ghép Worker

Một Gateway, PostgreSQL hiện có và nhiều Worker. Không có database tổng.
Bộ cài dành cho máy mới/máy lab riêng; không tự tiếp quản bản cài cũ chưa có
journal automation. Không chạy bộ cài mới lên EC2/TV đang phục vụ để cập nhật.

## Chuẩn bị

Gateway: Linux amd64/arm64, quyền root, Python3, Docker Compose v2,
OpenSSL, ssh-keygen và kernel WireGuard. RAM vật lý tối thiểu512MiB là điều
kiện kiểm đầu vào, không phải cam kết chạy ổn trên máy512MiB.

Build trên máy phát triển, chuyển source và image sang Gateway nếu cần:

```sh
docker build -t zt-serverops-gateway:automation-local gateway
docker build -t zt-serverops-proxy:automation-local -f deploy/proxy/Dockerfile .
docker build -t zt-serverops-wireguard:automation-local deploy/wireguard
docker pull postgres:16-alpine
```

Có thể dùng `--build` khi cài nếu máy đủ tài nguyên. Không cần Node/Go trên
máy chạy Gateway khi đã có image. Worker cần binary Agent đúng kiến trúc,
SHA256 lấy từ nguồn tin cậy; build theo [hướng dẫn](../HD-THEM-MAY-CHU.md).
Worker không cần Docker hoặc trình biên dịch.

## Gateway

Hostname HTTPS phải được cấu hình chuyển tới Caddy của đúng Gateway này;
UDP endpoint phải tới WireGuard. Bộ cài không tự tạo Cloudflare, sửa SG hay
router. Với CA nội bộ dùng `--ca-file /path/ca.crt`, không tắt xác minh TLS.

```sh
sudo python3 deploy/automation/gateway.py preflight
sudo python3 deploy/automation/gateway.py install \
  --endpoint 192.0.2.10:51820 --public-url https://gateway.example.com
sudo python3 deploy/automation/gateway.py check
```

Mật khẩu Admin được nhập ẩn; mặc định chỉ lưu scrypt+salt trong PostgreSQL,
không tạo `demo-login.env` hay file mật khẩu Admin rõ. Automation qua pipe
có thể dùng `--password-stdin`, JSON chỉ chứa `password`; không truyền qua argv.
Database password/secret dịch vụ vẫn cần file riêng `keys/automation.env`0600.

Journal giữ tiến độ; chạy lại cùng lệnh giữ khóa, DB và mật khẩu đã đổi.
Sau lỗi HTTPS, sửa đường truy cập/chứng chỉ rồi chạy lại, không xóa keys/volume.
`check` đối chiếu public Gateway ID qua HTTPS, core và collector; chưa chứng
minh Worker hoặc Internet firewall khi chưa có Worker tham gia.

Cấp file ghép riêng cho mỗi máy, mặc định15phút:

```sh
sudo install -d -m 700 /root/worker-invites
sudo python3 deploy/automation/gateway.py invite \
  --node-name node-linux-01 --worker-os linux --node-type VM \
  --output /root/worker-invites/node-linux-01.json
sudo python3 deploy/automation/gateway.py revoke --invitation-id INVITATION_UUID
```

File0600 chứa public identity/endpoint và mã ghép một lần; chuyển riêng đúng
máy. PostgreSQL chỉ lưu hash mã. Thu hồi mã ngăn claim/retry, không tự thu hồi
token hay gỡ VPN của Worker đã hoạt động. Không gửi file ghép lên Git/chat.

## Worker Linux

Debian/Ubuntu amd64/arm64, systemd, root tại console. Bộ cài có thể cài các
gói WireGuard/OpenSSH/nftables còn thiếu. Phải đọc preflight trước khi dùng
`--dedicated-worker`: bước này giới hạn SSH của máy vào VPN và áp dụng bảng
firewall riêng. Cấu hình cũ được sao lưu, không flush toàn bộ ruleset.

```sh
sudo python3 deploy/automation/worker.py check \
  --invite /root/node-linux-01.json --agent-binary /root/zt-agent \
  --agent-sha256 TRUSTED_SHA256
sudo python3 deploy/automation/worker.py install \
  --invite /root/node-linux-01.json --agent-binary /root/zt-agent \
  --agent-sha256 TRUSTED_SHA256 --dedicated-worker
sudo python3 deploy/automation/worker.py status --invite /root/node-linux-01.json
```

Thêm `--ca-file` cho CA nội bộ. Không cài từ phiên SSH sẽ bị thay cấu hình.
Khóa/token Worker tạo tại máy, lưu riêng trước claim; cùng file và danh tính
được thử lại nếu mất phản hồi. Bản đã consume được replay đúng payload sau
hạn, không thể dùng mã đó đăng ký máy khác. Không tạo lại host key bị mất.
`ok=true` yêu cầu VPN, API, service, listener/firewall và Gateway xác nhận
peer/heartbeat/SSH ghim host key. `status` không có invite chỉ kiểm cục bộ.

## Worker Windows

PowerShell5.1+, Windows amd64, console quản trị và NIC transport đúng tên.
Dùng `--worker-os windows` khi cấp invite, binary Windows và SHA256 riêng.

```powershell
.\deploy\automation\worker.ps1 -Action check `
  -InvitationPath C:\staging\node-windows-01.json `
  -AgentBinaryPath C:\staging\zt-agent.exe -AgentSHA256 TRUSTED_SHA256 `
  -TransportInterfaceAlias Ethernet
.\deploy\automation\worker.ps1 -Action install -DedicatedWorker `
  -InvitationPath C:\staging\node-windows-01.json `
  -AgentBinaryPath C:\staging\zt-agent.exe -AgentSHA256 TRUSTED_SHA256 `
  -TransportInterfaceAlias Ethernet
```

File invite cần ACL chỉ cho tài khoản cài/SYSTEM/Administrators. Có tùy chọn
`-InstallPrerequisites` cho OpenSSH; WireGuard dùng bản chính thức đã cài hoặc
MSI cục bộ kèm SHA256 qua `-WireGuardInstallerPath/-WireGuardInstallerSHA256`.
Không tự tải/chạy executable chưa kiểm. CA nội bộ dùng `-CaFile`.

## Lưu ý vận hành

Enrollment mặc định tắt; overlay `compose.enrollment.yml` chỉ bật cho bản cài
automation. Gateway không được cấp Docker socket/NET_ADMIN. Helper WireGuard
nhận public key/IP `/32` qua thư mục riêng và giữ các peer có sẵn.

Peer mới được lưu trong `keys/enrollment/requests/UUID.peer` để replay sau
restart. Khi gỡ Worker, phải thu hồi token và gỡ đúng request, ACK/error rồi
gỡ peer runtime; chỉ `wg set ... remove` sẽ bị helper thêm lại. Không xóa DB
hoặc nhật ký để gỡ máy. Sao lưu các request này cùng cấu hình/DB.

Phân biệt kiểm source/giả lập với runtime thực. Kiểm Windows service/firewall
trên Windows thật và probe Internet độc lập vẫn cần bằng chứng riêng.
