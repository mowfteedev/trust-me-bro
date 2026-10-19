# Kiểm chứng Makefile và Gateway — 19/10/2026

Phạm vi được duyệt: rà soát Makefile/script và áp dụng cải tiến nhỏ sau review
bản ZIP. Chỉ làm trên `minh-thanh`, không merge main, không push các commit mới.
Không thêm dịch vụ, cache hoặc kiến trúc khác.

## Đối chiếu Fastify với phiếu giao

Đã mở lại `/home/mowftee/Downloads/Nhom_9_Phieu giao hoc phan ĐA CSN.doc`.
Phiếu ghi “Backend Node.js (Fastify/TypeScript)”, không khóa phiên bản Fastify.
SHA-256 tài liệu:
`ae5baf56b25ecc521fbb2d8120ccc6f757f0aaeb26f324472414122a742c8fca`.

Fastify 5 vẫn đáp ứng công nghệ này; backend giữ Node.js/TypeScript. Node 22
hiện có đáp ứng yêu cầu Node >=20 của v5. Fastify 4 đã hết LTS ngày 30/06/2025.
Nguồn: [migration v5](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/),
[LTS](https://fastify.dev/docs/latest/Reference/LTS/).

## Thay đổi

- Các lệnh Make truyền `PROJECT`/`ENV_FILE` đến đúng cụm. Help phân biệt log
  snapshot, mock không gửi HTTP, e2e thu hồi phiên demo và Telegram gửi thật.
- `make clean` chỉ xóa bytecode Python và thư mục cache rỗng; giữ log, khóa,
  tài liệu, symlink. Lệnh kiểm tra thiếu credentials dừng, không tự tạo mật khẩu.
- `make doctor` chẩn đoán chỉ đọc: Compose, HTTPS readiness, DB, heartbeat,
  WireGuard handshake, quyền Bastion key và SSH banner qua VPN. Không đăng nhập,
  logout, sửa DB/cấu hình hoặc gửi Telegram. Banner không chứng minh SSH/PTY
  đã xác thực hoặc host fingerprint đã khớp.
- Nâng Fastify/JWT và plugin tương thích, sửa hợp đồng WebSocket/error/429.
  [Phiên bản và audit](dependency-review.md) ghi rõ cảnh báo tooling còn lại.
- Latest/history bỏ qua mẫu tương lai cho đến khi giờ bắt kịp; dữ liệu gốc vẫn
  giữ nguyên. Không thay schema, xóa lịch sử hoặc chỉnh giờ host.

## Lệnh và kết quả đã chạy

Cụm riêng `zt_completion_check` dùng `keys/completion-check.env` được Git loại
trừ; DB/volumes riêng, cổng 8084/8444 và UDP51824, Telegram dry-run.

| Kiểm tra | Kết quả | Giới hạn |
|---|---|---|
| `python3 tests/test_make_commands.py -v` | 4 test đạt, gồm 8 trường hợp truyền project/env, cleanup và không tự tạo credentials | Fixture tệp/command; không thay cho chạy cụm |
| `make help`, `mock`, `clean`, `status` | Chạy được; clean giữ log/keys; mock không gửi HTTP | `check-telegram` chỉ xem dry-run lệnh, không gửi cảnh báo thử mới |
| `make test` | Build thành công, 68 Gateway Vitest đạt; Go trả kết quả thành công từ cache | Gateway mock DB/fetch/SSH; không tính Go là một lượt chạy native mới |
| `make up PROJECT=zt_completion_check ENV_FILE=keys/completion-check.env` | Khởi tạo cụm sạch thành công | Docker Linux cùng host, không phải VM độc lập |
| `make e2e PROJECT=zt_completion_check ENV_FILE=keys/completion-check.env` | 16 luồng API/SSH/PTY/WireGuard/RBAC/audit/logout thật đạt | Không chạy e2e trên demo chính để giữ phiên của chủ dự án |
| SQL integration đi kèm e2e | Nâng 007→008 giữ dữ liệu; registration, audit, quyền DB đạt | PostgreSQL thật trong DB tạm; CPU/timestamp cảnh báo là fixture, Telegram dry-run |
| Fixture timestamp tương lai | Latest CPU13 thay vì mẫu tương lai CPU99; history chỉ gồm mẫu hiện tại; DB vẫn đủ 3 dòng | Fastify inject + PostgreSQL thật, không đổi đồng hồ host |
| `make doctor` trên cụm riêng | Trạng thái tốt trả 0; pause Worker làm heartbeat 17,8s và SSH lỗi, trả nonzero; unpause phục hồi và trả 0 | Pause container thật; không suy thành Windows/reboot/Internet PASS |
| `make down` rồi `make up` trên cụm riêng | Volume DB còn; hash tài khoản/password/session_version, định danh node/token/fingerprint và login file giữ nguyên | Không dùng `down -v` để kiểm tra giữ dữ liệu |
| `npm audit --omit=dev` Gateway | 0 package runtime bị cảnh báo; toàn cây còn 5 package tooling | Không phải chứng nhận ứng dụng sạch lỗ hổng; Dashboard chưa nâng dependency |

## Sự cố thời gian đã quan sát

Trước khi cập nhật demo chính, `/readyz` vẫn 200 nhưng Worker đã mất heartbeat
và Agent nhận 429 dù chỉ retry mỗi 30 giây. WireGuard/SSH còn kết nối. DB có
timestamp metric tương lai khoảng 3 giờ. Mô phỏng clock rollback cho cả
rate-limit cũ và mới tạo TTL kéo dài; đây là giả thuyết phù hợp bằng chứng,
chưa chứng minh nguyên nhân máy bị lệch giờ.

Đã tạo lại Gateway/helper/Worker để bỏ cache trong bộ nhớ, giữ DB/keys/tài khoản;
heartbeat hoạt động lại. 41 dòng tương lai được quan sát trong 24.529 dòng tại
thời điểm kiểm tra, không xóa. Bản sửa truy vấn giữ mẫu tương lai khỏi che dữ liệu
hiện tại. [DEMO.md](../DEMO.md) có lệnh khôi phục khi gặp tình huống tương tự.

## Bằng chứng và giới hạn bàn giao

Demo chính đã chạy lại bằng `make up` thành công. Container thực dùng Node
22.23.3, Fastify 5.12.7 và @fastify/jwt 10.2.5. `make doctor` trả 0, heartbeat
1,4 giây, HTTPS readiness và SSH banner qua VPN hoạt động. Đối chiếu hash trước/
sau xác nhận users/password_hash/role/session_version, định danh node/token/
fingerprint, env/login file, Bastion key và hai cấu hình WireGuard giữ nguyên.
DB còn 24.767 metric, gồm đủ 41 mẫu tương lai tại snapshot sau cập nhật.
Không đăng nhập/logout tài khoản demo chính trong lượt này.

Đã dọn đúng containers/networks/volumes của `zt_completion_check` sau khi hoàn
tất thử nghiệm; không dọn volume hoặc dữ liệu demo chính.

Log lệnh và snapshot hash cục bộ ở
`/home/mowftee/.cache/zt-makefile-completion/`: `unit-build.txt`,
`isolated-runtime.txt`, `isolated-up.txt`, `isolated-up-again.txt`,
`isolated-preservation-result.json`, `doctor-isolated-*.txt`,
`gateway-audit-{runtime,full}.json`, `main-up-v5.txt`, `doctor-main-v5.txt`
và `main-v5-result.json`.
Hash chỉ dùng đối chiếu, không công bố mật khẩu, token hoặc nội dung private key.

Native Windows, service/reboot guest và Zero Inbound từ máy ngoài độc lập vẫn
**CHƯA KIỂM CHỨNG**. Không chạy lệnh gửi Telegram thử trong lượt này; demo chính
vẫn giữ chế độ live đã được chủ dự án cho phép, có thể tự cảnh báo khi tải thật
vượt ngưỡng. Không thiết kế lại giao diện hoặc viết slide/báo cáo môn học.
