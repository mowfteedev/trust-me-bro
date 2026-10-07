# 🐛 SỔ THEO DÕI LỖI PHÁT SINH & RỦI RO KỸ THUẬT (DEFECT TRACKER)
> **Dự án:** `trust-me-bro` (`do-an-co-so-nganh`)  
> **Vị trí lưu trữ:** Trực tiếp trong kho mã nguồn dự án  
> **Kỷ luật kiểm soát:** Mọi lỗi phát sinh trong quá trình thực thi 24 công đoạn đều phải được ghi nhận, phân loại và đóng vết theo quy trình chuẩn.

---

## 🚦 I. THANG ĐO MỨC ĐỘ NGHIÊM TRỌNG (SEVERITY MATRIX)

| Mức độ | Ký hiệu | Định nghĩa & Mức độ tác động | Hành động bắt buộc |
| :---: | :---: | :--- | :--- |
| **P0** | 🔴 **Blocker** | Hệ thống không thể khởi động, rò rỉ khóa bí mật, crash tiến trình cốt lõi, vỡ luồng PTY. | **Dừng toàn bộ dây chuyền.** Toàn bộ chuyên gia tập trung sửa dứt điểm trước khi làm tiếp. |
| **P1** | 🟠 **Critical** | Lỗ hổng an ninh nghiêm trọng (Timing Attack, leo thang đặc quyền), phình đĩa Dead Tuples, nghẽn I/O. | Phải sửa xong và viết kịch bản kiểm thử chặn hồi quy (Regression Test) mới được chuyển công đoạn. |
| **P2** | 🟡 **Major** | Lỗi logic nghiệp vụ, hiển thị sai lệch trên Dashboard, xử lý ngoại lệ mạng chưa tối ưu. | Sửa trong cùng chặng phát triển, không để tồn đọng sang chặng sau. |
| **P3** | 🟢 **Minor** | Cảnh báo linter, thiếu chú thích hướng dẫn tùy biến, lỗi chính tả trong thông điệp log. | Dọn dẹp trong công đoạn thẩm định mã nguồn (`code-reviewer`). |

---

## 📋 II. BẢNG TỔNG HỢP TRẠNG THÁI LỖI (BUG TRACKING TABLE)

| Mã Bug | Công đoạn | Mô tả tóm tắt sự cố | Mức độ | Phát hiện bởi | Trạng thái | Mã kiểm chứng |
| :---: | :---: | :--- | :---: | :---: | :---: | :---: |
| **BUG-001** | CĐ-14 | Truy vấn Telemetry quét toàn bảng $O(N)$ gây nghẽn CPU | 🟠 P1 | `database` | 🛡️ Đã có giải pháp | `TEST-TELEMETRY-O1` |
| **BUG-002** | CĐ-14 | Fallback chuỗi trần `===` làm vô hiệu hóa chống Timing-Attack | 🟠 P1 | `security` | 🛡️ Đã có giải pháp | `TEST-TIMING-SAFE` |
| **BUG-003** | CĐ-05 | Lệnh `DELETE` định kỳ gây phình bộ nhớ Dead Tuples (MVCC) | 🟠 P1 | `database` | 🛡️ Đã có giải pháp | `TEST-PARTITION-DROP` |
| **BUG-004** | CĐ-15 | Frame PTY `RESIZE` không kẹp biên gây crash tiến trình shell | 🔴 P0 | `code-reviewer`| 🛡️ Đã có giải pháp | `TEST-PTY-CLAMP` |
| **BUG-005** | CĐ-16 | Tự động gán `chatId` người lạ nhận cảnh báo sự cố On-Call | 🔴 P0 | `security` | 🛡️ Đã có giải pháp | `TEST-TELEGRAM-OTP` |
| **BUG-006** | CĐ-07 | Container Node giao tiếp ngang hàng trực tiếp qua Docker Bridge | 🟠 P1 | `devops` | 🛡️ Đã có giải pháp | `TEST-ICC-DISABLED` |
| **BUG-007** | CĐ-07 | Cổng HTTP 3000 mở ra Host vi phạm Zero Trust và thiếu mã hóa TLS | 🔴 P0 | `user` | 🟡 Chờ biểu quyết | `TEST-NO-CLEAR-HTTP` |
| **BUG-008** | CĐ-07 | Mật khẩu PostgreSQL bị ghi cứng và ghi đè DATABASE_URL trong compose | 🔴 P0 | `code-reviewer`| 🟡 Chờ biểu quyết | `TEST-NO-HARDCODED-PW` |
| **BUG-009** | CĐ-11 | Kịch bản install.sh chạy Worker Daemon dưới quyền root (UID 0) | 🔴 P0 | `security` | 🟡 Chờ biểu quyết | `TEST-AGENT-NONROOT` |
| **BUG-010** | CĐ-07 | WireGuard bật MASQUERADE và FORWARD cho phép tấn công Lan ngang | 🔴 P0 | `devops` | 🟡 Chờ biểu quyết | `TEST-WG-NO-MASQ` |
| **BUG-011** | CĐ-10 | Khóa bí mật NODE_TOKEN fallback chuỗi tĩnh "default-pre-shared-token" | 🟠 P1 | `code-reviewer`| 🟡 Chờ biểu quyết | `TEST-TOKEN-NO-FALLBACK` |
| **BUG-012** | CĐ-09 | Bộ trích xuất disk.py nuốt lỗi âm thầm và bịa số liệu 100GB / 10% | 🟡 P2 | `tester` | 🟡 Chờ biểu quyết | `TEST-DISK-HONEST-ERR` |

