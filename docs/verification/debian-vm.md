# Kiểm chứng Debian 12 VM — 20/10/2026

Đã cấu hình và chạy trên guest thật `debian12`, KVM/libvirt trên máy Arch Linux
của chủ dự án; source ứng dụng ở `19b923f`, nhánh `minh-thanh`. Gateway tiếp tục
chạy Compose `zt_demo`; không đổi stack hoặc sửa giao diện. Guest có 2 vCPU,
1536 MiB RAM cấp phát, disk 15 GiB, Debian12/kernel6.1.0-54-amd64.

| Yêu cầu | Kết quả thực tế | Bằng chứng | Giới hạn còn lại |
|---|---|---|---|
| VM và Docker đồng thời | Debian `node-linux-01` `.4` và Docker `node-worker-01` `.2` đều Online | libvirt XML, DB và ảnh dashboard | Phiếu ghi VMware/VirtualBox; KVM chưa được xác nhận thay thế |
| WireGuard M2M | Handshake khác0, transfer tăng, API `.1:3000` truy cập được từ VM | `wg show` và ACK thật trong log | Không chuyển Gateway sang VM |
| SSH Ed25519, key400 | Host key ghim, Bastion/host/setup private key400; shell `ztuser` không sudo | Trusted guest-agent fingerprint trùng SSH; runtime/ảnh terminal | Tài khoản `linux` giữ quyền sudo để quản trị qua VPN |
| Zero Inbound Worker | SSH chỉ nghe `.4:22`, input/forward DROP; transport `.233` ports22/80/3000 timeout từ host | `sshd -T`, `ss`, nft rules và probe thật | Internet độc lập và probe IPv6 từ máy khác **CHƯA KIỂM CHỨNG** |
| Auth, ADMIN/VIEWER, Web SSH/PTY, audit, logout | 16/16 kiểm tra thật trước reboot và 16/16 sau reboot | `debian-runtime.txt` | Đây là cùng16luồng chạy hai lần, không phải32trường hợp độc lập |
| Dashboard và terminal trong browser | 7/7 Firefox158 kiểm tra thật; CPU/RAM/disk của guest, chạy hostname/whoami/uname qua SSH | `debian-browser.json` và haiảnh bên dưới | Không thay đổi UI trong lượt này |
| Heartbeat3s | 11 khoảng mới nhất:3,017782–3,041880s, median3,020227s | SQL chỉ đọc `metrics_history` | Jitter0.0, không benchmark |
| Stale/Offline và phục hồi | Tuổi heartbeat16,596s/31,674s; bật lại vềHEALTHY, đúng1incident resolved | Dừng serviceAgent thật, DB thật; không chèn metric giả | Không thử tắt cả Gateway |
| Telegram khi Offline | Một Telegram API acknowledgement cho `node-linux-01` | Log `[TELEGRAM SENT]` sau sự cố thật | Không xác nhận người nhận đã đọc; chưa tạo tảiCPU riêng trên VM |
| Systemd/reboot | Boot ID thay đổi; WG, Agent, SSH, nftables đều active+enabled, SSH quaVPN hoạt động lại | Boot ID và trạng thái sau reboot; runtime chạy lại đạt16/16 | Chưa thử nativeWindows |
| RAM Agent khoảng10MB | 10924KiB RSS trong6mẫu/10s =10,67MiB≈11,19MB | `ps -C zt-agent` trong guest | Nhỉnh mục tiêu≈10MB; không phải hardcap hoặc số đo toàn bộVM |

Guest `free -k` sau reboot: tổngRAM hệ điều hành nhìn thấy1498036KiB, dùng244076KiB
(≈238MiB), available1253960KiB. RAM cấp phát1536MiB không phải lượngRAM đang dùng.
Chưa đo đủ ngân sách **toàn mô hình500MB–1GB** gồm hostOS/Docker daemon/hypervisor;
không cộng vài snapshot rồi coi là nghiệm thu yêu cầu này.

## Cấu hình và cách kiểm tra

Hướng dẫn dùng/setup đã thực hiện ở [Debian Worker](../DEBIAN_WORKER.md), cấu hình
không chứa bí mật ở [SSH](../../deploy/linux/sshd-worker.conf) và
[nftables](../../deploy/linux/nftables-worker.conf). Hai cấu hình đã được kiểm tra
bằng `sshd -t`/`nft -c -f` trong chính Debian. ServiceAgent vàSSH phụ thuộc
`wg-quick@wg0` để có IPVPN trước khi chạy; không cài compiler vào guest.

```sh
python3 deploy/scripts/verify-vm.py --node-name node-linux-01 --shell linux
python3 deploy/scripts/demo.py doctor
```

Verify thu hồi phiên demo-admin/demo-viewer; đã thông báo trước khi chạy.
Doctor cuối lượt trả0, thấy cả hai node có heartbeat, handshake và SSH banner.
Không build lại ứng dụng vì mã Gateway/Dashboard/Agent không đổi; dùng binary
Linux từ đúng Worker image hiện tại, đã chạy trực tiếp trên guest.

Lượt browser đầu dừng ở loginViewer do script thử nối tên vào username cũ
(`demo-admindemo-viewer`). Đã sửa thao tác clear input trong harness ngoài repo,
chạy lại đủ7kiểm tra thành công; source ứng dụng không thay đổi. Giữ log và ảnh
lỗi đầu trong cache, không tính lượt đó là đạt.

