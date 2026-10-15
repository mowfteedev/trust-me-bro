# ADR-[Mã số]: [Tên Quyết Định Kiến Trúc Ngắn Gọn]

- **Ngày ban hành**: [YYYY-MM-DD]
- **Người đề xuất chính**: `@tech-lead`
- **Các bên phản biện & đồng thuận**: `@database`, `@backend`, `@security`, `@devops`
- **Trạng thái**: [Đề xuất (Proposed) | Được chấp thuận (Accepted) | Bị thay thế (Superseded by ADR-XXX)]

---

## 1. Bối Cảnh Kỹ Thuật & Thách Thức (Context & Problem Statement)
- Vấn đề kỹ thuật cụ thể mà hệ thống đang gặp phải là gì?
- Những ràng buộc thực tế: Ngân sách máy chủ ($/tháng), thời gian phát hành (deadline), quy mô đội ngũ (số lượng dev), tải lượng dự kiến (RPS, lưu lượng dữ liệu).
- Tại sao giải pháp hiện tại không còn đáp ứng được?

---

## 2. Quyết Định Kiến Trúc Lựa Chọn (Decision Outcome)
Chúng tôi quyết định lựa chọn: **[Tên giải pháp / Mẫu thiết kế / Công nghệ lựa chọn]**.

### Chi tiết giải pháp triển khai:
1. **Ranh giới nghiệp vụ (Bounded Context)**: [Mô tả module hoặc tầng bị ảnh hưởng].
2. **Giao thức kết nối**: [RESTful / gRPC / In-memory Service / Event-driven].
3. **Mô hình dữ liệu & Toàn vẹn**: [ACID Transaction / Eventual consistency].

---

## 3. Các Phương Án Thay Thế Đã Bị Loại Bỏ (Alternatives Considered)

### Phương án A: [Tên phương án, ví dụ: Sử dụng Kafka và Microservices]
- *Lý do loại bỏ*: Chi phí vận hành quá cao so với quy mô MVP; đội ngũ chưa đủ nhân sự quản trị cụm K8s; phát sinh rủi ro phân tán dữ liệu không cần thiết.

### Phương án B: [Tên phương án, ví dụ: Sử dụng MongoDB thay vì PostgreSQL]
- *Lý do loại bỏ*: Thiếu ràng buộc toàn vẹn khóa ngoại (Foreign Keys) cho các bảng giao dịch tài chính; chi phí RAM lớn hơn.

---

## 4. Phân Tích Đánh Đổi & Hệ Quả (Trade-offs & Consequences)

### ✅ Điểm Lợi (Positive Consequences):
- Tốc độ phát triển nhanh hơn gấp [X] lần.
- Chi phí hạ tầng duy trì ở mức tối thiểu (< $50/tháng).
- Dễ bảo trì, kiểm thử tích hợp (Integration Test) chạy cục bộ chỉ trong vài giây.

### ⚠️ Điểm Thiệt & Ràng Buộc Phải Chấp Nhận (Negative Consequences):
- Toàn bộ ứng dụng phải triển khai cùng nhau (Deploy together).
- Cần kỷ luật nghiêm ngặt ở tầng linter để tránh import chéo giữa các module.
- Nợ kỹ thuật tạm thời: [Mô tả nợ kỹ thuật nếu có].

---

## 5. Kế Hoạch Xử Lý Sự Cố & Hoàn Tác (Failure Mode & Rollback Strategy)
- **Nếu giải pháp này thất bại trong production**: Hệ thống sẽ ứng xử ra sao? (Fallback chain).
- **Quy trình hoàn tác (Rollback Plan)**: Các bước đảo ngược mã nguồn và migration database an toàn mà không làm mất dữ liệu người dùng.
