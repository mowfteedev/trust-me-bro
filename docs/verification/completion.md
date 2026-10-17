# Kết quả hoàn thiện — 18/10/2026

Nhánh `minh-thanh`; commit riêng từng việc; **không push trước khi chủ dự án duyệt**.
Phạm vi là code, cấu hình, hướng dẫn demo và bằng chứng kỹ thuật; không soạn slide
hoặc báo cáo môn học. Không merge main, reset dữ liệu hoặc triển khai production.

## Kết luận

Phần Linux/Docker đang chạy thật tại **https://localhost** đã cập nhật. Có code
Agent Windows và bộ cài, nhưng **chưa hoàn tất nghiệm thu mô hình Windows VM**.
Không có VMware/VirtualBox/userland hypervisor hoặc Windows guest/image trên máy;
`/dev/kvm` không thay thế môi trường guest. Windows/SSH/ACL/SCM/reboot/RAM native và
kiểm tra Internet độc lập vẫn **CHƯA KIỂM CHỨNG**.

| Công việc | Kết quả | Bằng chứng / giới hạn |
|---|---|---|
| Agent Windows | Collector Win32 + service LocalService + installer/config/diagnostic có source | Cross-build amd64/arm64, test executable compile/vet; chưa chạy Windows |
| Agent Linux | Giữ giao thức/collector, thêm config/diagnostic chung | 18 Go tests + 21 config subcases, race/vet; mẫu Linux và heartbeat thật |
| Gateway | Không điền số0 cho measurement thiếu; kiểm tra capacity; registerVM cục bộ | 58 Vitest dùng mockDB/fetch; SQL thật xác nhận idempotence/xung đột và giữ dữ liệu |
| VM provisioning | Peer `.3`/token riêng, SSH nonadmin qua VPN, kiểm tra/restore | Prepare key/bundle thật, mode0700/0600 và không ghi đè; PowerShell parser/guard Linux. Native setup chưa chạy |
| API/SSH/RBAC/audit/logout | 16 luồng LinuxDocker thật đạt | WebSocket→SSH→PTY qua WireGuard, audit START/END, Viewer403, logout đóng phiên và thu hồiJWT |
| DB gián đoạn | Auth/API fail closed, phục hồi được | Dừng PostgreSQL thật trong cụm riêng: /auth/me và /nodes trả503; cùng phiên hoạt động lại sau restart |
| Liveness | Stale15,19s, Offline30,21s, một incident, Online/resolve sau unpause | Worker thật dừng/khôi phục trong cụm riêng, Telegram dry-run |
| CPU | Agent/HTTP/SQL thật, một incident/audit và recovery | Lab dùng ngưỡng20,21%, peak30,26%; không chứng minh vượt mặc định85% hoặc CPU Windows |
| CPU85%/Telegram live | Hai lần CPU host thật vượt85% lúc build Worker | Audit88,66%/87,25%; Telegram API ack message14/15. Đây là sự kiện tự nhiên, không phải bài tải có kiểm soát hoặc Windows |
| Dashboard | Sync/heartbeat/time chart/status filter/SSH retry/responsive | Firefox157, 17 checks với API/SSH/DB thật; chỉ lỗi fetch là giả lập browser |
| Tài nguyên | Agent Linux RSS11272–11276kB ≈11,0MiB; container tổng≈128MiB | Snapshot demo, không là cap/benchmark; chưa tính OS/daemon/hypervisor/browser hoặc RAM Windows |
| Dependency | Node22, dev/preview loopback; đã triage ảnh hưởng | Runtime vẫn4 package bị audit cảnh báo; Fastify4/JWT chưa nâng major, không chứng nhận sạch |

## Những thay đổi có thể xem ngay

- Dashboard: [desktop](completion-desktop.png), [mobile](completion-mobile.png),
  [terminal](completion-terminal.png). Ảnh là Worker Linux thật, không gắn nhãn Windows giả.
- Terminal có trạng thái tiếng Việt, chờ READY có timeout, mở phiên mới sau khi
  shell đóng; nền inert và khôi phục focus. Escape/Tab vẫn dùng trong shell;
  Alt+Esc đóng modal. Đăng nhập được giữ thiết kế đã duyệt.
- Graph dùng thời gian thật, ngắt khoảng mẫu>15s; số liệu cũ/lỗi Gateway khác
  trạng thái nodeOffline; RX/TX ghi rõ là byte tích lũy.
- Bộ cài cục bộ ở `keys/windows-worker-01/`: có private token/key, exe/test exe,
  script và checksum; Git loại trừ. Chưa register nodeWindows hoặc apply peer `.3`
  vì chưa có SSH host PUBLIC key đáng tin từ guest.

## Bằng chứng

