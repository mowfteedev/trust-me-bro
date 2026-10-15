# Tiến độ — 2026-10-16

## Phạm vi và Git

- Chủ dự án đã cho tiếp tục code/cấu hình/kiểm chứng, không làm slide/báo cáo môn học.
- Nhánh duy nhất: `minh-thanh`; nền Round4 `8d559101fc9bb8c45a5b39fafb5f8ff700724477`.
- `main` giữ tại `1926d4e`, không merge/push/deploy production.
- Sáu báo cáo untracked đã có từ đầu được giữ nguyên và không đưa vào commit này.
- Hai tài liệu môn học tạo ngoài ý muốn đã chuyển ra `/tmp/zt-unrequested-documents/`,
  không nằm trong repository/bàn giao.
- Đã đọc/lưu 10 skill, 3 workflows; snapshot22tệp có manifest SHA256.

## Đã thực hiện

- WireGuard kernel thật, helper chung namespace Gateway; worker demo có SSH Ed25519,
  chỉ nghe VPN, firewall namespace DROP và không publish port. Private SSH chmod400.
- Cụm demo `zt_demo` dùng env/volumes riêng; giữ `.env` và DB cũ. Bootstrap không
  xoay khóa; setup CLI dùng stdin + transaction, từ chối ghi đè định danh khác.
- Online/Stale/Offline, CPU/offline incident + audit atomic, resolve và chống lặp;
  sửa timestamp microsecond guard làm bỏ lỡ Offline. Telegram mặc định dry-run.
- Migration008 bỏ tỷ lệ RAM/disk lưu dư; đọc tỷ lệ từ bytes, giữ API. Không sửa001–007.
- Dashboard hiển thị network/uptime, sửa dữ liệu stale và lỗi mạng, bỏ claims/menu
  chưa có chức năng, sửa theme bị HTML ép dark, giữ bố cục. JWT giới hạn HS256.
- Lockfiles và build npmci; README/demo/VM runbook cùng API contract bám source thật.

## Bằng chứng cuối

- Gateway tsc và Dashboard tsc/Vite build đạt. `docs/verification/build-start.txt`,
  `dashboard-build.txt`.
- 11 Agent unit +11 Gateway Vitest đạt; Gateway mock DB/fetch, không là runtime.
- `demo.py check`:16 kiểm tra cụm thật, SSH/PTY/audit START+END cùng phiên mới,
  logout thu hồi JWT và đóng SSH đang mở.
- Cảnh báo CPU: payload/timestamp giả lập, Fastify inject + PostgreSQL thật trong
  DB tạm riêng; không chèn dữ liệu giả vào dashboard demo.
- Upgrade007→008: DB test riêng bảo toàn UUID/FK/bytes/CPU/history/users/alerts/audit;
  parent+partitions không lưu2tỷ lệ dư; latest/history trả tỷ lệ từ bytes và số JSON.
- Chromium desktop1920x1080/tablet768x1024/mobile375x667: login, viewer, terminal,
  logout, lỗi mạng; không overflow/JSerrors. Đã xem ảnh thực tế và sửa tương phản theme.
- Dừng worker thật: Stale17.80s, Offline32.82s, một incident; khôi phục Online và resolve.
- Mạng thật: handshake/transfer WireGuard; transportSSH bị chặn, SSH qua VPN thành công.
- YAML OpenAPI parse và localrefs đạt; Python/shell syntax và gitdiffcheck sạch.
- Test Python dò chuỗi cũ giữ nguyên. Baseline trước sửa146/151; kỳ vọng khóa600,
  timeout10s, schema007... không dùng để chứng nhận chức năng schema008.

## Giới hạn và điểm còn thiếu

- MiniAgent RSS23.03MiB/PSS21.12MiB, chưa đạt mục tiêu khoảng10MB; giữurllib chuẩn
  thay vì tự viết HTTP parser. Snapshot tổng container112.199MiB, không phải benchmark.
- VMware/VirtualBox và quét từ Internet thật CHƯA KIỂM CHỨNG: chưa có hypervisor/VM
  khả dụng. Đã hỏi một lần và có `docs/VM_SETUP.md`; cần môi trường từ chủ dự án.
- Telegram live hoãn theo yêu cầu; không gửi thông điệp ra ngoài.
- Build/npm audit còn4cảnh báo phụ thuộc (1moderate,2high,1critical); chưa nâng major
  framework, không chứng nhận production hoặc audit sạch.
- Dừng mở rộng. Chỉ làm tiếp khi có VM/Telegram hoặc yêu cầu cụ thể mới.

## Chạy lại

`python3 deploy/scripts/demo.py up` rồi `check`; Dashboard `https://localhost`.
Tài khoản demo-admin/demo-viewer, mật khẩu cục bộ trong keys/demo-login.env0600.
`down` giữ volumes. Cụm đang chạy để chủ dự án dùng demo; không dừng dịch vụ khác.
Commit bàn giao xem `git log -1 --oneline`.
