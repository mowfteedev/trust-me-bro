# Kiểm chứng phiên bản

## Chạy lại kiểm tra cục bộ

Cài dependency từ lockfile, Go theo `agent/go.mod`, Python3 và Docker nếu chọn
runner Docker. Chạy tại repo; thư mục bằng chứng mới nằm ngoài repo:

```sh
npm --prefix gateway ci
npm --prefix dashboard ci
python3 deploy/scripts/acceptance.py --output /tmp/zt-acceptance-20261116
```

Kiểm Excel bằng trình đọc độc lập cần môi trường Python kiểm thử riêng:

```sh
python3 -m venv /tmp/zt-excel-tools
/tmp/zt-excel-tools/bin/pip install -r tests/requirements.txt
ZT_EXPORT_READER_PYTHON=/tmp/zt-excel-tools/bin/python \
  python3 deploy/scripts/acceptance.py --runtime-labs --output /tmp/zt-acceptance-NEW
```

Openpyxl chỉ dùng để đọc/kiểm tệp trong lab/CI, không đi vào Gateway/Dashboard.
Ca Excel kiểm bộ lọc, nhiều trang, Unicode, chuỗi công thức dạng văn bản,
Admin/Viewer và API/hàm dọn nhật ký đã bị gỡ; không xóa dữ liệu production.

Hoặc thêm `--docker` để dùng `make test` (build các builder cục bộ), không cần
Node/Go trên host. Runner kiểm Python/native/unit/build và xuất exit code,
loại bằng chứng vào `result.json`, log riêng tư. Nó không chạy `make e2e`,
không đăng nhập/đăng xuất tài khoản chủ dự án và không gửi Telegram thật.
Cờ `--runtime-labs` chạy thêm accounts, backup/restore và delivery queue trên
PostgreSQL riêng; Telegram transport luôn giả lập. Bỏ cờ để chỉ build/unit.
Nếu host thiếu Go, runner dùng image Go cục bộ và mount source hiện tại chỉ
đọc; nếu thiếu cả hai thì báo SKIP/INCOMPLETE (exit2), không ghi PASS.
Workflow `.github/workflows/checks.yml` chạy source/unit/build trên push/PR;
Windows Agent được cross-build, không coi đó là kiểm Windows Service thật.

Diễn tập schema/backup/restore PostgreSQL thật, hoàn toàn trong container riêng:

```sh
python3 tests/runtime-recovery.py --output /tmp/zt-recovery-drill-20261116
```

Lệnh áp dụng migration hiện tại, tạo dữ liệu giả, sao lưu rồi khôi phục vào DB
mới; network `none`, không publish port, dọn container/volume của lab sau khi
xong. File bằng chứng và backup riêng tư ở output; không dùng khóa hay DB thật.

## Ma trận phiếu giao

Mỗi lần nghiệm thu ghi commit + source dirty/hash + image ID, môi trường,
lệnh, thời điểm và artifact. Không lấy số PASS của lần trước làm kết quả mới.

| Tiêu chí | Cách kiểm | Bằng chứng tối thiểu |
|---|---|---|
| WireGuard M2M | Worker tới Gateway qua UDP51820, handshake và byte tăng | Runtime + overlay route |
| Zero Inbound Worker | Rule/listener thực, probe ngoài độc lập tới đúng host; IPv4/IPv6 nếu có | Probe tới host, kết quả firewall; NAT không đủ |
| Telemetry | Agent ACK, CPU/RAM/disk/network/uptime so với OS | Runtime thật, timestamp |
| Heartbeat và Offline | Dừng node lab; đo last_seen → stale/offline, khôi phục | Mốc thời gian theo ngưỡng env, không đo bằng nhìn màu |
| Web SSH | Admin mở PTY, `whoami`, resize, exit; pin sai bị chặn | SSH thật và audit |
| Admin/Viewer | Thử cả UI và API trực tiếp; Viewer đọc, không sửa/SSH | 401/403 và dữ liệu an toàn |
| Tài khoản/phiên | Hai phiên khác nhau; current logout và logout-all; khóa/đổi quyền | API + DB thật, không chỉ mock |
| Cảnh báo | Offline/Online, CPU cao/bình thường; timeout/retry/restart | Giả lập tách khỏi Telegram thật |
| DB và backup | Dump, verify, restore vào DB mới; đối chiếu dữ liệu/ACL | Runtime PostgreSQL cô lập |
| VM Windows/Linux | Cài mới đúng tài liệu, pin, Agent, Web SSH, reboot | Mỗi OS/hypervisor có bằng chứng riêng |
| Máy vật lý | Đúng type/kiến trúc, service tự chạy, không ảnh hưởng dịch vụ cũ | Console/runtime thiết bị |
| RAM | Đo Agent RSS và toàn cụm, ghi OS/Docker overhead riêng | Số đo thật, thời gian và điều kiện |
| Dashboard | Loading/Empty/Error, bàn phím, desktop/mobile, stale data | Browser thật; fixture phải ghi rõ |

## Phân loại kết quả

- **SOURCE/COMPILE:** kiểm cấu trúc, contract hoặc build; chưa chạy hệ thống.
- **MOCK/GIẢ LẬP:** đầu vào/DB/Telegram giả; chỉ xác nhận logic đã mô phỏng.
- **RUNTIME CÔ LẬP:** DB/container/node lab thật; không chứng minh VM/Internet
  hoặc live Telegram nếu các thành phần đó chưa tham gia.
- **RUNTIME THẬT:** nêu đúng máy/OS, điều kiện, thao tác và kết quả đã quan sát.
- **CHƯA KIỂM CHỨNG:** không có bằng chứng đúng ca hoặc ca không chạy được;
  ghi lý do và bước tiếp theo, không đổi thành PASS nhờ mẫu báo cáo cũ.

Reboot, mất mạng và kiểm live Telegram chỉ thực hiện ở node/môi trường được
chủ dự án cho phép; không làm trên TV box/EC2 đang phục vụ để chạy unit test.
Kiểm nhiều người dùng bằng lab nhỏ có giới hạn; không tự bắn tải public.
