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
