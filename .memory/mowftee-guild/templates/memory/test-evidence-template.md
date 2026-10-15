# 🧪 Hồ Sơ Bằng Chứng Kiểm Thử & Đo Kiểm Thực Tế (Test Evidence Dossier)

- **Dự án**: [Tên Dự Án]
- **Tính năng / Endpoint**: [Tên Tính Năng]
- **Commit SHA**: `[commit-hash]`
- **Người thực thi đo kiểm**: `@tester (Reality Checker)`
- **Thời gian lập**: [YYYY-MM-DD HH:MM UTC]

---

## 1. 📊 KẾT QUẢ KIỂM THỬ TỰ ĐỘNG (AUTOMATED TEST RUNS)

```text
Test Suites: 8 passed, 8 total
Tests:       64 passed, 64 total
Snapshots:   0 total
Time:        4.218 s
Ran all test suites.
Exit code:   0 (SUCCESS)
Coverage:    Lines 89.2% | Statements 88.7% | Functions 91.0% | Branches 85.4%
```

---

## 2. 💣 KẾT QUẢ THỬ THÁCH PHÁ HOẠI BIÊN (ADVERSARIAL FUZZING)

| Ca Thử Nghiệm Phá Hoại | Dữ Liệu Bơm Vào (Payload) | Hành Vi Mong Đợi | Kết Quả Thực Tế | Đánh Giá |
| :--- | :--- | :--- | :--- | :---: |
| **Tràn bộ nhớ chuỗi dài** | 50.000 ký tự `'A'` vào trường `name` | Backend trả về `400 Bad Request` | HTTP 400 trong 12ms | 🟢 PASS |
| **Tiêm mã độc SQL Injection** | `' OR 1=1 --` vào trường `search` | Không rò rỉ dữ liệu, query tham số hóa | Trả về mảng rỗng `[]` | 🟢 PASS |
| **Tiêm mã độc XSS** | `<img src=x onerror=alert(1)>` | Mã hóa đầu ra (Escaped), không thực thi script | Hiển thị dưới dạng text thô | 🟢 PASS |
| **Ký tự quái lạ Unicode** | Chuỗi Zalgo text & Emoji gia đình 👨‍👩‍👧‍👦 | Không crash database, lưu đúng UTF-8 | Lưu và hiển thị hoàn hảo | 🟢 PASS |
| **Bấm nút liên hoàn (Rage)** | 10 lần click trong 1 giây | Nút bị khóa sau lần 1, Idempotency chặn | Chỉ 1 record được tạo | 🟢 PASS |
| **Chaos Network (Ngắt mạng)** | Ngắt Wi-Fi giữa chừng khi thanh toán | Hiển thị Error State có nút Retry, không crash | Báo lỗi thân thiện + nút Thử lại | 🟢 PASS |

---

## 3. 📱 KIỂM TRA TƯƠNG THÍCH MÀN HÌNH DI ĐỘNG (VIEWPORT 375PX)

- **Màn hình kiểm thử**: iPhone SE (375x667px), iPhone 15 Pro (393x852px), Samsung Galaxy S20 (360x800px).
- **Hiện tượng tràn viền ngang (Horizontal Overflow)**: 🟢 **HOÀN TOÀN KHÔNG CÓ** (Width đúng 100%).
- **Kích thước điểm chạm nút bấm (Touch Target Size)**: 🟢 **ĐẠT** (Tất cả các nút đều $\ge 44 \times 44\text{px}$).
- **Vùng an toàn (Safe Area Insets)**: 🟢 **ĐẠT** (Header và Bottom Navigation cách đều tai thỏ và thanh gạt).

---

## 4. ⚡ CHỈ SỐ WEB VITALS & ĐỘ TRỄ API THỰC ĐO

- **INP (Interaction to Next Paint)**: `82ms` (Chuẩn Google: < 200ms) 🟢 RẤT TỐT
- **LCP (Largest Contentful Paint)**: `1.15s` (Chuẩn Google: < 2.5s) 🟢 RẤT TỐT
- **CLS (Cumulative Layout Shift)**: `0.01` (Chuẩn Google: < 0.1) 🟢 RẤT TỐT
- **Độ trễ API Endpoint (p95)**: `18ms` (Chuẩn Mowftee: < 50ms) 🟢 RẤT TỐT
