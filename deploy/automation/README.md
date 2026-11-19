# Cài Gateway và ghép Worker

Một Gateway, PostgreSQL hiện có và nhiều Worker. Không có database tổng.
Bộ cài dành cho máy mới/máy lab riêng (native OS hoặc VM); không tự tiếp quản bản cài cũ chưa có
journal automation. Không chạy bộ cài mới lên EC2/TV đang phục vụ để cập nhật.
Không dùng bộ cài native này để chạy trực tiếp bên trong container Docker Worker thông thường
(vốn không có systemd init và không trực tiếp quản lý kernel network/firewall của host).

## Chuẩn bị

Gateway: Linux amd64/arm64, quyền root, Python3, Docker Compose v2,
OpenSSL, ssh-keygen và kernel WireGuard. RAM vật lý tối thiểu 512MiB là điều
kiện kiểm đầu vào, không phải cam kết chạy ổn trên máy 512MiB.

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
Database password/secret dịch vụ vẫn cần file riêng `keys/automation.env` 0600.

Journal giữ tiến độ; chạy lại cùng lệnh giữ khóa, DB và mật khẩu đã đổi.
Sau lỗi HTTPS, sửa đường truy cập/chứng chỉ rồi chạy lại; khắc phục lỗi theo journal,
tuyệt đối không xóa keys/DB/volume để né lỗi.
`check` đối chiếu public Gateway ID qua HTTPS, core và collector; chưa chứng
minh Worker hoặc Internet firewall khi chưa có Worker tham gia.

Cấp file ghép riêng cho mỗi máy, mặc định 15 phút:

```sh
sudo install -d -m 700 /root/worker-invites
sudo python3 deploy/automation/gateway.py invite \
  --node-name node-linux-01 --worker-os linux --node-type VM \
  --output /root/worker-invites/node-linux-01.json
sudo python3 deploy/automation/gateway.py revoke --invitation-id INVITATION_UUID
```

> [!NOTE] Thao tác trên Gateway EC2 hiện hữu (Cụm đang vận hành)
> Khi tạo lời mời hoặc kiểm tra trên cụm EC2 hiện có (`zt_ec2`), bắt buộc truyền cờ project và env-file cụ thể:
> ```sh
> python3 deploy/automation/gateway.py invite \
>   --project zt_ec2 --env-file keys/ec2.env \
>   --node-name node-linux-01 --worker-os linux --node-type VM \
>   --output keys/invitations/node-linux-01.json
> ```
> Lưu ý:
> 1. `ENROLLMENT_PUBLIC_URL` trong `keys/ec2.env` phải là origin HTTPS công khai đã được xác minh (ví dụ: `https://zt-dashboard.mowftee.workers.dev`), không trỏ về loopback nếu Worker kết nối từ Internet.
> 2. Do `wireguard_gateway` chia sẻ namespace mạng (`network_mode: service:gateway`), khi container `gateway` được recreate, cần chạy `docker compose -p zt_ec2 --env-file keys/ec2.env up -d wireguard_gateway` để gắn lại namespace mạng.

**Quy chế bảo mật và cơ chế cấp IP:**
- Clone repo **chưa tạo lời mời và chưa đăng ký bất kỳ Worker nào**.
- Lệnh `gateway.py invite` chỉ tạo file lời mời kèm mã token một lần ngắn hạn; **IP WireGuard chưa được cấp tại thời điểm tạo lời mời**, mà chỉ được Gateway cấp phát tự động trong quá trình Worker claim/đăng ký thành công.
- File lời mời đặt quyền `0600` (chỉ root/Admin đọc), chứa public identity/endpoint và mã ghép một lần. Quản trị viên chuyển file sang máy Worker qua kênh truyền bảo mật riêng (ví dụ: SCP, USB nội bộ); **tuyệt đối KHÔNG sao chép AWS private key (`.pem`/`.key`) hoặc secret của EC2 sang Worker**.
- PostgreSQL chỉ lưu hash mã mời. Thu hồi mã ngăn claim/retry, không tự thu hồi token hay gỡ VPN của Worker đã hoạt động. Không gửi file ghép lên Git/chat.

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

## Thu hồi và gỡ Worker (Offboarding)

Quy trình thu hồi gồm hai giai đoạn: xác nhận trên Gateway và gỡ bỏ cục bộ trên máy Worker.

### 1. Thu hồi quyền trên Gateway / Dashboard

