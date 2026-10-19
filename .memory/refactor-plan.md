# Kế hoạch cải tổ code — 19/10/2026

Trạng thái: đã khảo sát và lập kế hoạch, **chưa thực hiện refactor**.
Nhánh `minh-thanh`, mốc lập kế hoạch `c03438d`; mã ứng dụng hiện tương ứng bản
đã push `1a024ae`. Sáu báo cáo untracked có sẵn được giữ nguyên.

## Mục tiêu và ranh giới

Tuân thủ phiếu giao; giữ Fastify/TypeScript, React, PostgreSQL, Go Agent và
Linux/Docker Compose. Cải thiện cách tổ chức code để dễ đọc, tìm chức năng,
kiểm thử và giải thích khi bảo vệ. Không thêm tính năng, dependency, dịch vụ
cloud hoặc lớp kiến trúc mới trong đợt này.

- Entry point chủ yếu gọi hàm khởi tạo, chạy và dừng. Logic có tên và vị trí rõ.
- Giảm banner, comment kể lại code và dòng trống thừa. Giữ giải thích quan trọng
  về bảo mật, race condition, giới hạn tài nguyên và thứ tự cleanup.
- Giữ callback/closure khi chúng quản lý tài nguyên của một phiên hoặc effect
  React; không ép tách thành hàm nhận quá nhiều tham số để giảm số dòng.
- Không lấy số dòng làm chỉ tiêu thành công. Giữ định dạng Go chuẩn và JSX dễ
  đọc; không nén nhiều câu lệnh vào một dòng hoặc chia mỗi helper thành một file.
- Giữ hành vi API, frame WebSocket, RBAC, logout, SQL, timeout, quota, key/token,
  ngưỡng heartbeat/cảnh báo và hình thức giao diện đã được chấp nhận.

## Kết quả khảo sát source

| Khu vực | Hiện trạng | Hướng xử lý |
|---|---|---|
| `gateway/src/server.ts` — 204 dòng | Ghép Fastify, plugin/routes, process handlers và startup/shutdown | Tách app factory và runtime, giữ entry point `dist/server.js` |
| `gateway/src/services/bastion.ts` — 897 dòng | Vé SSH, registry/timer và vòng đời từng phiên trong một file | Tách theo ba trách nhiệm, giữ một nơi sở hữu trạng thái dùng chung |
| `dashboard/src/App.tsx` — 473 dòng | Session, form login, sidebar/mobile, theme và điều phối trang | Tách login, console layout và session hook |
| `ClusterOverview.tsx` — 569 dòng | Polling node/history, chọn/lọc node và nhiều khối hiển thị | Tách hooks lấy dữ liệu, summary và node details khi có ranh giới rõ |
| `dashboard/src/styles/theme.css` — 2.401 dòng | Token, phần chung, console, monitoring, login, responsive và audit | Chia nhóm CSS nhưng giữ thứ tự cascade và giao diện hiện tại |
| `agent/main.go` — 207 dòng | `main()` đã ngắn; cùng file chứa HTTP, retry loop và CLI | Chuyển các nhóm hàm sang file theo trách nhiệm trong cùng package |
| `deploy/scripts/demo.py` — 131 dòng | Main phân nhánh bootstrap, chạy kiểm tra và quản lý Compose | Giữ CLI, đưa action handlers sang module riêng |

`TerminalModal`, `AuditLog`, config và collector đã có ranh giới riêng. Chỉ tách
thêm khi cải tổ cho thấy lợi ích cụ thể; không viết lại vì file còn dài.

## Thứ tự thực hiện

### 0. Chốt baseline trước khi sửa

Kiểm tra Git và lưu bằng chứng mới cho build/unit, cụm riêng và ảnh giao diện.
Mốc đã có: 68 Gateway Vitest, 4 script tests, 16 luồng Linux Docker thật và
browser checks. Đây là bằng chứng trước refactor; phải chạy lại khi triển khai,
không lấy báo cáo cũ làm kết quả của code mới.

### 1. Làm gọn chương trình chính

- Gateway: `app.ts` chứa `buildServer`; `runtime.ts` chứa start/stop và process
  handlers. `server.ts` chỉ khởi chạy, giữ export `buildServer` cho các bài kiểm
  tra đang import `dist/server.js`. Plugin/error handler/routes vẫn cùng thứ tự.
- Làm rõ nơi start/stop các interval Bastion, không tạo lặp timer/listener;
  app factory có thể dùng cho test mà không init Telegram, seed hoặc listen.
- Agent: `http.go` chứa HTTP client/beacon, `runner.go` chứa vòng gửi/retry,
  `cli.go` chứa flags và chế độ service/diagnostic. `main.go` chỉ cấu hình runtime
  và gọi hàm chạy. Giữ cùng package để không đổi cơ chế build/install hiện có.
- Gateway và Agent là hai commit riêng. Kiểm tra build/test liên quan sau mỗi commit.

### 2. Tách bố cục và luồng dữ liệu Dashboard

- `pages/LoginPage.tsx`: form, hiển thị lỗi và trạng thái submit.
- `layouts/ConsoleLayout.tsx`: sidebar, header, theme, menu mobile.
- `hooks/useSession.ts`: session hiện tại, hết hạn và kết quả logout.
- `hooks/useClusterData.ts`, `hooks/useNodeHistory.ts`: polling, loading/error,
  thời điểm cập nhật và cleanup. Giữ nhịp polling, chống chồng request và bỏ
  phản hồi history của node cũ khi người dùng chuyển node.
