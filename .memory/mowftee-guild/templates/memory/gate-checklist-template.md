# 🛡️ Biên Bản Thẩm Định Cổng Nghiệm Thu (Quality Gate Checklist)

- **Dự án**: [Tên Dự Án]
- **Cổng thẩm định**: [CỔNG 1: Kiến trúc | CỔNG 2: Foundation | CỔNG 3: Triển khai | CỔNG 4: Đối kháng | CỔNG 5: Bàn giao]
- **Thời gian đánh giá**: [YYYY-MM-DD HH:MM UTC]
- **Chu kỳ hoàn thiện thứ**: [Lần 1 / Lần 2 / Lần 3]

---

## 🔍 I. BẢNG KIỂM TRA ĐIỀU KIỆN TIÊN QUYẾT (PRE-FLIGHT GATES)

### 1. Khía Cạnh Mã Nguồn & Chất Lượng (`@code-reviewer`)
- [ ] Không có bất kỳ lỗi 🔴 **Blocker** nào còn tồn đọng.
- [ ] Không có bẫy mã do AI sinh ra (AI Hallucinations, Silent Catch blocks, `forEach async`).
- [ ] Toàn bộ các hàm/service mới đều có kiểu dữ liệu TypeScript Interfaces rõ ràng.
- [ ] **Chữ ký xác nhận `@code-reviewer`**: `[PASS / REJECT]`

### 2. Khía Cạnh An Toàn Thông Tin (`@security`)
- [ ] Quét Secret Scanner đạt 0 phát hiện (Không lộ API Keys, mật khẩu, JWT secrets).
- [ ] Quét lỗ hổng phân quyền IDOR: 100% các câu truy vấn sửa/xóa đều ràng buộc `user_id`.
- [ ] Cấu hình bảo mật Helmet và CORS chặt chẽ, không dùng `origin: '*'`.
- [ ] **Chữ ký xác nhận `@security`**: `[PASS / REJECT]`

### 3. Khía Cạnh Kiểm Thử Thực Chiến (`@tester`)
- [ ] Toàn bộ Unit & Integration tests đạt **Exit Code 0** (Độ bao phủ >= 80%).
- [ ] Bộ test Playwright E2E chạy pass 100%, **tuyệt đối không chứa lệnh sleep()**.
- [ ] Chạy lặp lại 10 lần liên tục (`--repeat-each=10`) đạt 10/10 lần pass (0% flaky).
- [ ] Đã vượt qua các bài test phá hoại biên: Bơm chuỗi 50.000 ký tự, Rage clicks 10 lần/s, Chaos Network.
- [ ] **Chữ ký xác nhận `@tester`**: `[PASS / REJECT]`

### 4. Khía Cạnh Giao Diện & Thiết Kế (`@designer` & `@frontend`)
- [ ] Đã kiểm chứng thực tế trên màn hình di động nhỏ **375px** (không tràn viền ngang).
- [ ] Điểm chạm nút bấm cảm ứng đạt tối thiểu **44x44px**.
- [ ] Bao bọc trọn vẹn 4 trạng thái: Skeleton Loading, Empty State, Error State (có Retry), Success State.
- [ ] Tỉ lệ tương phản màu sắc chữ và nền đạt chuẩn **WCAG 2.2 AA (>= 4.5:1)**.
- [ ] **Chữ ký xác nhận `@designer` / `@frontend`**: `[PASS / REJECT]`

---

## 📸 II. DANH MỤC BẰNG CHỨNG HỆ THỐNG ĐÍNH KÈM
- Ảnh chụp màn hình Desktop (1920x1080): `[Link tới file ảnh]`
- Ảnh chụp màn hình Mobile (375x667): `[Link tới file ảnh]`
- Log kết quả kiểm thử: `[Link tới file test-results.json]`
- Playwright Trace file: `[Link tới trace.zip nếu có]`

---

## 🎯 III. QUYẾT ĐỊNH CỦA HỘI ĐỒNG TÁC CHIẾN

- [ ] **CHẤP THUẬN (APPROVED)**: Đạt chuẩn 100%, chính thức mở cổng chuyển sang giai đoạn kế tiếp! 🚀
- [ ] **TỪ CHỐI (REJECTED)**: Phát hiện lỗi vi phạm, trả về bảng phân công để thực hiện chu kỳ sửa đổi (Revision Cycle).

**Lý do từ chối (nếu có)**:
> *[Ghi rõ tên file, số dòng, và mã lỗi cụ thể cần sửa trước khi thẩm định lại]*
