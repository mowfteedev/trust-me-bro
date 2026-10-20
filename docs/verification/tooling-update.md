# Cập nhật công cụ build/test — 20/10/2026

Phạm vi: cập nhật dependency phát triển; giữ nguyên source ứng dụng, tests,
runtime dependencies, database và cụm demo. Không chạy Telegram hoặc kiểm thử
logout trên môi trường đang dùng. Áp dụng guild security/code-reviewer ở mức đồ án.

## Thay đổi và lý do

- Gateway: Vitest1.6.1 → **4.1.12**. Vitest3 vẫn kéo tinypool1 có cảnh báo; Vitest4
  bỏ tinypool/vite-node nên không cần override transitive sang major khác.
  Lockfile chọn Vite8.3.4 cho test runner. Không cài công cụ này trong runner.
- Dashboard: Vite5.4.21 → **6.4.4**; nâng sàn manifest plugin-react lên **4.7.0**
  có peer hỗ trợ Vite6 (lockfile trước đã chọn4.7.0, không đổi binary plugin).
  Giữ cấu hình, Tailwind3, giao diện và cách Nginx phục vụ file tĩnh.
- So sánh toàn bộ entry không có `dev:true` trong hai lockfile trước/sau:
  **giống hệt nhau**, không đổi phiên bản hoặc metadata dependency runtime.

Nguồn chính thức: [Vitest4 migration và pool rewrite](https://v4.vitest.dev/guide/migration.html),
[Vitest UI advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp),
[Tinypool advisory](https://github.com/tinylibs/tinypool/security/advisories/GHSA-5gmw-xhrv-c9v3),
[Vite Windows path advisory: có bản vá6.4.3](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff),
[Vite6 migration](https://v6.vite.dev/guide/migration).
Phiên bản/peer/engines được đối chiếu thêm bằng `npm view` từ npm registry.

## Kết quả chạy

Môi trường container `node:22-alpine`: Node22.23.3, npm10.9.9. Dùng bản sao source
cô lập, không mount keys hoặc mạng Compose demo. Các lệnh chạy từ thư mục thành phần:

```sh
npm ci --no-audit --no-fund
npm run build
npm test -- --maxWorkers=2 # Chỉ Gateway
npm audit --package-lock-only --ignore-scripts --json
npm audit --package-lock-only --omit=dev --ignore-scripts --json # Gateway runtime
```

| Kiểm tra | Kết quả thực tế |
|---|---|
| Gateway TypeScript build | Đạt |
| Gateway Vitest | **87/87**, 6 file; không sửa assertion, source test hoặc config |
| Dashboard TypeScript + Vite build | Đạt, 1535 module; CSS52.24kB |
| Gateway Dockerfile hoàn chỉnh | Build đạt; image `268a85081b57` |
| Dashboard Dockerfile hoàn chỉnh | Build đạt; image `d1f5285146f8` |
| Runner cô lập `--network none` | Gateway không resolve được Vitest/Vite/TS/tsx; Nginx `-t` đạt |
| Toàn cây Gateway audit | **5 → 0** package bị cảnh báo; sau: exit0 |
| Gateway `--omit=dev` audit | **0**, exit0 |
| Toàn cây Dashboard audit | **9 → 7**; sau: 2moderate, 5high, 0critical; **exit1** |

Docker build đã chạy với đúng Dockerfile hiện có, tag riêng
`zt-tooling-gateway-check` và `zt-tooling-dashboard-check`; không thay container
demo. Gateway runner dùng bước prune dev dependencies hiện có.

Các unit kiểm tra logic với DB/SSH/fetch được mock; Fastify/JWT và plugin WebSocket
thật được kiểm tra qua injection/stream. **Không tính 87 unit thành 87 luồng hệ
thống thật**, không chứng minh lại VM/Internet chỉ bằng build hoặc unit test.
Audit đếm package ảnh hưởng, không phải số CVE độc lập hoặc exploit đã tái hiện.

## Nợ còn lại có chủ đích

Dashboard còn braces, chokidar, fast-glob, micromatch, postcss-nested,
postcss-selector-parser và tailwindcss. Đây là chuỗi công cụ CSS/glob của Tailwind3;
không đóng gói thành Node server trong image Nginx.
`npm view braces dist-tags` tại lần kiểm tra vẫn trả latest3.0.3, chính là bản bị
cảnh báo. Npm đề xuất Tailwind4; chưa chuyển vì cần đổi pipeline/CSS và kiểm tra
lại giao diện. Không ép override parser/glob qua major chỉ để audit về0.

Tình trạng này vẫn **OPEN**. Input CSS/glob trong build là source dự án tin cậy;
chưa tái hiện exploit trên ứng dụng, cũng không kết luận package an toàn.
Advisory parser: [PostCSS selector parsing](https://github.com/postcss/postcss-selector-parser/security/advisories/GHSA-rj75-hqrm-r3gf).
Không dùng `npm audit fix --force`, không tự mở thêm vòng nâng cấp frontend.