- `App.tsx` điều phối session/trang/terminal. Tách summary và node details từ
  `ClusterOverview` nếu cần để view chỉ nhận dữ liệu và callback rõ ràng.
- Giữ API service và component nhỏ đang ổn. Không thêm router, state library
  hoặc thay cơ chế xác thực; vẫn đóng terminal khi session hết hạn/logout.

### 3. Chia CSS và chuẩn hóa cách trình bày

- Giữ `styles/theme.css` làm điểm nhập. Chia nhóm tokens/phần chung, console,
  monitoring, login, audit và responsive theo các khối hiện có.
- Bảo toàn thứ tự selector, theme và media query; không dồn toàn bộ override
  xuống cuối hoặc xóa rule chỉ vì có cùng selector mà chưa kiểm tra tác dụng.
- Gọn import/comment/dòng trống trong các file đã chạm. Giữ build directives
  như `//go:build` và các comment giải thích guard bảo mật quan trọng.
- Commit CSS riêng để đối chiếu ảnh và phát hiện thay đổi giao diện dễ hơn.

### 4. Tách dịch vụ SSH có kiểm soát

- `services/bastion/tickets.ts`: tạo/consume vé và TTL.
- `services/bastion/registry.ts`: registry, quota và các timer dùng chung;
  nhận callback cleanup, không import ngược module session.
- `services/bastion/session.ts`: SSH/PTY/WebSocket và cleanup/audit của từng phiên.
- Cập nhật các importer đang hoạt động; không thêm `index.ts` chỉ để re-export.
  Tách lần lượt tickets → registry → session, kiểm tra sau từng bước.
- Giữ đồng bộ giữ slot trước `await`, thu hồi phiên, host pin, monotonic watchdog,
  backpressure và START/END audit. Không viết lại cơ chế đang chạy.
- Bổ sung regression tập trung trước khi chạm phần chưa được test hiện tại khóa
  đầy đủ: sở hữu timer/start-stop, quota khi đồng thời mở phiên và cleanup khi
  đóng lặp/ngắt giữa chừng hoặc stream đang chờ drain. Dùng mock/fake timer có
  nhãn; dùng SSH thật ở lượt nghiệm thu, không xây thêm bộ benchmark/chaos.

### 5. Làm gọn script và chốt bàn giao

- `demo.py` giữ argparse, chọn env/project và gọi action; `demo_actions.py` chứa
  các thao tác bootstrap/check/Compose. Chỉ gom helper thực sự dùng chung.
- Giữ nguyên `make up/down/doctor/status/logs/e2e`, các flags, đường dẫn keys,
  quyền file, chính sách không tự tạo credentials trong lệnh kiểm tra.
- `doctor.py` đã có main gọi diagnose; không tách thêm chỉ để đồng nhất hình thức.
- Cập nhật README/bản đồ thư mục khi đường dẫn thay đổi, ghi bằng chứng và giới
  hạn vào tài liệu đang có và `.memory/`. Không tạo thêm bộ báo cáo theo vai trò.

## Kiểm chứng và điều kiện dừng

Mỗi phần hoàn thành thành một commit có thể review trên `minh-thanh`.
Không push cho đến khi chủ dự án yêu cầu; không merge main hoặc xóa/reset dữ liệu.

| Khi nào | Kiểm tra cần thực hiện |
|---|---|
| Sau Gateway/bootstrap/Bastion | TypeScript build + Vitest; import/build không khởi động worker nền; timer/listener không nhân đôi; giữ API aliases, JWT/429/XFF/redaction |
| Sau Agent | Go tests chạy mới, Linux build và Windows cross-build; token không vào log/redirect/proxy, retry/cancel/diagnostic giữ hành vi |
| Sau Dashboard/CSS | TypeScript/Vite build; browser login, Viewer/Admin, filter, lỗi/khôi phục API, terminal mở/đóng/thử lại/logout; sáng/tối và viewport 1920/768/375/320 |
| Sau script | 4 script tests hiện có; help/status/logs/doctor; up/down/up ở project/DB/volumes riêng, đối chiếu tài khoản/key và dữ liệu |
| Trước bàn giao | Build đủ Gateway/Dashboard/Agent, 16 luồng API/SSH/PTY/RBAC/audit/logout thật trên cụm riêng; kiểm tra cảnh báo dry-run và số đo Agent/container để phát hiện tăng tài nguyên rõ rệt |

Các bài Python dò chuỗi source và probe Round cũ không phải tiêu chí nghiệm thu
chính; đã có kỳ vọng vị trí/timing lỗi thời. Nếu chuyển module, chỉ cập nhật import
của test đang dùng và giữ assertion hành vi; không đổi kỳ vọng để che lỗi.

Runtime có thể ghi DB/thu hồi phiên chỉ chạy trên cụm thử riêng, Telegram dry-run.
Đối chiếu tài khoản, key và dữ liệu trước khi cập nhật demo chính; không chạy
login/logout/e2e trên tài khoản chủ dự án để chứng minh refactor.

Dừng khi entry point và trách nhiệm module rõ, các hành vi đã kiểm chứng không
bị thụt lùi, UI giữ hình thức đã duyệt và số đo không tăng bất thường. Không đặt
chỉ tiêu giảm RAM chỉ bằng di chuyển file hoặc thêm thư viện để đạt hình thức.
Windows native/VM/reboot/Zero Inbound từ máy độc lập vẫn là phần nghiệm thu riêng;
cross-build, mock và Docker không đổi thành PASS VM sau đợt cải tổ này.
