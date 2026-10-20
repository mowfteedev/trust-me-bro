# Kiểm chứng cuối: RAM, reboot và cảnh báo — 20/10/2026

Nhánh `minh-thanh`; code Telegram `d5d624e`, Dashboard `76022b0`, Agent
`b04b58d`. Giữ hai mục Internet độc lập và chấp thuận KVM ngoài lượt này theo
chỉ đạo chủ dự án. [JSON số đo và dấu vết](windows-final.json) chứa timestamp,
hash binary, dịch vụ, incident/audit và SHA256 log thô; không chứa credential.

| Mục | Kết quả | Giới hạn |
|---|---|---|
| Tooling Dashboard | Audit toàn cây/runtime0; build và Docker đạt; 24layout trước/sau giống ảnh | Cần trình duyệt hiện đại; ảnh so sánh dùng fixture UI |
| RAM Windows | Ngân sách Go2MiB, Linux giữ6MiB; private quan sát giảm khoảng0,9MiB so với mẫu6MiB | WorkingSet sau boot vẫn13,03–13,10MiB; khoảng10MB chưa đạt ổn định |
| Phục hồi sau reboot | Tự lên, heartbeat mới và SSH có xác thực sau khoảng149s từ yêu cầu | Gồm10s chờ tắt; một lần đo liên tục, không là cam kết mọi lần boot |
| Telegram | Offline và CPU thật có acknowledgement40/41, tự resolve | API acknowledgement không xác nhận người nhận đã đọc |

## RAM: không lấy mẫu đẹp thay kết quả ổn định

Cùng Windows Server2022, LocalService và config/identity giữ nguyên. Các mẫu
ngắn6/4/2MiB có median như sau; khác tuổi process và trạng thái OS, không là
benchmark nhân quả chỉ riêng ngân sách Go:

| Ngân sách mềm | WorkingSet | Private committed |
|---|---|---|
| 6MiB, trước thử | 13,688MiB | 14,219MiB |
| 4MiB | 13,203MiB | 13,777MiB |
| 2MiB, trước reboot | 9,770MiB | 13,688MiB |
| 2MiB, 41mẫu sau reboot trong605,61s | 13,027–13,102MiB | 13,246–13,363MiB |

Chọn2MiB vì thay đổi nhỏ và các luồng thật vẫn hoạt động; không hạ tiếp để
tìm một mẫu thấp. CPU Agent trong cửa sổ605,61s là0,390% một nhân, tính từ chênh
lệch CPUtime tiến trình. Đây không phải CPU toàn OS; cửa sổ gồm Web SSH thật và
pha tải CPU45s. Không thấy restart Agent trong41mẫu (cùng PID3484).

WorkingSet là các trang vật lý đang resident, gồm trang dùng chung; private
committed không đồng nghĩa toàn bộ đang nằm trong RAM vật lý. Ngân sách Go
chỉ áp dụng phần bộ nhớ runtime quản lý, là giới hạn mềm và có thể bị vượt.
Giữ `GOMEMLIMIT` cấu hình rõ ràng, không épGC/trim WorkingSet, không thay chu kỳ
heartbeat hoặc đổi định nghĩa số đo để gọi đạt10MB. Chênh lệch giữa hai lần
khởi động còn chịu ảnh hưởng của OS, không quy toàn bộ cho ngân sách Go.

## Reboot đo liên tục

- Yêu cầu bắt đầu `12:30:28Z`; boot thật `12:30:42.500Z`.
- Stale quan sát lúc `12:30:56.534Z`, tuổi heartbeat18,390s; Offline lúc
  `12:31:11.708Z`, tuổi33,564s. Đúng phạm vi phát hiện mất tín hiệu15–45s.
- Native ghi cả WG/sshd/Agent Running lúc `12:32:52.846Z`; Agent vẫn LocalService.
- Heartbeat mới Healthy quan sát lúc `12:32:55.878Z`, uptime132s: khoảng133,38s
  từ boot. SSH ghim host key qua WireGuard thực thi hostname/whoami thành công;
  observer kết thúc sau148,93s từ yêu cầu. Không start dịch vụ bằng tay.
- Host chặn sleep trong phép đo; sai lệch clock khoảng0,000014s. Khoảng ngắt
  của lần trước vẫn giữ trong [lịch sử thất bại](closure.md), không tính PASS.

Giữ delayed automatic start đang hoạt động. Khi demo, bật Windows và chờ
khoảng2–3phút; thời gian khởi động OS khác thời gian phát hiện mất heartbeat.

## Chức năng thật và kiểm tra cô lập

Đã chạy lại lệnh hướng dẫn trên môi trường demo hiện tại:

```sh
python3 deploy/scripts/verify-vm.py --node-name node-windows-01 --shell windows --ssh-user ztuser
python3 deploy/scripts/verify-vm.py --node-name node-linux-01 --shell linux --ssh-user ztuser
python3 deploy/scripts/demo.py doctor
```

Mỗi VM đạt16/16 luồng: đăng nhập/RBAC, telemetry, WebSocket→SSH→PTY, audit,
đóng terminal/logout và thu hồiJWT. Firefox158 thật đạt7/7, gồm lệnh trên
Windows bằngztuser và Viewer không có SSH; [dashboard](windows-dashboard.png),
[terminal](windows-terminal.png), [kết quả browser](windows-browser.json).
Harness browser lần gọi qua uv thiếu dependency Selenium; đã dùng môi trường
Selenium cài sẵn và giữ nguyên assertions, không coi lỗi công cụ là PASS.

Agent nativeWindows đạt18ca top-level; Win32 collector chạy thật, HTTP/TLS
dùng loopback fixtures, không tính chúng thành backend thật. Linux
`go test -race ./...` đạt. Gateway build+98unit dùng DB/fetch mock; Docker
Gateway/Dashboard/LinuxWorker build và khởi chạy lại trên lab thật. Thử tải
hai PSjob45s tạo10mẫu CPU100%, một incident/audit, tự resolve và Telegramack41.
Khoảng cách mẫu khi CPU100% là3,675–5,006s; không cam kết chu kỳ3s ở mọi tải.

NgưỡngCPU85% và heartbeat không đổi, không dùng beacon giả. Xem
[tooling và ảnh so sánh](dashboard-tooling-final.md),
[nội dung Telegram và phân biệt mock/live](telegram-content.md).

## Dọn công cụ

Native checker cuối exit0; WinRM Stopped, rule tạm Disabled, không listener
5985/18745; HTTP artifact18743 đã dừng. Không còn task đo/cleanup tạm, credential
Admin tạm đã xóa. Bundle triển khai riêng/canonical Stage khớp binary đã đo;
bundle gốc và env/login/khóa Gateway giữ nguyên. Không push hoặc merge.
