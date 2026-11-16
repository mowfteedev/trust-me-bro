# Triển khai EC2 — bản beaed1b

Đã áp dụng bản chức năng `beaed1b` trên EC2 sau khi chủ dự án cho phép.
Không merge `main`, không thay Cloudflare, khóa Worker hoặc tài khoản chính.

- Sao lưu DB, cấu hình và source; giữ snapshot runtime thực tế để quay lui.
  Backup đã chép ra ngoài EC2 và kiểm checksum, không đưa vào Git.
- Khôi phục chính DB backup trong cụm riêng, nâng schema 11 → 13, kiểm đăng
  nhập Admin/Viewer và logout từng phiên/tất cả thành công; Telegram tắt ở lab.
- Chạy migrator/provisioner rồi tạo lại Gateway cùng helper WireGuard và Caddy.
  Chuyển bản và kiểm tra ban đầu: **7,642 giây**; không cần rollback.
- PostgreSQL giữ nguyên container và dữ liệu. Hai Worker tiếp tục HEALTHY.
- Kiểm đường public: **23 ca API/Web SSH PASS**, gồm SSH vào cả hai Worker,
  thu hồi đúng SSH khi logout và giữ phiên đăng nhập thiết bị khác.
- Firefox thật: **12 ca PASS** trên desktop/390px, gồm hai trang mới,
  Admin/Viewer, nhật ký/sự cố và bố cục không tràn ngang.
- JavaScript public khớp SHA256 với image đã kiểm thử; tài khoản kiểm thử
  đã tắt lại, không còn phiên SSH kiểm thử hoạt động.
- Bốn core services healthy; collector mới dưới 15 giây. Bot live được kiểm
  bằng `getMe`, kênh ghép giữ nguyên; không gửi tin thử hay tạo sự cố thật.
- Doctor chỉ đọc kết thúc với **0 vấn đề**; không bootstrap hay logout tài khoản chính.

Image đã áp dụng:

```text
Gateway sha256:6b40a9848556d069345c16d42ceda8b0de5b3fa08fa6fe9f9c2f873d5bfc7d71
Caddy   sha256:111b653ed512e4ddf53ec8fde5a13bcf5a0656f9706aa25c32043d97a68716f2
```

Log, backup, thông tin kiểm thử và manifest triển khai nằm trong thư mục
riêng tư ngoài Git. Không công bố credential, token, khóa hoặc dump DB.
VM Windows/Linux, reboot, firewall từ Internet và gửi cảnh báo Telegram thật
ở phiên bản mới vẫn cần kiểm riêng; không suy PASS từ các ca trên.

Tải lại Dashboard để nạp giao diện mới; thông tin đăng nhập cũ được giữ nguyên.