- [Runtime/SQL/liveness/CPU/transport](completion-runtime.txt): cụm riêng
  `zt_completion_check`, DB/volume riêng, Telegram dry-run. SQL tests dùng fixture
  có nhãn và xóa DB tạm; không đưa fixture vào dashboard chính.
- [Unit/build](completion-unit.txt): phân biệt tests Linux, mockDB/fetch và
  cross-compile Windows. PowerShell parser7.6.7 chạy trên Linux, không phải SCM/
  ACL/firewall Windows thật. Review độc lập đã sửa quota disk, junction/state
  paths, enum firewall, NIC exempt và đồng bộ kết quả SCM.
- [Windows static/build](completion-windows-static.txt): cross-build, parser và
  guard tests tách khỏi native execution; prepare dùng keygen thật, không apply peer.
- [Browser](completion-browser.json): Firefox157, viewport1920/768/375/320; real
  SSH command, shell exit/reopen, audit, Viewer, theme, API fetcherror/recovery.
  Không coi fetch giả lập là mất mạng vật lý hoặc chứng nhận WCAG toàn bộ.
- [Resource snapshot](completion-resources.txt): RSS/PSS đo riêng; Docker working
  set không đồng nhất với RSS hay không gian địa chỉ VmSize.
- [Bảo toàn demo](completion-rollout.json): Node20.20.2→22.23.3; users/nodes/
  session versions/key/env/login giữ nguyên; metrics/audit không bị xóa.
  Không login/logout tài khoản chủ dự án trong lúc cập nhật demo chính.
- [Dependency review](dependency-review.md): runtime4 package; toàn câyGateway9,
  Dashboard9. Chưa tìm đường auth bypass cụ thể trong cấu hình hiện dùng; cảnh
  báo thư viện vẫn OPEN, không đổi số audit thành0 hoặc tự viết lại JWT.
- Telegram gửi thật ngày16/10 có [log riêng](telegram-live.txt). Ngày18/10 đã đọc
  `getMe` đúng bot. Sau đó CPU host thật vượt85% lúc build, dịch vụ live tự gửi
  cảnh báo; [audit và API acknowledgement](completion-cpu-telegram-live.json)
  ghi rõ88,66%/87,25%, message14/15. Không chạy thêm lệnh gửi payload thử Telegram;
  không suy từ CPU giả lập thành CPU vật lý hoặc kết quả Windows.

Kiểm tra cuối phát hiện `demo.py up` có thể dùng imageWorker cũ đã tồn tại dù
source đổi. Đã sửa bước upWorker có `--build`, build/recreate thật và chạy lại
nguyên lệnh up thành công. Binary mới nhận `--validate-config` và `--check`;
diagnostic lấy mẫu thật không gửi HTTP.

Một lượt SSH ban đầu bị ảnh hưởng do người chạy test cho pauseWorker và SSH cùng
lúc. Đã ngắt bài liveness, `finally` khôi phục Worker và chạy lại tuần tự thành
công. Không coi lần đó đạt và không sửa kỳ vọng test để che lỗi sản phẩm.

## Chạy lại và phần còn chặn

Các lệnh đã chạy từ root repository:

```sh
python3 deploy/scripts/demo.py up
make test
python3 deploy/scripts/demo.py check --env-file keys/completion-check.env --project zt_completion_check
python3 tests/demo-liveness.py --env-file keys/completion-check.env --project zt_completion_check
python3 deploy/scripts/demo.py check-cpu --env-file keys/completion-check.env --project zt_completion_check
```

Ba bài runtime/liveness/CPU chạy tuần tự trên cụm riêng. Sau bàn giao cụm thử đã
dọn đúng project/volume do phiên này tạo; cần `demo.py up --env-file ... --project
zt_completion_check` trước khi chạy lại các lệnh check. Không dùng `down -v` với
demo chính. `check`/liveness có logout tài khoản demo trên Gateway được chọn;
chạy trên bản chính sẽ thu hồi phiên của tài khoản đó.

Để đóng phần Windows cần một VM thật, theo [Windows Worker](../WINDOWS_WORKER.md):
cài tunnel/sshd/Agent, trả trusted host PUBLIC key để register, chạy native tests,
kiểm chứng API/SSH/Viewer/logout, reboot, CPU/offline/recovery và WorkingSet.
Sau đó thử transport/Internet từ máy độc lập. Không đổi nhãn Docker thànhVM,
không gán cross-build hoặc PowerShell parse thành PASS Windows.

Mốc RAM Agent là khoảng10MB; bản Linux mới≈11MiB, cần nói đúng số đo và đo lại
Windows. Cụm dịch vụ128MiB snapshot chưa chứng minh tổng RAM toàn bộ VM/OS trong
500MB–1GB. Không thêm cache/DB chỉ để tăng lượng RAM tiêu thụ.
