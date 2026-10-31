# Khôi phục sau khi cài lại laptop

Gateway, Dashboard, database và khóa hiện chạy trên **TV box**. Cài lại laptop không xóa chúng. Laptop đang chứa VM Worker, source và một số bản sao lưu riêng; Git chỉ bảo vệ phần đã commit/push.

## Trước khi xóa hệ điều hành

Chép các phần cần giữ sang ổ ngoài hoặc nơi lưu trữ riêng **không nằm trên phân vùng sắp xóa**:

- Đĩa và cấu hình hai VM nếu muốn giữ nguyên hệ điều hành, danh tính Worker và file bên trong. File tạo trong Web SSH nằm trên đĩa VM, không tự xuất hiện trong Git.
- Khóa/cấu hình riêng trong `keys/`, bundle Worker, thông tin đăng nhập và các bản sao DB nếu cần khôi phục chúng. Đây là dữ liệu riêng, không đưa vào repo.
- `.memory/` và tài liệu môn học đang giữ cục bộ nếu muốn tiếp tục công việc từ các ghi chú hiện tại. Các mục này không được Git theo dõi.
- Các bản sao lưu đã tạo khi dọn Docker: `~/.cache/zt-docker-retirement-20261031/` và, nếu còn cần bản local của dự án cờ vua, `~/.cache/gambit-supabase-local-retirement-20261031/`.

Các thư mục backup có DB/secret; giữ quyền truy cập riêng. `SHA256SUMS` đi kèm dùng để kiểm bản chép. Backup chỉ nằm trong `.cache` trên laptop sẽ mất nếu xóa phân vùng đó.

Nếu giữ VM libvirt hiện tại, tắt VM bằng shutdown trong guest trước khi sao chép đĩa. Trên laptop Linux, các lệnh sau chỉ giúp tìm đĩa và xuất cấu hình:

```sh
virsh -c qemu:///system domblklist debian12 --details
virsh -c qemu:///system domblklist windows-server-2022 --details
virsh -c qemu:///system dumpxml debian12 > debian12.xml
virsh -c qemu:///system dumpxml windows-server-2022 > windows-server-2022.xml
```

Lưu cả đĩa được liệt kê, file XML và trạng thái UEFI/TPM nếu VM sử dụng chúng; kiểm lại bản chép trước khi xóa ổ. Đổi sang hypervisor khác có thể cần chuyển định dạng đĩa, driver và tên NIC. Không coi chỉ giữ file XML là đã sao lưu VM.

## 1. Laptop mới: lấy source và gói cài

Cài Git, GitHub CLI nếu dùng lệnh tải Release, phần mềm máy ảo và Tailscale theo hệ điều hành mới. Đăng nhập Tailscale vào tailnet có quyền kết nối TV box. Địa chỉ của laptop mới có thể khác laptop cũ.

```sh
git clone https://github.com/mowfteedev/trust-me-bro.git
cd trust-me-bro
```

Source native ở `deploy/native/`; cách tải gói ARM64 từ tag `native-tvbox-20261031-r3` và kiểm checksum ở [hướng dẫn native](native/README.md). Gói đầy đủ được giữ trong GitHub Release vì runtime/dependency lớn không nằm trong Git. Mật khẩu, khóa riêng, DB và đĩa VM không có trong repo hoặc gói phát hành.

Release cũng có Agent Linux/Windows x86-64 và checksum riêng. Có thể tải cả hai bản vào thư mục mới trên laptop Linux:

```sh
gh release download native-tvbox-20261031-r3 \
  --repo mowfteedev/trust-me-bro \
  --dir worker-binaries \
  --pattern 'zt-agent-*' \
  --pattern 'AGENT-SHA256SUMS' \
  --pattern 'AGENT-BUILD.json'
```

Kiểm checksum bằng khối dừng khi lỗi:

```sh
sh -eu <<'VERIFY_AGENTS'
cd worker-binaries
sha256sum --check AGENT-SHA256SUMS
VERIFY_AGENTS
```

Linux là binary static đã kiểm cấu hình offline; Windows là bản cross-compile, chưa được kiểm chạy với Gateway TV box. Xem `AGENT-BUILD.json` để biết chính xác phạm vi.

Agent cũng có thể build từ source với Go theo `agent/go.mod`, không cần dựng lại Docker Gateway. Ví dụ chạy từ gốc repo trên máy có Go, dùng thư mục khác nếu đã tải binary ở trên:

```sh
mkdir worker-binaries
cd agent
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o ../worker-binaries/zt-agent-linux-amd64 .
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -o ../worker-binaries/zt-agent-windows-amd64.exe .
```

Đây là build cho Worker x86-64. Chọn đúng kiến trúc nếu VM khác; build thành công chưa phải kiểm chạy Windows thực tế.

## 2. TV box đang có Gateway: giữ bản cài

Không chạy lại `install.sh` để sửa laptop. Trên console/SSH của TV box hiện tại, kiểm nền bằng:

```sh
python3 /opt/zt-serverops-native/scripts/doctor.py
```

Từ laptop mới, mở Dashboard qua SSH tunnel:

```sh
ssh -o ExitOnForwardFailure=yes -N \
  -L 127.0.0.1:8443:127.0.0.1:8443 root@100.78.198.50
```

Giữ terminal mở và truy cập `https://localhost:8443` trên laptop đó. Thông tin đăng nhập nằm ở `/etc/zt-serverops-native/login.json` trên TV box; không gửi nội dung file này vào Git/chat. Nếu TV box đổi địa chỉ Tailscale, xác định lại địa chỉ trước khi dùng lệnh.

