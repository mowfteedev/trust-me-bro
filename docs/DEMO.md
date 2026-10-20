# Kịch bản trình diễn đồ án (10–15 phút)

## Chuẩn bị

Chạy từ thư mục repository, Linux có Docker/Compose v2 và kernel WireGuard:

```sh
python3 deploy/scripts/demo.py up
python3 deploy/scripts/demo.py doctor
python3 deploy/scripts/demo.py check
```

Mở `https://localhost`, chấp nhận chứng chỉ CA nội bộ trên máy demo. Đọc mật
khẩu cục bộ trong `keys/demo-login.env`, không chiếu tệp này. Mở sẵn hai cửa sổ
trình duyệt và terminal máy chủ.

## Thứ tự thao tác

| Bước | Thao tác | Kết quả mong đợi và ý nghĩa |
|---|---|---|
| 1 | Giới thiệu sơ đồ Gateway–WireGuard–Worker | VPN M2M bảo vệ đường truyền, token và RBAC bảo vệ ứng dụng |
| 2 | Login `demo-viewer` | Thấy CPU/RAM/disk, tổng RX/TX, uptime, biểu đồ và Online; không có nút SSH |
| 3 | Giới thiệu `demo.py check` | Backend trả 403 nếu Viewer gọi cấp vé SSH trực tiếp; ẩn nút không phải lớp bảo vệ duy nhất |
| 4 | Logout, login `demo-admin`, mở Web SSH | Terminal báo Đã kết nối; nhập `id`, `hostname`, `stty size`, tương tác shell Linux thật với user `ztuser` |
| 5 | Phóng to/thu nhỏ, đóng terminal; mở Nhật ký hoạt động | PTY resize, socket đóng; START/END cùng session_id và IP request; lọc thêm đăng nhập thất bại |
| 6 | Xem handshake/transfer WireGuard | Có peer handshake và lưu lượng; không xuất private key |
| 7 | Tạm dừng worker theo lệnh dưới | Stale khoảng15–20s, Offline khoảng30–35s; live gửi Telegram, dry-run ghi log giả lập |
| 8 | Khôi phục worker | Tự về Online; incident offline resolved, không cần reset DB |
| 9 | Xem audit/incident CPU và bằng chứng Windows thật | CPU100% vượt ngưỡng85%, một incident/audit, Telegramack rồiresolve; xem `verification/closure.md` |
| 10 | Logout và giải thích giới hạn | JWT cũ bị từ chối, phiên SSH bị thu hồi; nêu phạm vi RAM/VM và cách thử Telegram |

Lệnh mạng đã dùng trong kiểm chứng:

```sh
docker compose --env-file keys/demo.env -p zt_demo --profile demo exec -T wireguard_gateway wg show wg0 latest-handshakes
docker compose --env-file keys/demo.env -p zt_demo --profile demo exec -T wireguard_gateway wg show wg0 transfer
docker compose --env-file keys/demo.env -p zt_demo --profile demo exec -T node_worker_01 ss -lnt
docker compose --env-file keys/demo.env -p zt_demo --profile demo exec -T node_worker_01 iptables -S
```

Không dùng `wg showconf`, `cat keys/*` hoặc chiếu file env: có thể lộ bí mật.

Lệnh mô phỏng mất máy con, sau đó **phải khôi phục**:

```sh
docker compose --env-file keys/demo.env -p zt_demo --profile demo pause node_worker_01
docker compose --env-file keys/demo.env -p zt_demo --profile demo unpause node_worker_01
```

Chờ giao diện thực sự chuyển trạng thái trước khi chạy `unpause`. Có thể kiểm
tra tự động cùng thao tác bằng `python3 tests/demo-liveness.py`; bài này khôi
phục worker trong `finally`. Lượt18/10: Stale **15,19s**, Offline **30,21s**.
Không chạy bài pause/unpause đồng thời với SSH hoặc bài thu hồi phiên trên cùng
cụm. Chênh lệch do pha heartbeat và chu kỳ quét, không phải SLA production.

Trong cửa sổ terminal khác, xem log giả lập cảnh báo:

```sh
python3 deploy/scripts/demo.py logs
```