Quản trị viên (Admin) nhập chính xác tên node (`confirm_node_name`) trên giao diện hoặc API để bắt đầu. Hệ thống chuyển trạng thái sang `RETIRING` rồi `REVOKED`, hủy vé SSH và tạo yêu cầu gỡ peer WireGuard:
- Tài khoản Viewer chỉ có quyền xem tiến độ và lịch sử, không thể bắt đầu thu hồi.
- Tải tệp ủy quyền riêng tư (capability bundle JSON `offboarding-NODE_NAME.json`).
- Worker không cần mật khẩu Dashboard hay Agent token.
- **Bảo mật capability bundle:** Tệp chứa bí mật (cleanup token dùng một lần); tuyệt đối **không đưa vào Git hoặc đính kèm log**. Tải lại tệp sẽ tự động xoay vòng (rotate) và vô hiệu hóa token cũ. Chuyển tệp an toàn tới Worker và xóa bỏ sau khi hoàn tất.
- Quyền tệp ủy quyền: đặt `0600` (root) trên Linux hoặc ACL `SYSTEM / Administrators` trên Windows.

### 2. Gỡ bỏ cục bộ trên máy Worker

Thực hiện tại console máy chủ vật lý hoặc console máy ảo (root trên Linux, Administrator trên Windows); **không chạy qua phiên SSH mạng bị gỡ**:

Linux:
```sh
# Gỡ bỏ dịch vụ và cấu hình
sudo python3 deploy/automation/worker.py uninstall \
  --authorization /root/offboarding-node-linux-01.json \
  --ca-file /path/ca.crt

# Thử lại nếu gặp lỗi gián đoạn hoặc cần dọn tiếp
sudo python3 deploy/automation/worker.py cleanup-retry \
  --authorization /root/offboarding-node-linux-01.json \
  --ca-file /path/ca.crt
```

Windows (PowerShell console Administrator):
```powershell
# Gỡ bỏ dịch vụ và cấu hình
.\deploy\automation\worker.ps1 -Action uninstall `
  -AuthorizationPath C:\staging\offboarding-node-windows-01.json `
  -CaFile C:\staging\ca.crt

# Thử lại nếu gặp lỗi gián đoạn hoặc cần dọn tiếp
.\deploy\automation\worker.ps1 -Action cleanup-retry `
  -AuthorizationPath C:\staging\offboarding-node-windows-01.json `
  -CaFile C:\staging\ca.crt
```

### 3. Nguyên tắc vận hành và an toàn dữ liệu

- **Trạng thái Worker offline:** Máy Worker tắt nguồn hoặc ngắt mạng vẫn duy trì trạng thái thu hồi trên Gateway (`PENDING_LOCAL_CLEANUP`) chờ dọn dẹp cục bộ khi bật lại.
- **Giải phóng IP và tên máy:** Tên và IP chỉ được giải phóng cấp phát sau khi tiến trình WireGuard root ghi nhận ACK gỡ bỏ peer (`keys/enrollment/requests/UUID.remove`).
- **Lưu trữ lịch sử:** Lịch sử node và audit log được giữ nguyên vĩnh viễn trong CSDL; token và khóa WireGuard cũ không bao giờ được tái sử dụng.
- **Cài đặt lại:** Cần cấp tệp mời mới (`invite`), không tái sử dụng danh tính cũ.
- **Bảo vệ tài nguyên host:** Bộ gỡ bảo toàn khóa SSH của OS, tài khoản người dùng, dữ liệu và ứng dụng chia sẻ khác; không thực hiện xóa diện rộng (`no broad delete`). Bản cài cũ không có journal automation sẽ từ chối tự gỡ và yêu cầu rà soát thủ công (`manual review`), không force-ack. Nếu tệp hoặc cấu hình do bộ cài quản lý bị chỉnh sửa ngoài dự kiến, hoặc thiếu quyền sở hữu (ownership), bước tương ứng sẽ dừng lại và chuyển sang trạng thái `REVIEW` / `NEEDS_REVIEW` để quản trị viên can thiệp thủ công; bộ gỡ không tự ý xóa đè và không khẳng định khôi phục nguyên vẹn 100% mọi cấu hình máy chủ trong mọi ca.
- **Ranh giới bằng chứng:** Trạng thái `COMPLETED` / `REMOVED` chỉ thể hiện biên bản báo cáo (receipt claim) do Worker gửi về; máy chủ Gateway không thể tự kiểm chứng độc lập hệ thống tệp cục bộ trên Worker. Bằng chứng kiểm thử máy ảo (native VM) được xác minh và lưu trữ độc lập.

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
