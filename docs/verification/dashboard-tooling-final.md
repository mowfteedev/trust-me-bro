# Hoàn tất công cụ CSS Dashboard — 20/10/2026

Phạm vi được chủ dự án duyệt: xử lý 7 cảnh báo dependency Dashboard còn lại.
Dùng guild frontend/security/code-reviewer với mức kiểm chứng đồ án. Không đổi
React/TypeScript, API, dữ liệu, source TSX hoặc container demo đang chạy.

## Bản sửa nhỏ

Tailwind CSS 3.4.19 → 4.3.3; đổi PostCSS plugin sang `@tailwindcss/postcss`4.3.3,
bỏ `autoprefixer` vì compiler mới xử lý prefix/import. Giữ cấu hình theme hiện có,
khai báo `@import`/`@config` trong CSS thay ba directive cũ. Giữ màu terminal,
blur4px, border và placeholder mặc định cũ bằng một ít token/reset để giao diện
hiện tại không đổi theo bộ mặc định mới.

TerminalModal thực sự dùng nhiều utility Tailwind; bỏ compiler sẽ phải viết lại
CSS của terminal. Chọn nâng compiler với token tương thích. Không override
transitive qua major, không dùng `npm audit fix --force`, không đổi assertion.
Tất cả 9 entry runtime trong lockfile trước/sau giống hệt nhau; `tailwind-merge`
hiện không được import trong source, không dùng nó để xử lý utility v4.

Theo [hướng dẫn nâng cấp chính thức](https://tailwindcss.com/docs/upgrade-guide),
compiler v4 cần Safari16.4+, Chrome111+ hoặc Firefox128+. Môi trường demo dùng
Firefox158.0; không xác nhận hỗ trợ trình duyệt cũ hơn yêu cầu compiler.

## Build và dependency audit thực tế

Thực hiện trên hai bản sao cô lập, container `node:22-alpine` (Node22.23.3,
npm10.9.9), không mount keys hoặc mạng demo. Các lệnh trong thư mục Dashboard:

```sh
npm ci --no-audit --no-fund
npm run build
npm audit --ignore-scripts --json
npm audit --omit=dev --ignore-scripts --json
```

Từ repository root cũng chạy đúng Dockerfile hiện có:

```sh
docker build -f dashboard/Dockerfile -t zt-dashboard-tailwind4-check dashboard
docker run --rm --network none zt-dashboard-tailwind4-check nginx -t
```

| Kiểm tra | Trước | Sau |
|---|---|---|
| TypeScript + Vite build | Đạt,1535module | Đạt,1535module |
| Toàn cây dependency audit | 7:2moderate/5high,exit1 | **0**,exit0 |
| Audit `--omit=dev` | Không phát sinh sửa runtime | **0**,exit0 |
| Số dependency entry trong lockfile | 192 | 164 |
| CSS build | 52.24kB /11.80kB gzip | 57.40kB /12.74kB gzip |
| Dockerfile hoàn chỉnh | Mốc trước đã có | Đạt,image `e3e8ebfd3a85` |
| Nginx config trong runner cô lập | — | `nginx -t` đạt |

Kết quả audit là theo advisory npm tại lần chạy20/10/2026, không phải chứng nhận
không có lỗ hổng. Bản sửa đóng 7 cảnh báo công cụ cũ bằng cách bỏ cây Tailwind3;
không suy từ audit/build thành bằng chứng bảo mật VM hoặc Internet.

## So sánh giao diện bằng trình duyệt thật

Hai bản `dist` phục vụ trên loopback, cùng Firefox158.0/Selenium4.51.0.
API và WebSocket dùng **fixture UI có nhãn rõ**, tài khoản `ui-fixture-admin` và
thông điệp terminal `UI fixture only - no SSH connection`. Không đăng nhập,
logout hoặc mở SSH vào hệ thống demo thật trong phép so sánh này.

Ma trận24layout: login/dashboard/audit/terminal/terminalfullscreen/terminalerror ×
light/dark × viewport1920×1080/375×812. Có thao tác đổi theme, mở/đóng terminal,
phóng to/thu nhỏ, mở menu mobile và điều hướng audit. Đóng băng đồng hồ fixture,
tắt animation/caret chỉ trong harness; chuẩn hóa trạng thái chuột và chờ ảnh
ổn định để tách sai khác trình bày khỏi thời điểm render.

| Nhóm màn hình | Số layout | Kết quả so ảnh trước/sau |
|---|---:|---|
| Đăng nhập | 4 | Không khác pixel |
| Dashboard có biểu đồ | 4 | Không khác pixel |
| Audit có dữ liệu | 4 | Không khác pixel |
| Terminal kết nối fixture | 4 | Không khác pixel |
| Terminal toàn màn hình | 4 | Không khác pixel |
| Terminal lỗi fixture | 4 | Không khác pixel |

Tổng **24/24** ảnh giống pixel; so sánh tổng 28,537,200pixel. Không khác số lượng
hoặc tọa độ/kích thước phần tử được đo; không tràn ngang ở cả24layout. Ngoài
so sánh tự động, đã mở xem ảnh terminal mobile và dashboard desktop.

Computed CSS terminal có8phần tử khác cách biểu diễn nhưng cùng hình học/ảnh:
`space-x` đổi margin đầu/cuối, `rounded-full` dùng bán kính lớn hơn, chuỗi shadow
thêm các lớp trong suốt, màu đen alpha được serialize bằng `oklab`. Không yêu cầu
chuỗi CSS nội bộ phải giống khi hiệu ứng render tương đương.

Lần so đầu phát hiện palette/blur của v4 khác bản trước; token tương thích đã
sửa đúng khác biệt này. Phép đo đầu trình duyệt còn khác hover/atlasfont ở lượt
đầu; harness cuối làm nóng cùng font, di chuyển chuột thực và chờ3ảnh liên tiếp
ổn định trước khi chụp. Không bỏ vùng ảnh, không nới ngưỡng so sánh: kết quả cuối
đếm mọi pixel RGB,0pixel khác ở mỗi layout.

Đây là kiểm tra giao diện trên trình duyệt thật với dữ liệu giả lập. Không thay
thế bằng chứng auth/RBAC/SSH/telemetry thật đã có; không tính thành24luồng end-to-end.
Chưa chạy Safari/Chrome hoặc trình duyệt mobile trên thiết bị thật.

Raw: `/home/mowftee/.cache/zt-dashboard-final-5u0zhx2y` chứa hai bản source/dist, auditJSON, build/Docker logs, harness,
48ảnh và DOM/computed-style snapshots, `visual-comparison.json`. Đường dẫn cache
cũng lưu trong `keys/dashboard-tooling-final-path` bị Git ignore; không có token
hoặc thông tin đăng nhập thật trong fixture. Server18760/18761 chỉ bind loopback
và đã kết thúc cùng harness.

SHA-256 kết quả so sánh cuối: `efc331855d95a3eab63fbccd98c03c57f3287d061919b4b558b5e77ebf60bf1a`.
