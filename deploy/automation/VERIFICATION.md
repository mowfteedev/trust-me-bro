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
- Windows uninstaller pure test: kiểm tra parser và hàm gỡ bỏ tự động qua
  `tests/automation-worker-functions.ps1` (gọi `windows-worker-uninstall-functions.ps1`).
  Không suy diễn thành kiểm chứng runtime trên Windows thật.
- Kiểm thử tích hợp tùy chọn (chạy thủ công trong lab riêng):
  + Linux Worker uninstaller trên VM thật (`tests/runtime-offboarding-linux.py`):
    Yêu cầu VM Debian 12 riêng, quyền root, Docker Compose v2 và các image Gateway.
    Lệnh: `python3 tests/runtime-offboarding-linux.py --lab-dir /path/to/private/lab-dir`
  + Dashboard UI trên trình duyệt (`tests/runtime-offboarding-ui.py`):
    Yêu cầu trình duyệt Firefox, geckodriver và `dashboard/dist` đã build. Sử dụng
    ThreadingHTTPServer với fake API fixture trên `127.0.0.1`, không chạm Gateway thật.
    Lệnh: `python3 tests/runtime-offboarding-ui.py --output-dir /path/to/private/ui-out --headless`

**CHƯA KIỂM CHỨNG:** cài/reboot/gỡ bỏ dịch vụ/firewall trên Windows thật (chưa
có môi trường Windows native), kiểm thử VM Linux và UI browser hiện chưa chạy
nghiệm thu xong (IN_PROGRESS, không ghi nhận PASS trước khi có log thật),
automation Linux arm64 trên phần cứng thật, cài mới host collector trên Gateway
systemd và raw Internet tới firewall Worker. Windows CI chỉ kiểm parser/hàm, không
cài dịch vụ. NAT/WARP không phải bằng chứng firewall host loại gói Internet.

Đã dọn các container/network/volume lab và tắt VM; Worker Docker hiện hữu
giữ nguyên. Doctor EC2 chỉ đọc kết thúc0vấn đề. Source mới chưa triển khai
lên hệ thống đang phục vụ; enrollment mặc định tắt ngoài overlay automation.
