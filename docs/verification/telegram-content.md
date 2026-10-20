# Nội dung thông báo Telegram — 20/10/2026

Yêu cầu: thông báo tiếng Việt rõ loại sự cố, máy chủ, số liệu/ngưỡng,
thời gian Việt Nam và bước kiểm tra phù hợp. Chỉ sửa phần trình bày ở
`gateway/src/services/telegram-message.ts`, được gọi trong `sendAlert`.
Giữ API ba đối số, dữ liệu cảnh báo và mã `CPU_HIGH`/`NODE_OFFLINE` trong DB,
audit, chống trùng, retry, ghép nối OTP và các chế độ disabled/dry-run/live.

## Ví dụ minh họa từ formatter, không phải tin nhắn gửi thật

```text
ZT-ServerOps | CPU cao
Mức độ: Cảnh báo
Máy chủ: node-windows-01
CPU ghi nhận: 93.75%
Ngưỡng cảnh báo: ≥ 85%
Đề nghị: Kiểm tra tiến trình sử dụng CPU qua Web SSH.
Thời điểm thông báo: 01:05:06 21/10/2026 (UTC+7)
```

```text
ZT-ServerOps | Mất kết nối máy chủ
Mức độ: Nghiêm trọng
Máy chủ: node-linux-01
IP WireGuard: 10.100.0.4
Không nhận heartbeat quá: 30 giây
Đề nghị: Kiểm tra trạng thái máy chủ, Agent và kết nối WireGuard.
Thời điểm thông báo: 01:05:06 21/10/2026 (UTC+7)
```

Thời gian là lúc tạo nội dung thông báo, không phải thời điểm heartbeat cuối
hay lúc CPU bắt đầu cao. Mất heartbeat chưa đủ kết luận máy đã tắt nguồn.
Tin nhắn dạng khác và nhãn `[GIẢ LẬP]` được giữ nguyên trong thông báo chung;
không nhận dạng chỉ bằng tiền tố rồi biến nội dung thử nghiệm thành sự cố thật.
Payload tiếp tục là plain text, không dùng HTML/Markdown `parse_mode`.

## Kiểm chứng đã chạy

Bản sao Gateway cô lập trong container `node:22-alpine`, không mount keys
và không nối mạng Compose demo. Lệnh trong container:

```sh
npm ci --no-audit --no-fund
npm run build
npm test -- --maxWorkers=2
```

- Build TypeScript: đạt.
- Vitest: **98/98**, 7 file; gồm 87 ca trước và 11 ca mới.
- Mười ca formatter kiểm tra giá trị/ngưỡng CPU, IP/timeout heartbeat,
  UTC+7 qua ngày mới, thông báo tùy chỉnh, nhãn giả lập và payload không khớp.
- Một ca transport gọi `sendAlert` thật với `fetch` được mock, xác nhận body
  chứa nội dung tiếng Việt và không có `parse_mode`. Retry/timeout/dry-run/
  disabled và lifecycle DB tiếp tục qua các ca có sẵn.
- Các test không kết nối Telegram hoặc DB thật. Các ví dụ trên là minh họa;
  chưa tính chúng là bằng chứng bot đã nhận tin nhắn định dạng mới.

Log kiểm tra cục bộ: `~/.cache/zt-telegram-content-1xghh26y/verification-final.log`.
