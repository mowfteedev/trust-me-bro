# Dependency review — cập nhật 19/10/2026

Đã nâng Gateway lên Fastify5.12.7, @fastify/jwt10.2.5 (fast-jwt6.3.5),
CORS11.3.1, rate-limit11.2.1 và websocket11.3.4. Giữ Node22, API, schemaDB,
HS256 và cơ chế session_version/ticket hiện có; không thêm dependency/dịch vụ.

Audit lại từ package-lock bằng npm audit --json và --omit=dev:

| Phạm vi | Kết quả19/10 | Giới hạn |
|---|---|---|
| Gateway runtime | **0 package bị audit cảnh báo** | Không phải chứng nhận không có lỗ hổng ứng dụng |
| Toàn cây Gateway | **5 package:2moderate,1high,2critical** | esbuild/tinypool/vite/vite-node/vitest thuộc chuỗi công cụ Vitest1; không đóng gói trong image runtime |
| Dashboard | Không thay dependency trong lượt này | Kết quả18/10 ở phần lịch sử; không tuyên bố đã vá toolingVite |

Builder giữ dev dependencies để test; runner chỉ có npm prune --omit=dev.
Không bật VitestUI/API server. Vẫn cần cập nhật bộ test trong một đợt riêng nếu
có nhu cầu sử dụng các chế độ đó; không gọi toàn bộ dependency đã sạch.

Build TypeScript +68Vitest đạt (DB/fetch/SSH củaunit đượcmock; pluginWebSocket thật
đượcinject bằngstreamtest). Cụm Docker riêng chạy đủ16luồng API/SSH/PTY quaWireGuard,
Viewer403, logout đóngSSH/thu hồiJWT vàSQLmigration/registration thật.

Sửa tương thích v5 có phạm vi nhỏ: nhận WebSocket trực tiếp; errorhandler đặt trước
route để plugin con kế thừa, xử lý unknown và giữredaction500; rate-limit tạoError
cóstatusCode để tiếp tục trả429. Thêm10regressioncases vềJWT/parser/redaction/WSaliases.

Primary references: [Fastify migration](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/),
[LTS](https://fastify.dev/docs/latest/Reference/LTS/),
[JWT compatibility](https://github.com/fastify/fastify-jwt),
[WebSocket API](https://github.com/fastify/fastify-websocket).

Phần dưới giữ nguyên nhận xét lịch sử của bản18/10. Các nhận xét “runtime4package
cònOPEN” mô tả phiên bản trước, đã được thay bởi kết quả0runtime ở trên.

---

# Đối chiếu bản trước — 18/10/2026

Audit được chạy lại từ package-lock thực bằng `npm audit --package-lock-only
--json`, và thêm `--omit=dev` cho Gateway. Không dùng số cảnh báo cũ làm bằng chứng.

| Phạm vi | Kết quả npm audit | Ý nghĩa |
|---|---|---|
| Gateway runtime | 4 package: 1 moderate, 2 high, 1 critical | Fastify/JWT/router và quan hệ phụ thuộc; chưa được vá bằng lần thay đổi này |
| Toàn cây Gateway | 9 package: 3 moderate, 3 high, 3 critical | Có cả công cụ kiểm thử/build |
| Toàn cây Dashboard | 9 package: 3 moderate, 6 high | Các mục bị báo nằm trong dev dependencies; runtime là Nginx phục vụ file tĩnh |

Đây là số **package bị ảnh hưởng**, không phải số exploit đã tái hiện hoặc số CVE
độc lập. Không có báo cáo pentest/chứng nhận an ninh sạch.

## Đối chiếu cấu hình ứng dụng

- JWT: HS256 cố định, secret tĩnh tối thiểu32 ký tự và bootstrap sinh ngẫu nhiên;
  không dùng RSA/JWKS/resolver key theo kid, custom cache/regex/clockTolerance.
  Đã kiểm tra verifier thư viện thật có cache mặc định `null`. Các điều kiện
  [RSA confusion](https://github.com/nearform/fast-jwt/security/advisories/GHSA-mvf2-f6gm-w987),
  [empty resolver key](https://github.com/nearform/fast-jwt/security/advisories/GHSA-gmvf-9v4p-v8jc),
  [cache collision](https://github.com/nearform/fast-jwt/security/advisories/GHSA-rp9m-7r4c-75qg)
  chưa thấy trong cấu hình đã đọc. Thư viện vẫn có lỗi
  [critical extension](https://github.com/nearform/fast-jwt/security/advisories/GHSA-hm7r-c7qw-ghp6);
  không tuyên bố đã sửa giao thức JWT. Token payload array không đạt kiểm tra
  session_version/định danh của middleware hiện tại.
- Fastify chạy HTTP/1, không trả WebStream/trailer, không có private custom404
  hoặc JSON route schema của Fastify; handler kiểm tra dữ liệu bằng Zod.
  Chưa tìm được đường kích hoạt các advisory
  [protected404](https://github.com/fastify/fastify/security/advisories/GHSA-p68q-wchp-6fh7),
  [schema bypass](https://github.com/fastify/fastify/security/advisories/GHSA-jx2c-rxcm-jvmq),
  [HTTP2 router](https://github.com/delvedor/find-my-way/security/advisories/GHSA-c96f-x56v-gq3h).
  Getter [forwarded host/protocol](https://github.com/fastify/fastify/security/advisories/GHSA-444r-cwp2-x5xf)
  vẫn thuộc phạm vi cảnh báo; ứng dụng không dùng các getter này cho redirect
  hoặc quyết định quyền. Không suy từ trustProxy hẹp thành đã vá toàn bộ advisory.
- Gateway runtime prune dev dependencies; Vitest chạy `run`, không bật UI/API
  server. Dashboard Docker không chạy Vite. Không coi cảnh báo
  [Vitest UI](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp)
  hoặc [Windows dev middleware](https://github.com/vitejs/launch-editor/security/advisories/GHSA-v6wh-96g9-6wx3)
  là RCE đã chứng minh trên Dashboard Nginx. Khi chạy dev trên Windows, vẫn phải
  xét các cảnh báo đó. Loopback không tự vá mọi lỗi dev server.

## Thay đổi nhỏ đã thực hiện

- Gateway builder/runtime chuyển Node20 sang Node22 LTS, cùng dòng Node với
  Dashboard builder. [Node20 đã EOL](https://nodejs.org/en/about/previous-releases).
  Build/unit/runtime được kiểm tra lại sau thay đổi.
- Vite dev/preview mặc định bind127.0.0.1; không mở dev server ra LAN theo mặc định.

Fastify4 đã [hết LTS](https://fastify.dev/docs/latest/Reference/LTS/). Không ép nâng
major Fastify/plugin/Vite/Tailwind giữa vòng tích hợp Windows chỉ để làm số audit
về0. Cảnh báo runtime vẫn **OPEN**, cần vòng nâng cấp có kiểm chứng riêng nếu đổi
phạm vi triển khai hoặc sử dụng các tính năng có điều kiện kích hoạt nêu trên.
Kết luận hiện tại chỉ là chưa chứng minh đường khai thác trong cấu hình đồ án;
không phải xác nhận các phiên bản thư viện an toàn.
