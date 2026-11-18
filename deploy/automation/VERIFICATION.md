# Kiểm chứng automation — 18/11/2026

Giữ nhánh cải thiện; không thay EC2, TV box, Cloudflare hoặc tài khoản thật.
Không gửi Telegram trong đợt này. Bằng chứng/script/log riêng tư ngoài Git.

- Runner nghiệm thu: **13 nhóm PASS**. Gateway278 tests PASS, ba ca transport
  opt-in bỏ qua trong unit; Dashboard36 PASS; Python89/native42 PASS; Agent
  và Go peer-helper PASS. Windows amd64 và Linux arm64 cross-build PASS.
- PostgreSQL16 thật: **11 nhóm enrollment/bootstrap PASS**; hash-only mã,
  quyền SQL, concurrent claim/retry, hết hạn/thu hồi/xung đột, DB commit rồi
  lỗi file và thử lại; bootstrap không ghi đè mật khẩu đã đổi hoặc nâng Viewer.
- Gateway: chạy bộ cài thật trên Docker lab riêng, bốn core, TLS xác minh CA
  và Gateway ID. Đã thử lại từ trạng thái cài dở và một bản cài sạch cuối cùng.
  Host collector được bỏ qua bằng cờ lab; chưa kiểm cài mới collector/systemd
  trên host Gateway bằng bộ cài này. Collector hiện hữu trên EC2 không đổi.
- Worker: Debian12 KVM mới, 1vCPU/768MiB, kernel WireGuard, systemd/SSH/nft thật.
  Cài qua console, HTTPS claim → peer → handshake → Agent → PostgreSQL → SSH
  ghim host key PASS. Chạy lại và reboot giữ đúng ba hash khóa/token; sau boot
  service/VPN/heartbeat/SSH tự hoạt động, không chạy lại installer.
- Đổi mật khẩu qua HTTPS: cũ bị từ chối, JWT cũ hết hiệu lực; chạy lại Gateway
  giữ mật khẩu mới. Không có mật khẩu Dashboard rõ trong thư mục keys của
  bản cài. Mật khẩu dịch vụ vẫn nằm trong env riêng0600 theo thiết kế.
- PowerShell trên Linux: **25 ca parser/hàm/HTTPS thật PASS**, gồm PE64, mã
  ghép, CA đúng/sai, hostname, hết hạn, redirect và không gửi secret khi TLS
  thất bại. Không suy thành Windows service/firewall runtime PASS.
- Review đã sửa các lỗi stdin bị tiến trình con đọc, OTP rỗng, rollback báo
  hoàn tất dù service chưa phục hồi, callback CA phụ thuộc PowerShell runspace,
  thiếu kiểm PE64, mất host key và nhập nhầm origin Gateway. Có hồi quy phù hợp.
- Offboarding runtime (PostgreSQL 16 thật + Fastify inject): kiểm chứng qua
  `tests/runtime-offboarding.cjs` với evidence `real_postgres_and_fastify_inject`.
  Xác nhận khớp tên máy chủ (`confirm_node_name`), chuyển trạng thái RETIRING sang
  REVOKED, thu hồi tức thì phiên SSH, cấp và xoay vòng cleanup token hash-only,
  xác minh capability bundle, xử lý biên bản Worker (COMPLETED/NEEDS_REVIEW), tạo
  tệp yêu cầu gỡ peer `.remove`, giải phóng IP/name sau root WireGuard ACK, bảo lưu
  lịch sử audit và chặn tái sử dụng token/khóa cũ.
- Windows uninstaller pure test: kiểm tra parser, AST và hàm gỡ bỏ tự động qua
  `tests/automation-worker-functions.ps1` (18/18 checks PASS) và
  `tests/windows-worker-uninstall-functions.ps1` (60/60 checks PASS). Đã bao phủ
  đầy đủ các hồi quy theo review của Codex:
  + Tệp không thuộc journal sở hữu (unowned file) được giữ nguyên, không xóa.
  + Tệp thuộc journal nhưng bị sửa đổi nội dung (modified file) được giữ nguyên, báo conflict.
  + Tệp tạo mới chưa bị sửa đổi được chứng minh fingerprint và xóa an toàn.
  + Tệp đã tồn tại trước khi cài được khôi phục từ backup tin cậy.
  + Khởi tạo journal mới với các pending steps an toàn dưới StrictMode Latest, không ném lỗi thuộc tính thiếu.
  + Journal đọc lại từ `ConvertFrom-Json` (PSCustomObject) được chuẩn hóa và lưu checkpoint tiến độ an toàn, không còn lỗi indexing vào PSCustomObject.
  + Receipt-only retry khi status COMPLETE mất phản hồi mạng sẽ chỉ gửi lại biên bản hoàn tất mà không chạy lại các bước gỡ bỏ dịch vụ/tệp.
  + Gọi lại khi đã hoàn tất (idempotent) trả về ngay lập tức không thực hiện thay đổi hệ thống.
  + Authorization bundle cũ từ lần cài đặt trước bị chặn triệt để khi `node_id` hoặc `gateway_id` khác với bản cài mới.
  + Phân biệt rõ before-state và after-state của SSH do bộ cài thiết lập (không coi
    thay đổi hợp lệ của bộ cài là thay đổi ngoài luồng; người dùng can thiệp sau cài mới báo conflict).
- Kiểm thử tích hợp thực tế đã có bằng chứng (lab riêng tư):
  + Linux Worker uninstaller trên VM thật (`tests/runtime-offboarding-linux.py`):
    Đã kiểm nghiệm trên Debian 12 KVM VM riêng (`acceptance-result.json` đạt 5/5 checks PASS:
    `setup`, `install`, `offboard`, `verify`, `cleanup`).
  + Dashboard UI trên trình duyệt (`tests/runtime-offboarding-ui.py`):
    Đã kiểm nghiệm trên Firefox headless + geckodriver với fake API fixture
    (`result.json` đạt 30/30 checks PASS 100%).

**CHƯA KIỂM CHỨNG:**
- Windows native runtime: **CHƯA KIỂM CHỨNG** (chưa có máy chủ Windows vật lý / VM
  Windows native để kiểm tra cài/reboot/gỡ bỏ dịch vụ và firewall runtime thật;
  Windows CI và local test chỉ kiểm parser/hàm trong container PowerShell, không đột biến Windows thật).
- Automation Linux arm64 trên phần cứng thật.
- Cài mới host collector trên Gateway systemd và raw Internet tới firewall Worker.
- NAT/WARP không phải bằng chứng firewall host loại gói Internet.

Đã dọn các container/network/volume lab và tắt VM; Worker Docker hiện hữu
giữ nguyên. Doctor EC2 chỉ đọc kết thúc0vấn đề. Source mới chưa triển khai
lên hệ thống đang phục vụ; enrollment mặc định tắt ngoài overlay automation.