---

## 🛡️ III. CHI TIẾT CÁC LỖ HỔNG CỐT LÕI CẦN CHẶN HỒI QUY (REGRESSION GUARDS)

Dưới đây là 6 bẫy mã nguồn đã được bóc tách từ các đợt thẩm định trước. Khi triển khai 24 công đoạn, **tuyệt đối không để tái diễn trong mã nguồn mới**:

### 1. BUG-001: Lỗi quét toàn bảng $O(N)$ trong luồng tiếp nhận Telemetry
* **Cơ chế lỗi:** Mỗi 3 giây khi Worker Node gửi beacon, Gateway lại thực thi lệnh `SELECT id, token_hash FROM nodes` tải toàn bộ bảng lên RAM rồi dùng vòng lặp JavaScript để tìm kiếm. Khi số lượng node tăng lên, Gateway sẽ cạn kiệt tài nguyên CPU.
* **Quy chuẩn giải pháp bắt buộc tại CĐ-14:**  
  Tạo chỉ mục `Hash Index` trên cột `token_hash` trong CSDL PostgreSQL. Viết câu truy vấn điểm chính xác:  
  `SELECT id, name, ip_address FROM nodes WHERE token_hash = $1 LIMIT 1;` (Đạt độ phức tạp $O(1)$).

---

### 2. BUG-002: Lỗ hổng kênh kề Timing-Attack khi xác thực Token
* **Cơ chế lỗi:** Code cũ sử dụng `crypto.timingSafeEqual`, nhưng lại có khối fallback so sánh chuỗi trần `dbHash === inputHash` khi độ dài chuỗi không khớp, tạo điều kiện cho hacker đo thời gian phản hồi để dò từng ký tự token.
* **Quy chuẩn giải pháp bắt buộc tại CĐ-14:**  
  Chuẩn hóa độ dài chuỗi băm (SHA-256 luôn cho ra Buffer 32 bytes). So sánh duy nhất qua `crypto.timingSafeEqual(bufA, bufB)`, triệt tiêu 100% mọi đoạn so sánh bằng toán tử `===`.

---

