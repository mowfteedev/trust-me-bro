# Bộ nhớ quy tắc dự án

## Nguồn và phạm vi

- Ngày nạp: 2026-10-16 (Asia/Ho_Chi_Minh).
- Nguồn: `/home/mowftee/Templates/mowftee-guild`.
- Đã đọc 10 `SKILL.md`, README, 3 workflows và 5 mẫu bộ nhớ.
- Bản gốc: `mowftee-guild/`; `manifest.json` ghi SHA-256 của 22 tệp đã sao chép.
- Đây là bộ nhớ trên đĩa của dự án; các phiên sau đọc qua `AGENTS.md`.

## Chỉ đạo của chủ dự án

- Đính chính mới nhất: chủ dự án đã cho tiếp tục phần code, cấu hình và kiểm
  chứng, nhưng không muốn soạn slide/báo cáo môn học. Không tự tạo các sản phẩm
  này. Chỉ duy trì README, hướng dẫn chạy/demo và bằng chứng kỹ thuật cần thiết.

- Chỉ làm trên `minh-thanh`, tuyệt đối không merge vào main.
- Hoàn thiện đồ án theo phiếu giao, chạy thật, demo ổn, giải thích được.
- Tinh gọn, chuẩn mực, giữ kiến trúc. Không nâng phạm vi lên production.
- Bản nền Round 4 là `8d55910`; kiểm tra Git thực tế, giữ thay đổi chưa commit.
- Telegram chưa cần tích hợp tài khoản thật; chủ dự án bổ sung sau. Được giả lập
  để kiểm thử, ghi rõ giới hạn.
- Tự thực hiện và kiểm chứng các việc bắt buộc; chỉ hỏi khi thiếu quyết định phạm vi
  hoặc có nguy cơ ghi đè công việc/xóa dữ liệu. Không tự mở vòng nâng cấp mới.

## Áp dụng guild

- Tech lead: chọn thiết kế đơn giản, phân công có ranh giới, cập nhật bộ nhớ.
- Backend/database/security/devops: hợp đồng API, xác thực và RBAC, transaction,
  timeout, bảo vệ bí mật, mạng WireGuard và Zero Inbound theo phiếu giao.
- Frontend/designer: dữ liệu thật, đủ Loading/Empty/Error/Success, trạng thái rõ,
  giao diện dùng được trên màn hình nhỏ.
- Reviewer/tester: phản biện độc lập, nêu nguyên nhân/bằng chứng/cách sửa; không
  chứng nhận hoàn thành khi chưa chạy luồng chính. Không dùng sleep tùy tiện để
  che race condition trong bài test.
- Doc writer: chỉ lệnh cài đặt đã chạy thử, kịch bản demo và giới hạn; không soạn
  slide hoặc báo cáo môn học trong phạm vi hiện tại.
- Mẫu guild chỉ là mẫu, không sao chép số PASS, SLA, chữ ký hoặc chứng nhận.
- Áp dụng delegation bằng công cụ sẵn có; không đổi nhánh cho subagent khi người
  dùng đã yêu cầu làm trên `minh-thanh`.

## Đầu vào

- Phiếu giao: `/home/mowftee/Downloads/Nhom_9_Phieu giao hoc phan ĐA CSN.doc`.
- Nhóm 9, lớp 2026FE6083001; giảng viên TS. Nguyễn Đắc Hải.
- Hạn trên phiếu: 16/12/2026.
- Sản phẩm: 01 slide, 01 mô hình/mô phỏng, 01 quyển báo cáo theo QĐ 815/QĐ-ĐHCN.
- Kỹ thuật: WireGuard M2M, Zero Inbound máy con, VM + Docker, React Dashboard,
  WebSocket/SSH/PTY, ADMIN/VIEWER, CPU/RAM/disk/network/uptime, Telegram sự cố
  offline và CPU, UDP 51820 tại Gateway, Ed25519 chmod 400, heartbeat 3s,
  phát hiện mất tín hiệu 15–45s, RAM agent khoảng 10MB và cụm 500MB–1GB,
  trạng thái Online/Stale/Offline; Fastify/TypeScript/PostgreSQL/Linux/Compose.