`demo.py check` gồm hai phần: 16 kiểm tra trên cụm đang chạy, sau đó các DB tạm
với Fastify inject để thử payload CPU và timestamp biên. DB tạm được xóa sau
test; node kiểm thử không được chèn vào dashboard demo. Telegram trong các DB test chỉ ghi log
`GIẢ LẬP — KHÔNG GỬI`. Không cần và không sử dụng token Bot thật.

Bot live hiện tại là `@da_mmt_bot`, ghép nối bằng OTP và lưu chat trong DB.
`python3 deploy/scripts/demo.py check-telegram` gửi một cảnh báo CPU giả lập
có nhãn `TEST_GIA_LAP_CPU` tới chat đã ghép nối; fixtures nằm trong DB tạm và
được xóa sau thử. Bài này dùng Telegram thật, không gọi là tải CPU vật lý.
Đã thử Worker Offline thật sau31,89s, Telegram API xác nhận gửi, rồi Worker
Online và incident resolved. Xem `docs/verification/telegram-live.txt`.

## Khi có lỗi

- Port 80/443 đang dùng: đổi `HTTP_PORT`/`HTTPS_PORT` trong `keys/demo.env`, rồi
  chạy `up` lại; URL sẽ được script in ra.
- Chẩn đoán nhanh bằng `make doctor` (chỉ đọc, không thu hồi phiên). Các target
  Make nhận `PROJECT=... ENV_FILE=...` để chọn đúng cụm. `make logs` in 80 dòng
  gần nhất, không chạy follow. `make clean` giữ log, khóa, tài liệu và DB.
- Gateway chưa ready: xem `demo.py status` và `demo.py logs`; kiểm tra migrator
  và provisioner đã exit 0, PostgreSQL healthy. Không tự xóa volume để chữa lỗi.
- SSH không vào: kiểm tra handshake, node đang Online, tài khoản `ztuser`,
  quyền đọc private key và host fingerprint. Không tắt host key verification.
- Thay Gateway container: chạy `up` cho toàn cụm để WireGuard helper theo đúng
  network namespace. Không recreate riêng Gateway rồi giữ helper cũ.
- Tài khoản/node đã tồn tại với bí mật khác: CLI dừng để bảo toàn dữ liệu;
  dùng đúng `keys/demo.env` và `keys/demo-login.env` của cụm đã tạo.
- Nếu Agent gửi ít nhưng bị HTTP429 kéo dài sau khi đồng hồ máy thay đổi: kiểm
  tra đồng bộ thời gian. Rate-limit trong bộ nhớ phụ thuộc đồng hồ hệ thống;
  chạy `up` thông thường không buộc restart nếu image/config không đổi. Có thể
  tạo lại đúng Gateway/helper/Worker để bỏ cache cũ, giữ DB/key/tài khoản:

  ```sh
  docker compose --env-file keys/demo.env -p zt_demo --profile demo up -d --no-build --no-deps --force-recreate gateway wireguard_gateway node_worker_01
  make doctor
  ```

  Lệnh làm gián đoạn kết nối đang mở, không thu hồi JWT hoặc xóa volume.
  Không tự chỉnh giờ host hay xóa lịch sử để chữa lỗi. Mẫu có timestamp tương
  lai được giữ trong DB, tạm không dùng cho latest/history cho đến khi giờ bắt kịp.
- Mất kết nối Gateway: dashboard có thông báo và Retry; số liệu cũ được ghi rõ.
  Logout offline xóa phiên trình duyệt nhưng chưa xác nhận thu hồi trên server.

## Điểm cần giải thích trước giảng viên

WireGuard không thay thế RBAC; máy có VPN vẫn cần token, quyền ứng dụng và
fingerprint SSH. Gateway giữ khóa SSH nên vẫn là điểm tin cậy quan trọng;
không tuyên bố an toàn tuyệt đối. SSH shell demo không có root. Snapshot RAM
Python trước đây khoảng23MiB; Agent Go mới khoảng10,3–10,6MiB RSS trong các lượt đo,
gần mục tiêu khoảng10MB nhưng không cam kết dưới10MB mọi tải. Bản18/10 thêm hỗ trợ
Windows/config/diagnostic chung đo LinuxRSS khoảng11,0MiB. Windows sau tối ưu
build20/10 đo WorkingSet9,00–9,07MiB ở146–162s; sau hơn12phút9,92MiB,
private14,03MiB, trước đó khoảng46MiB.
Không dùng WorkingSet làm giới hạn cứng hoặc đánh đồng với private bytes.
Docker worker có VPN/SSH
thật nhưng chưa phải bằng chứng VMware/VirtualBox; xem [VM_SETUP.md](VM_SETUP.md).
Số liệu `/proc` trong container phản ánh kernel/namespace đang chạy, không nên
gọi toàn bộ là tài nguyên của một VM riêng.