### 3. BUG-003: Hiện tượng phình bộ nhớ Dead Tuples trên PostgreSQL
* **Cơ chế lỗi:** Dịch vụ quét dọn thực thi `DELETE FROM metrics_history WHERE recorded_at < NOW() - INTERVAL '5 minutes'` mỗi 5 giây. Cơ chế MVCC của PostgreSQL giữ lại các bản ghi cũ dưới dạng Dead Tuples, làm phình dung lượng đĩa cứng và suy giảm nghiêm trọng tốc độ đọc ghi.
* **Quy chuẩn giải pháp bắt buộc tại CĐ-05:**  
  Chuyển sang cấu trúc **Range Partitioning theo chu kỳ ngày**. Xóa bỏ toàn bộ lệnh `DELETE` định kỳ. Thay thế bằng cơ chế `DROP TABLE` các phân vùng ngày hết hạn (thực thi dưới 5ms, giải phóng dung lượng đĩa tức thì).

---

### 4. BUG-004: Crash tiến trình PTY Terminal do thiếu kẹp biên tham số `RESIZE`
* **Cơ chế lỗi:** Khi nhận gói tin WebSocket `RESIZE`, Gateway đẩy trực tiếp `resizeFrame.rows` và `resizeFrame.cols` vào `sshStream.setWindow()` mà không kiểm tra giá trị. Nếu client gửi số âm (`rows: -50`) hoặc số cực đại (`cols: 9999999`), tín hiệu `SIGWINCH` sẽ làm vỡ luồng PTY phía máy chủ.
* **Quy chuẩn giải pháp bắt buộc tại CĐ-15:**  
  Bắt buộc ép kiểu số nguyên và kẹp biên an toàn trong ngưỡng thực tế:
  ```typescript
  const rows = Math.min(200, Math.max(10, Math.floor(Number(frame.rows)) || 24));
  const cols = Math.min(500, Math.max(20, Math.floor(Number(frame.cols)) || 80));
  sshStream.setWindow(rows, cols, 0, 0);
  ```

---

### 5. BUG-005: Rủi ro chiếm quyền nhận thông báo Telegram On-Call
* **Cơ chế lỗi:** Bot tự động bắt lấy `chat.id` của tin nhắn đầu tiên gửi đến bot qua `getUpdates` để làm kênh nhận cảnh báo sự cố. Bất kỳ ai trên Internet tìm thấy bot và gửi `/start` trước đều có thể đánh cắp toàn bộ thông báo hệ thống.
* **Quy chuẩn giải pháp bắt buộc tại CĐ-16:**  
  Máy chủ sinh một mã ngẫu nhiên (One-Time Pairing Code) in ra màn hình console lúc khởi động. Bot chỉ chấp nhận kích hoạt gửi tin khi nhận được đúng cú pháp: `/pair <MÃ_OTP>`.

---

### 6. BUG-006: Rủi ro tấn công ngang hàng giữa các container qua Docker Bridge
* **Cơ chế lỗi:** Docker Network mặc định bật cờ `icc=true` (Inter-Container Connectivity), cho phép các container trong cùng subnet quét cổng và tấn công trực tiếp lẫn nhau mà không đi qua Gateway.
* **Quy chuẩn giải pháp bắt buộc tại CĐ-07:**  
  Khai báo cầu mạng trong `docker-compose.yml` với tùy chọn cô lập tuyệt đối:
  ```yaml
  networks:
    zt_underlay:
      driver: bridge
      driver_opts:
        com.docker.network.bridge.enable_icc: "false"
  ```

---

