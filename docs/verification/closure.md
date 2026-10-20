# Đối chiếu các thiếu sót — 20/10/2026

Code kiểm chứng: `acf639b` trên `minh-thanh`, Gateway Compose `zt_demo`,
Debian12 và Windows Server2022 KVM thật. Số đo, thời gian và scope ở
[JSON bằng chứng](closure-evidence.json). Không dùng kết quả này để chứng nhận
production hoặc thay thế chấp thuận môi trường thực nghiệm của giảng viên.

| Mục đã giao | Kết quả | Còn thiếu |
|---|---|---|
| Zero Inbound | Probe IPv4/IPv6 link-local giữa hai VM thật; cấu hình mặc định chặn inbound | Máy Internet độc lập và IPv6global chưa có |
| RAM | Đã đo container, từng Agent và RAM hệ điều hành guest riêng | Chưa chứng minh trần mọi tải; cần thống nhất phạm vi nếu tính cảOS |
| Hypervisor | KVM chạy hai VM thật, giữ Docker | Chưa được xác nhận thay VMware/VirtualBox trong phiếu |
| Reboot binary Windows mới | Boot time thay đổi, hash binary giữ nguyên, WG/SSH/Agent tự lên; chạy lại16luồng thật đạt | Đo thời gian phục hồi bị gián đoạn, không tính watcher làPASS |
| CPU Windows | Tải thật vượt85%, một incident/audit, Telegram ack, tựresolve | Không phải benchmark hoặc thử mọi dạng tải |
| Checker Windows | 30case tổng hợp PS5.1 và ruleTCP thật giả tênCoreNet bị phát hiện; trạng thái sạch exit0 | Checkerlocal không thay probe Internet |
| Tooling | Gateway audit0; build/test/Docker đạt | Dashboard7cảnh báo dev chuỗiTailwind3 cònOPEN |

## Windows reboot và luồng chính

- Boot trước `11:35:20.500Z`, sau `11:43:02.500Z` ngày20/10; binary vẫn có
  SHA256 `a4024f022fe58c36b7bee69bf9d118ec2cb682ddc393dccf131fcce55a36ac5c`.
- WG/sshd chạyLocalSystem; Agent chạyLocalService, PID2992 sau reboot.
  Không khởi động thủ công SSH/Agent trong lần kiểm tra này.
- Mỗi VM đạt16/16 luồng thật qua `verify-vm.py`: auth, RBAC, telemetry,
  WebSocket→SSH→PTY, audit, logout đóngSSH và thu hồiJWT. Chạy tuần tự vì dùng
  tài khoản demo chung. Browser không chạy lại trong lượt này; bằng chứng
  Firefox trước đó vẫn được giữ với đúng phạm vi cũ.
- Watcher thấy Stale ở tuổi heartbeat18,410s và Offline33,662s. Có khoảng
  gián đoạn quan sát473,283s; assertion uptime<280s **THẤT BẠI**. Checkpoint
  đầu có PID0/exit1; số bộ nhớ PID0 là không hợp lệ và đã loại khỏi phép đoAgent.
  Kiểm traAdmin mới xác nhận cả3dịch vụRunning, PID thật, checker0 và không còn
  ruleWinRM tạm. Không suy thời gian boot từ dữ liệu có khoảng ngắt này.
- Lúc tiếp tục, hai VM đangtắt; DockerAgent bịHTTP429 kéo dài. Đã bật VM và
  recreate đúng Gateway/helper/Worker theo hướng dẫn có sẵn, giữ DB/khóa.
  Không kết luận nguyên nhân429 từ riêng log này; doctor cuối lượt trả0.

## CPU thật và mạng

Windows chạy hai PowerShell job tự kết thúc sau45s, không đổi ngưỡng85% hoặc
gửi metric giả. Có11mẫuCPU100%, đúng một incident/audit, Telegram API ack32;
incident resolved khiCPU giảm. Khoảng cách mẫu trong phaCPU100% là3,772–4,351s,
chậm hơn chu kỳ cấu hình3s. Không gọi đây là đảm bảo3s ở mọi mức tải.

Debian gửi24probeTCP (12cổng trênIPv4 vàIPv6 link-local) sangWindows, không
kết nối được. Có listenerTCP/UDP18745 thật trênWindows: bốn control loopback
IPv4/IPv6 nhận được, sáugóiUDP từDebian không tới. NeighborIPv6 trênDebian thấy
đúngMAC Windows vàREACHABLE. Windows cũng thử támkết nốiTCP quaIPv4/IPv6 tới
Debian, đều không kết nối được. Đây là mạnglab cùngbridge, **không phảiInternet**.
Không dùngUDP không phản hồi khi không cólistener để tuyên bốfirewall đãchặn.

## Phạm vi RAM

| Thành phần/phạm vi | Số đo mới | Cách đọc |
|---|---|---|
| Sáucontainer dịch vụ,6snapshot | 100,43–105,27MiB; trung bình102,89MiB | Dockerworking set; 0containerOOMKilled |
| AgentDebian | RSS9144KiB =8,93MiB | Một snapshotprocess thật sauboot |
| AgentWindows saureboot | WorkingSet13,71MiB; private14,30MiB,6mẫu/10s | Hai chỉ số khác nhau; không chọn số9,92MiB của lần trước làm trần |
| OSguestDebian, gồmAgent | 230,35MiB | Mẫu telemetry thật |
| OSguestWindows, gồmAgent | 1406,39MiB | Mẫu telemetry thật; DesktopExperience |

Phiếu ghi **cụm dịch vụ**: các số dịch vụ ứng dụng đang quan sát nằm dưới ngân
sách500MB–1GB. Ước lượng container+haiAgent khoảng126MiB, dùng cách đo/thời điểm
khác nhau nên không coi tổng này là phép đo đồng thời hoặc hardcap. Build,
Dockerdaemon và hệ điều hành không thuộc số container trên.

Nếu tính cảhaiOSguest thì riêng chúng đã khoảng1,60GiB; cộng host/hypervisor
còn cao hơn. Mô hình haiVM cóWindowsDesktop **không đạt1GB khi tính cảOS**.
Không cộngAgent lần nữa vàoRAMguest. RAMWindowsAgent hiện nhỉnh mục tiêu
"khoảng10MB"; chưa có bằng chứng bảo đảm10MB trong mọi trạng thái.

## Dọn công cụ và giới hạn còn mở

RuleWinRM tạm đãtắt, serviceWinRM đãdừng; không cònlistener18745/5985 sauthử.
Fixture tronghomeztuser và credentialAdmin tạm đãxóa; helperupload bịtreo đãdừng.
Bundle triển khai riêng đãcập nhật checker; bundle gốc giữlại. Các báo cáo môn
học không thuộc lần sửa này. Một báo cáo cósẵn được sửa bởi hoạt động ngoài
phầnviệc này; không khôi phục hoặc stage nó.

Vẫn cần chủ dự án/giảng viên xác nhận KVM và cung cấp máyInternet độc lập nếu
muốn đóng hai mục tương ứng. NợCSS/tooling xem [audit mới](tooling-update.md);
chi tiếtchecker xem [kiểm chứngWindows](windows-checker.md).