## Debian VM đang chạy

Ngày20/10 đã thêm `node-linux-01` (`10.100.0.4`) trên Debian12 KVM, giữ nodeDocker
`.2`. Bật VM trong virt-manager, chạy `demo.py doctor`, mở https://localhost,
chọn nodeDebian và **Web SSH**. Chạy `hostname; whoami; uname -sr`: thấy
`node-linux-01`, `ztuser`, Linux. Tiêu đề terminal là `ztuser@node-linux-01`.
Trên console VM dùng `sudo -iu ztuser` để đọc cùng `/home/ztuser/a.txt` với Web SSH;
`/home/linux/a.txt` là tệp riêng của quản trị viên. Docker cũng dùng `ztuser`.
Dashboard hiển thị RAM/disk của guest riêng.
Logout đóng phiên SSH đang mở; Viewer chỉ xem thông số. Bài kiểm tra tự động:

```sh
python3 deploy/scripts/verify-vm.py --node-name node-linux-01 --shell linux --ssh-user ztuser
```

Lệnh này đăng xuất các phiên demo-admin/demo-viewer. Đã kiểm tra reboot, heartbeat
median3,020s, Stale16,60s/Offline31,67s và phục hồi sau khi dừng/bật Agent thật;
cảnh báo Offline có Telegram API ack. Thao tác dừng Agent thật trên cụm live có
thể gửi thông báo. Xem [Debian Worker](DEBIAN_WORKER.md) và
[bằng chứng](verification/debian-vm.md). Phiếu ghi VMware/VirtualBox, còn lượt này
chạy KVM; chưa xác nhận tương đương. Ingress từ Internet độc lập vẫn chưa thử.

## Windows VM đang chạy

Windows Server2022 `node-windows-01` đã chạy thật ở`.3`, giữ Docker`.2` và
Debian`.4`. Bật VM trong virt-manager, chờ khoảng2–3phút cho WireGuard/Agent/SSH
tự lên; `demo.py doctor` phải thấy heartbeat và SSH banner. Trong dashboard chọn
nodeWindows, mở **Web SSH**, chạy:

```powershell
hostname
whoami
powershell -NoProfile -Command "[Environment]::OSVersion.Platform"
```

Thấy `node-windows-01`, `node-windows-01\ztuser`, `Win32NT`. Dashboard hiển thị
RAM/disk của guest Windows; Viewer chỉ xem thông số. Web SSH không có quyền
Administrators. Luồng kiểm tra thật đã chạy trước/sau reboot:

```sh
python3 deploy/scripts/verify-vm.py --node-name node-windows-01 --shell windows --ssh-user ztuser
```

Đạt16/16 luồng API/SSH/audit/logout và7/7 Firefox sau reboot. Lệnh verify thu hồi
phiên các tài khoản demo. Xem [Windows Worker](WINDOWS_WORKER.md) và
[bằng chứng/giới hạn](verification/windows-runtime.txt). Lượt tối ưu build tiếp
theo đạt18 test native Windows,16 luồng thật và dừng/bật service có ACK mới;
WorkingSet khoảng9MiB trong cửa sổ đo cũ. Saureboot bảnmới đo13,71MiB,
private14,30MiB. CPUWindows thật, Telegram và IPv4/IPv6 link-local giữa haiVM đã
thử; ingress Internet độc lập vẫn chưa kiểmchứng. Xem [đối chiếu mới](verification/closure.md).

Kết thúc bằng `python3 deploy/scripts/demo.py down` nếu muốn dừng; dữ liệu demo
được giữ để chạy lại. Không merge vào main hoặc deploy production.
