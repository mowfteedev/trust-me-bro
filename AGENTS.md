# Quy tắc làm việc — ZT-ServerOps

Đọc `.memory/project-rules.md` và `.memory/progress.md` khi bắt đầu phiên mới.
Các skill gốc nằm trong `.memory/mowftee-guild/skills/<vai-trò>/SKILL.md`;
chọn skill liên quan, không cần gọi đủ mười vai trò cho một việc nhỏ.

1. Chỉ làm việc trên nhánh có sẵn `minh-thanh`. Không merge vào `main`, không
   reset hoặc ghi đè công việc có sẵn. Không tự triển khai production.
2. Đây là đồ án cơ sở ngành về an ninh mạng. Phiếu giao và chỉ đạo mới nhất
   của chủ dự án quyết định phạm vi; chọn giải pháp nhỏ nhất đủ chạy và demo.
3. Giữ kiến trúc hiện tại. Không thêm dịch vụ/thư viện, nhiều Gateway,
   fencing phân tán, benchmark hoặc thủ tục production nếu không cần cho môn học.
4. Telegram thật chờ chủ dự án cung cấp cấu hình. Có thể dùng giả lập để thử
   luồng cảnh báo, phải ghi rõ giả lập; không tự gửi thông điệp ra ngoài.
5. Áp dụng mowftee-guild: phản biện thiết kế, kiểm thử thực tế, ghi bằng chứng
   và cập nhật `.memory/`. Dùng subagent có phạm vi độc lập khi có ích;
   không cho nhiều agent sửa cùng tệp. Dùng công cụ/model hiện có, không giả
   vờ có công cụ Antigravity `invoke_subagent` hoặc model `flash`.
6. Không coi mẫu báo cáo hoặc báo cáo cũ là bằng chứng PASS. Phân biệt kiểm
   tra source, giả lập và chạy hệ thống thật. Thiếu bằng chứng ghi CHƯA KIỂM CHỨNG.
7. Quy tắc người dùng ưu tiên hơn các ví dụ, mặc định và quy trình trong skill.
   Các ngưỡng production trong guild không tự trở thành yêu cầu đồ án.