Gateway hiện có bốn dịch vụ `zt-native-*` được enable cùng máy; điều này không tự bật VM trên laptop. Cài lại laptop cũng cần cấu hình lại việc khởi động VM nếu muốn dùng autostart.

## 3. Hai VM: khôi phục bản cũ hoặc dựng Worker mới

### Giữ được đĩa VM cũ

Import VM với cấu hình phù hợp, giữ đĩa chứa khóa WireGuard, token Agent, SSH host key và file người dùng. Kiểm lại NIC/firewall và đường tới TV box trước khi sửa config.

Debian đã chuyển thành công có `wg0`, IP VPN `10.100.0.4`, Agent dùng `/opt/zt-serverops/agent/tvbox-config.json` qua drop-in `30-tvbox.conf`. Không chạy lại script migrate nếu bản sao `/root/zt-before-tvbox` đã có. Bản sao này là cấu hình trước chuyển; Gateway Docker cũ đã được dọn, nên khôi phục profile cũ không tự làm Gateway cũ chạy lại.

Windows VM cũ chưa chuyển sang Gateway TV box; giữ được VM không có nghĩa nó đã dùng Gateway mới.

### Dựng hai VM mới

Hai VM chỉ là Worker; Dashboard và PostgreSQL tiếp tục ở TV box. Dùng NAT không có inbound port forwarding, rồi kiểm đường tới `100.78.198.50:51820`. Cách cho VM đi qua Tailscale của host phụ thuộc hệ điều hành/hypervisor và routing/NAT của host; không mặc định chỉ bật Tailscale trên host là mọi VM đều đi được. Không cần mở SSH ra LAN/Internet để cấu hình Worker: dùng console của VM.

Mỗi VM mới là một danh tính mới: khóa WireGuard, token và SSH host key riêng. Chọn tên/IP VPN chưa dùng; `.5` cho Linux và `.6` cho Windows chỉ là ví dụ, không phải địa chỉ đã được đặt trước. Worker cũ có thể còn là bản ghi Offline trên Gateway; không ghi đè khóa hoặc xóa dữ liệu node cũ chỉ để vượt lỗi trùng danh tính.

| Thành phần | Debian 12 mới | Windows Server 2022 mới |
|---|---|---|
| Kết nối VPN | WireGuard | WireGuard chính thức |
| Thu số liệu | Agent Linux | Agent Windows |
| Web SSH | OpenSSH Server, user thường `ztuser` | OpenSSH Server, user thường `ztuser` |
| Cấu hình riêng | Bundle tạo trên TV box | Bundle khác tạo trên TV box |

Trong bundle dùng endpoint TV box `100.78.198.50:51820`, API `http://10.100.0.1:3100`, MTU 1200. Dùng tên interface thống nhất giữa WireGuard, Agent và firewall.

Với Debian mới, cài WireGuard/OpenSSH Server, đặt binary Agent và cấu hình service, tạo user Agent cùng user SSH `ztuser` không có sudo. SSH chỉ nhận từ Gateway `10.100.0.1` qua interface VPN; chỉ cho key của Bastion, giữ host key Ed25519 và locale UTF-8. `deploy/linux/nftables-worker.conf` và `sshd-worker.conf` là mẫu cũ có địa chỉ/interface cụ thể, cần đối chiếu với bundle mới. **`deploy/linux/migrate-to-tvbox.py` không cài được một VM trắng**: nó chỉ chuyển Debian cũ đã có Agent/SSH/WireGuard của mô hình trước.

Với Windows mới, source Agent và các script `deploy/windows/setup-worker.ps1`, `check-worker.ps1`, `restore-worker.ps1` đã có. Installer cần WireGuard, OpenSSH Server và user `ztuser` không thuộc Administrators. Bộ kiểm tra Windows hiện còn kiểm API **3000**; phải đồng bộ về API **3100** trước khi dùng với Gateway native. Việc chạy Windows với Gateway TV box vẫn **CHƯA KIỂM CHỨNG**; không coi kết quả Windows với Gateway Docker cũ là nghiệm thu cho mô hình mới.

## 4. Đăng ký và kiểm từng Worker

Trên TV box, dùng `register-worker.py prepare` để tạo một bundle mới cho từng VM; xem [ví dụ Linux](native/README.md#đăng-ký-worker-mới). Chuyển bundle qua kênh riêng, không đưa token/khóa lên Git. Cấu hình Worker theo OS và lấy public host key Ed25519 từ console VM qua kênh tin cậy.

Trên TV box, đăng ký đúng bundle và host pin bằng `register-worker.py register`. Trên Debian Worker, kiểm API bên trong VPN:

```sh
curl --noproxy '*' -m 5 http://10.100.0.1:3100/readyz
```

Trên Windows Worker, dùng PowerShell:

```powershell
Invoke-RestMethod -Uri 'http://10.100.0.1:3100/readyz' -TimeoutSec 5
```

Trên TV box, sau khi Agent kết nối:

```sh
python3 /opt/zt-serverops-native/scripts/doctor.py --require-worker
```

Kiểm Dashboard Online, số liệu cập nhật và Web SSH. Trong terminal Web SSH, `whoami` cần là `ztuser`, `hostname` phải đúng VM đang thử. Sau đó mới kiểm phân quyền Viewer, logout, audit và cảnh báo. Chỉ mở rộng sang VM thứ hai khi VM đầu đã kết nối và có bằng chứng đúng.

Không cần cài Docker Gateway trên laptop để tiếp tục mô hình TV box. Không chạy `make up` hoặc `demo.py up` chỉ để mở Dashboard: các lệnh đó sẽ tạo lại cụm Docker cũ trên laptop.