## Bằng chứng

- [Log API/SSH, boot, firewall, RSS, liveness và Telegram](debian-runtime.txt).
- [Kết quả browser](debian-browser.json).
- [Dashboard với VM thật](debian-dashboard.png).
- [Terminal Debian thật trong browser](debian-terminal.png).

Rawcache cục bộ: `/home/mowftee/.cache/zt-debian12-20261019T192950Z/`.
15kiểm tra bảo toàn đều khớp:8tệp báo cáo có sẵn, env/login/khóa, hash tài khoản/
mật khẩu/quyền và phần cấu hình WG cũ. Gateway WG chỉ nối thêm peer `.4`; backup
quyền600 trùng hash ban đầu. DB thêm node/telemetry/audit/sự cố thật; sessionversion
thay đổi theo các lần logout đã kiểm tra, không xoay mật khẩu hoặc token cũ.
Các tệp staging do lượtsetup tạo trong guest đã dọn; không lưu mật khẩu VM,
token, chatID hoặc private key trong bằng chứng/Git. Không push trong lượt này.

## Nghiệm thu tài khoản Web SSH riêng — 20/10/2026

Chốt **`ztuser`** cho Web SSH trên Debian, `linux` giữ vai trò quản trị. Migration 009
thêm SSH account tùy chọn theo node, NULL giữ mặc định; CLI chỉ cập nhật sau khi
khớp định danh/token/host pin. Không có bộ đồng bộ tệp hoặc lựa chọn user từ browser.
READY gửi tài khoản đã cấu hình; terminal hiện `ztuser@node-linux-01`.

| Kiểm tra | Kết quả / bằng chứng |
|---|---|
| API/auth/RBAC/telemetry/SSH/PTY/audit/logout trên VM | 16/16 đạt, username trong READY và kết quả whoami đều là ztuser |
| Browser Firefox 158 | 8/8 đạt: user/header, cùng a.txt, ghi hai chiều, mobile 375px, Docker và không có lỗi JavaScript |
| Đối chiếu tệp | Cùng `/home/ztuser/a.txt` cho cùng SHA256 qua Web SSH và lệnh console chạy dưới ztuser |
| Ghi hai chiều | Tệp thử riêng trong home ztuser: console→Web và Web→console đúng nội dung; đã xóa sau thử |
| Tách quyền | ztuser không có sudo; không đọc được `/home/linux/a.txt` hoặc tệp env của Agent (root, quyền 600) |
| Khóa Bastion | Đăng nhập ztuser được; đăng nhập linux bị từ chối xác thực, host key vẫn được kiểm tra |
| VPN/firewall/service | WG/Agent/SSH/nft active và enabled; SSH chỉ nghe `.4:22`, chỉ dùng khóa, tắt root login; input/forward DROP |
| Bảo toàn | Hai a.txt gốc, quyền home, 13 tệp có sẵn và định danh/token/pin/tài khoản/password/role không đổi |
| Build/unit/DB của đợt thay đổi | Gateway/Dashboard build đạt; 87 Vitest dùng mock đạt; DB tạm thật nâng 008→009, CLI đăng ký/cập nhật tài khoản/chạy lại/xung đột đều đạt |

Console ở lượt này là lệnh thực thi qua **QEMU guest-agent trong guest thật** với
`sudo -iu ztuser`, độc lập kênh Web SSH. Không phải gõ trực tiếp cửa sổ virt-manager
và không phải mock. Public Bastion key tạm cấp cho linux trong phương án thử trước
đã gỡ đúng dòng; authorized_keys của linux khớp backup ban đầu, khóa quản trị riêng
vẫn dùng được. Hai a.txt có nội dung khác nhau được giữ nguyên, không copy/đổi quyền
để tạo kết quả khớp.

Lượt browser đầu có lỗi helper truyền fixture qua sudo login shell làm mất newline;
ảnh cho thấy Web SSH hiển thị đúng dữ liệu thực đó. Đã sửa cách truyền byte của
fixture, kiểm tra byte trước khi đọc qua web và chạy lại đủ 8 trường hợp; không sửa
ứng dụng hoặc nới assertion. Root `sudo -l -U ztuser` trả 0 khi truy vấn thành công
nhưng thông báo không có quyền; kiểm chứng dựa cả policy và lần chạy sudo thật
dưới ztuser bị từ chối, không suy quyền từ riêng exitcode của truy vấn root.

- [Log runtime, quyền, VPN và DB](ssh-user-runtime.txt).
- [Kết quả browser](ssh-user-browser.json).
- [Terminal tài khoản riêng](ssh-user-terminal.png), [mobile 375px](ssh-user-mobile.png).

Rawcache: `/home/mowftee/.cache/zt-linux-ztuser-20261020T051217Z/`.
Build/unit/DB của cùng đợt ở `/home/mowftee/.cache/zt-ssh-user-20261020T045302Z/`.
Windows mới có ISO, chưa có guest được đăng ký trong libvirt tại thời điểm kiểm tra;
không sử dụng kết quả Linux để chứng nhận Windows. Các giới hạn hypervisor theo
phiếu, Internet độc lập và RAM toàn mô hình đã nêu ở trên vẫn giữ nguyên.