### 7. BUG-007: Cổng HTTP 3000 mở ra Host vi phạm Zero Trust và thiếu mã hóa TLS
* **Cơ chế lỗi:** `docker-compose.yml` mở cổng `3000:3000` trên toàn bộ interface `0.0.0.0` qua Caddy, cho phép gửi token xác thực qua HTTP dạng bản rõ (Cleartext Sniffing).
* **Quy chuẩn giải pháp đề xuất:** Đóng hoàn toàn cổng 3000 trên Host, chỉ mở 80 (ACME + redirect) và 443 (TLS 1.3). Xem chi tiết tại [GitHub Issue #2](https://github.com/mowfteedev/trust-me-bro/issues/2).

---

### 8. BUG-008: Mật khẩu PostgreSQL bị ghi cứng và ghi đè DATABASE_URL trong compose
* **Cơ chế lỗi:** `POSTGRES_PASSWORD: SecurePassword123!` và `DATABASE_URL` bị gán cứng tĩnh trong `docker-compose.yml`, commit lên git (CWE-798) và ghi đè giá trị an toàn trong `.env`.
* **Quy chuẩn giải pháp đề xuất:** Loại bỏ mật khẩu tĩnh, sinh ngẫu nhiên chuỗi bảo mật qua `init-secrets.sh` và truyền qua biến môi trường.

---

### 9. BUG-009: Kịch bản install.sh chạy Worker Daemon dưới quyền root (UID 0)
* **Cơ chế lỗi:** Service Systemd trong `agent/install.sh` không cấu hình `User=`, khiến daemon chạy bằng root dù chỉ cần đọc `/proc` (quyền 444), tạo rủi ro chiếm quyền điều khiển host (CWE-250).
* **Quy chuẩn giải pháp đề xuất:** Tạo user hệ thống không đặc quyền `zt-agent` và khai báo `User=zt-agent` trong file unit.

---

### 10. BUG-010: WireGuard bật MASQUERADE và FORWARD cho phép tấn công Lan ngang
* **Cơ chế lỗi:** `PostUp` trong `wg0-gateway.conf` sử dụng `iptables -A FORWARD -i %i -j ACCEPT` và `MASQUERADE`, cho phép lưu lượng giữa các worker node đi qua nhau và biến Gateway thành NAT proxy.
* **Quy chuẩn giải pháp đề xuất:** Xóa bỏ `MASQUERADE`, chặn forward giữa các peer WireGuard, tuân thủ nghiêm ngặt mô hình Hub-and-Spoke.

---

### 11. BUG-011: Khóa bí mật NODE_TOKEN fallback chuỗi tĩnh "default-pre-shared-token"
* **Cơ chế lỗi:** `config.py` và `install.sh` dùng giá trị mặc định tĩnh, khiến hàm kiểm tra rỗng bị vô hiệu hóa khi người dùng quên truyền token (CWE-1188).
* **Quy chuẩn giải pháp đề xuất:** Xóa bỏ fallback, kích hoạt Fail-Fast nếu biến `NODE_TOKEN` bị thiếu.

---

### 12. BUG-012: Bộ trích xuất disk.py nuốt lỗi âm thầm và bịa số liệu 100GB / 10%
* **Cơ chế lỗi:** Khối `except Exception:` trong `collectors/disk.py` tự động trả về `100GB / 10%` khi syscall `statvfs` thất bại, che giấu sự cố hỏng đĩa thực tế khỏi Gateway.
* **Quy chuẩn giải pháp đề xuất:** Ghi nhận lỗi trung thực và gắn cờ cảnh báo lỗi phần cứng để Gateway kích hoạt cảnh báo CRITICAL.

---

## 📝 IV. MẪU PHIẾU GHI NHẬN SỰ CỐ MỚI (NEW INCIDENT TEMPLATE)

Khi phát hiện bất kỳ lỗi phát sinh mới nào trong quá trình thực hiện 24 công đoạn, điền trực tiếp vào mẫu dưới đây:

```markdown
### [MÃ BUG]: <Tên ngắn gọn của sự cố>
* **Công đoạn phát hiện:** CĐ-xx
* **Mức độ nghiêm trọng:** 🔴 P0 / 🟠 P1 / 🟡 P2 / 🟢 P3
* **Người phát hiện:** <Tên chuyên gia hoặc Subagent>
* **Hiện tượng thực tế:** <Mô tả lỗi, kèm mã lỗi hoặc log terminal>
* **Hành vi kỳ vọng:** <Hệ thống đáng lẽ phải hoạt động thế nào>
* **Nguyên nhân gốc rễ (Root Cause):** <Phân tích chi tiết tại sao lỗi xảy ra>
* **Giải pháp khắc phục:** <Mã nguồn đề xuất hoặc cấu hình thay đổi>
* **Kịch bản kiểm chứng (Verification Test Case):** <Lệnh hoặc kịch bản test để xác nhận lỗi đã hết>
* **Trạng thái:** [ ] Open | [ ] In Progress | [ ] Resolved | [ ] Verified
```
