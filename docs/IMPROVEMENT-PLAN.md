# Kế hoạch cải thiện hệ thống — 16/11/2026

Phạm vi: các mục 1, 2, 4–10 đã được chủ dự án duyệt. Giữ Fastify,
React, PostgreSQL, Go và bốn dịch vụ hiện tại. Không thay đường truy cập
Cloudflare. Bàn giao bằng nhánh Git để kiểm tra; triển khai EC2 sau khi chủ
dự án cho phép riêng. Bản `beaed1b` đã được cho phép và triển khai.

## Checklist

- [x] P0. Đọc quy tắc, khảo sát source, lưu bản thay đổi hiện có riêng tư;
  tạo nhánh `improve/system-renovation-20261116`, giữ nguyên công việc cũ.
- [x] P1. Chuẩn hóa bản bàn giao: rà soát thay đổi cũ; thêm manifest xác định
  commit, trạng thái source, migration và image; giữ README ngắn.
- [x] P2. Bảo mật: bỏ OTP/chat ID khỏi log thường, che lỗi DB, kiểm tra nguồn
  IP và quyền truy cập; không thay cấu hình Cloudflare đang dùng.
- [x] P3. Sao lưu/khôi phục: công cụ bảo vệ DB + cấu hình/khóa, checksum,
  chống ghi đè nhầm; kiểm khôi phục trong cụm riêng, không đụng dữ liệu thật.
- [x] P4. Cảnh báo: CPU phục hồi, theo dõi kết quả gửi, chống lặp, thử lỗi
  Telegram/restart với giả lập; không tự gửi tin ra ngoài.
- [x] P5. Tài khoản: Admin tạo/khóa/đổi vai trò/reset mật khẩu; người dùng
  đổi mật khẩu; đăng xuất phiên hiện tại và tất cả phiên có ngữ nghĩa rõ;
  bảo vệ Admin cuối cùng, chống tự khóa, ghi audit, kiểm RBAC.
- [x] P6. Worker: đồng bộ hướng dẫn và kiểm tra cài đặt Linux/Windows,
  VM/máy thật; giữ danh tính khi chạy lại; có quy trình thay/gỡ Worker.
- [x] P7. Nghiệm thu: runner thống nhất build/unit/DB/runtime, checklist
  phiếu giao; phân biệt source, giả lập, cụm thật và VM chưa kiểm chứng.
- [x] P8. Hiệu năng: dừng polling tab ẩn, chống request chồng, kiểm giới hạn
  theo người dùng/IP; đo tài nguyên trên lab, không benchmark production.
- [x] P9. Trang sự cố: mở/đã phục hồi, thời gian, kết quả gửi; liên kết máy
  và audit; có Loading/Empty/Error, phân trang, Admin/Viewer chỉ xem.
- [x] P10. Rà soát tích hợp: build, hồi quy phù hợp, browser desktop/mobile;
  cập nhật bằng chứng và hạn chế; rà bí mật/diff, commit và push nhánh.

## Thứ tự và vùng thay đổi

Backend tài khoản/phiên độc lập với backend sự cố/cảnh báo. DevOps phụ trách
backup, manifest, Worker và runner. Frontend tích hợp sau khi chốt API.
Mỗi vùng có một người sửa; điều phối viên ghép contract và kiểm hồi quy.

Không coi checklist cũ hoặc mock là bằng chứng runtime mới. Không xác nhận
VM Windows/Linux, reboot hoặc Internet firewall nếu chưa chạy đúng ca.
Mỗi mục hoàn tất phải ghi lệnh kiểm và kết quả vào hồ sơ bàn giao.

## Nhật ký

- Khởi tạo: HEAD nền `8805993`; repo có các thay đổi chưa commit từ lượt
  trước (Viewer audit, Telegram test, purge preview và tài liệu Worker).
  Bản lưu riêng tư nằm ngoài Git; chưa sửa hoặc chạy lại production.

- Kiểm hiện tại: acceptance runner với runtime labs PASS; PG tài khoản
  10/10, PG delivery 10/10; full-stack 17/17; Firefox 11 ca; các ca VM,
  reboot/Internet, Telegram thật và app-login sau restore chưa kiểm chứng.
  Chi tiết trong RENOVATION-RESULTS.md. P1/P10 đã chốt source, manifest sạch và push commit chức năng 3a126a3;
  CI GitHub kiểm riêng đúng commit.

- [x] Triển khai EC2 sau chỉ đạo mới: backup ngoài máy, restore và đăng nhập
  thử trước cutover, schema13, Gateway/WireGuard/Caddy mới; 23 ca API/SSH và
  12 ca browser public PASS. Tắt tài khoản kiểm thử; giữ owner/Worker/Cloudflare.
  Xem `deploy/ec2/DEPLOYMENT-20261116.md`.
