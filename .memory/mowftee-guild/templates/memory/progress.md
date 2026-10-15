# 📌 Bảng Tiến Độ & Ma Trận Cổng Kiểm Soát Khép Kín: [Tên Dự Án]
*Cập nhật lần cuối: [YYYY-MM-DD HH:MM UTC] — Quản trị viên: `@tech-lead`*

---

## 🎯 GIAI ĐOẠN HIỆN TẠI (CURRENT MILESTONE)
- **Cổng tác chiến đang mở**: [CỔNG 1: Kiến trúc / CỔNG 2: Foundation / CỔNG 3: Triển khai / CỔNG 4: Thẩm định / CỔNG 5: Bàn giao]
- **Mục tiêu phiên làm việc**: [Mô tả ngắn gọn kết quả cần đạt để đóng cổng hiện tại]
- **Số chu kỳ hoàn thiện (Revision Cycles)**: [Lần 1 / Lần 2 / Lần 3]

---

## 🛡️ MA TRẬN TÁC CHIẾN TAM GIÁC KHÉP KÍN (CLOSED-LOOP TASK MATRIX)

> *Nguyên tắc sống còn: Một đầu việc không bao giờ do 1 người làm đơn độc. Mọi đầu việc đều có **Người Thực Thi**, **Người Phản Biện**, và **Người Gác Cổng Thẩm Định**.*

| Cổng | Đầu Việc Cụ Thể | Thực Thi Chính (Lead) | Phản Biện (Advisor) | Gác Cổng / Test (Gatekeeper) | Trạng Thái | Tiêu Chí Nghiệm Thu (Exit Criteria) |
| :---: | :---|:---:|:---:|:---:|:---:|:---|
| **G1** | Định hình Bounded Contexts & Lập ADR | `@tech-lead` | `@database`<br>`@backend` | `@security` | 🟢 ĐÃ XONG | ADR được duyệt, Threat model STRIDE hoàn tất. |
| **G2** | Thiết kế Schema 3NF & UUIDv7 Migration | `@database` | `@backend` | `@tester` | ⏳ ĐANG LÀM | Migration UP/DOWN chạy pass, lock_timeout = 2s. |
| **G2** | Xây dựng Design Tokens W3C & 6 Trạng thái | `@designer` | `@frontend` | `@tester` | ⏳ ĐANG LÀM | Đạt chuẩn tương phản WCAG 2.2 AA (>= 4.5:1). |
| **G3** | Xây dựng API Clean Architecture & Idempotency | `@backend` | `@tech-lead` | `@tester` | ⚪ CHỜ DUYỆT | Hỗ trợ Idempotency-Key Redis, RFC 7807 Error Envelope. |
| **G3** | Ghép Giao diện Mobile-First (375px) 4 Trạng thái | `@frontend` | `@designer` | `@tester` | ⚪ CHỜ DUYỆT | Không lỗi console, nút bấm >= 44px, có Skeleton. |
| **G4** | Thẩm định mã nguồn, Veto lỗi Blocker | `@code-reviewer` | Toàn team | `@tech-lead` | ⚪ CHỜ DUYỆT | 0 lỗi 🔴 Blocker, diệt sạch bẫy code do AI sinh ra. |
| **G4** | Quét lỗ hổng OWASP, Secret Leaks & IDOR | `@security` | `@backend` | `@tester` | ⚪ CHỜ DUYỆT | 0 lỗ hổng Critical/High, RLS được kiểm chứng. |
| **G4** | Phá hoại Fuzzing biên & Ký Chứng Nhận | `@tester` | `@frontend` | `@tech-lead` | ⚪ CHỜ DUYỆT | Fuzzing 50k chars, Rage clicks pass, 0 sleep test. |
| **G5** | Đóng gói Docker đa tầng < 50MB & Nginx SSL | `@devops` | `@backend` | `@tester` | ⚪ CHỜ DUYỆT | Non-root user, mạng internal_net cô lập DB. |
| **G5** | Viết README 5 giây & Cẩm nang Bàn giao | `@doc-writer` | Toàn team | `@tester` | ⚪ CHỜ DUYỆT | Chạy thử đúng 3 bước trên máy sạch thành công. |

*Quy ước trạng thái*: 
- 🟢 **ĐÃ XONG (Approved)**: Đã vượt qua kiểm định của Gác cổng.
- ⏳ **ĐANG LÀM (In Progress)**: Đang thực thi hoặc đang trong vòng lặp sửa lỗi (Revision).
- 🔴 **BỊ CHẶN (Blocked / Reject)**: Bị Gác cổng phát hiện lỗi Blocker, phải sửa lại.
- ⚪ **CHỜ DUYỆT (Queued)**: Xếp hàng chờ cổng trước mở.

---

## 🔄 NHẬT KÝ VÒNG LẶP PHẢN HỒI (REVISION CYCLES LOG)

| Thời Gian | Cổng | Người Báo Lỗi | Lỗi / Điểm Chặn Phát Hiện | Người Sửa | Kết Quả Thẩm Định Lại |
| :--- | :---: | :---: | :--- | :---: | :---: |
| *[VD: 10:15]* | *G3* | `@tester` | *Nút thanh toán bị bấm 2 lần tạo 2 đơn hàng* | `@backend` | *🟢 Đã thêm Redis lock, test lại pass 10/10* |
| *[VD: 11:30]* | *G4* | `@security` | *Phát hiện commit nhầm JWT_SECRET vào file test* | `@frontend` | *🟢 Đã xóa git cache, chuyển sang .env* |

---

## 🧠 LƯU VẾT KÝ ỨC DỰ ÁN (PROJECT MEMORY INVARIANTS)
> *Các thông tin quan trọng mà mọi Agent khi khởi động phiên làm việc mới BẮT BUỘC phải ghi nhớ:*
1. **Quyết định cốt lõi**: [Ghi lại các công nghệ hoặc cấu trúc đã chốt]
2. **Quy định bảo mật**: [Ví dụ: Không mở port Postgres ra ngoài internet]
3. **Nợ kỹ thuật tạm thời chấp nhận**: [Ghi rõ lý do và kế hoạch thanh toán nợ]
