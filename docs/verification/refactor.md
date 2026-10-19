# Kiểm chứng cải tổ code — 19/10/2026

Phạm vi: thực hiện kế hoạch cải tổ trên `minh-thanh`, từ baseline `22d36c9`.
Giữ Fastify/TypeScript, React, PostgreSQL, Go Agent và Docker Compose; không
thêm dependency, dịch vụ, tính năng cloud hoặc thay schema. Không push/merge.

## Bố cục sau cải tổ

| Yêu cầu | Kết quả | Bằng chứng |
|---|---|---|
| Entry point tập trung gọi hàm | Gateway `server.ts` 204→14 dòng; Agent `main.go` 207→19; demo CLI 131→23 | `app.ts`/`runtime.ts`, Agent `cli.go`/`http.go`/`runner.go`, `demo_actions.py` |
| Dashboard chia trách nhiệm | `App.tsx` 473→84 dòng; `ClusterOverview.tsx` 569→295 | `pages/`, `layouts/`, hooks session/cluster/history và summary/details |
| SSH dễ tìm nơi xử lý | Tách Bastion thành tickets, registry và session | Registry sở hữu quota/timer; cleanup từng phiên ở `session.ts`, không import vòng |
| CSS rõ nhóm, giữ hình thức | `theme.css` nhập sáu nhóm theo thứ tự cũ | CSS bundle trước/sau giống byte; ảnh desktop/tablet/mobile và computed styles |
| Comment vừa đủ | Bỏ banner/lời kể lại code trong các phần đã sửa | Giữ giải thích bảo mật, cleanup, pending request và build tags |

Số dòng chỉ giúp thấy nơi điều phối đã gọn hơn, không phải mục tiêu giảm tổng
code. `session.ts` vẫn giữ closure quản lý cùng một phiên SSH để cleanup dễ
theo dõi; không tách thành nhiều helper nhận hàng loạt tham số.

| Commit | Phần hoàn thành |
|---|---|
| `b26f825` | Agent startup, HTTP và vòng thu thập/gửi |
| `bb3498c` | Demo CLI và action handlers |
| `353633a` | Dashboard session, layout và dữ liệu |
| `24bbd30` | Sáu nhóm CSS, giữ cascade |
| `d982155` | Gateway app factory và runtime sở hữu startup/shutdown |
| `7df23e3` | Vé SSH, registry và tài nguyên từng phiên |
| `18b2fa2` | Sửa yêu cầu đăng xuất JSON trên Dashboard |

## Lệnh và bằng chứng

Cụm thử `zt_refactor_check`, env Git bỏ qua `keys/completion-check.env`, cổng
HTTPS 8444/HTTP 8084/UDP 51824, DB/volumes riêng, Telegram **dry-run**. Các lần
đăng nhập/logout và pause Worker chỉ thực hiện trên cụm này.

| Kiểm tra đã chạy | Kết quả | Phạm vi thực tế |
|---|---|---|
| `make test` | 85 Gateway Vitest đạt; Docker build Agent/Gateway đạt | DB/fetch/SSH giả lập ở Vitest; Go trong lệnh này có thể dùng cache |
| `go test -count=1 -v ./...` trong builder | 18 Go tests đạt ở lượt chạy mới | Linux Docker; race/vet, Linux static và Windows amd64/arm64 cross-build cũng đạt |
| `python3 tests/test_make_commands.py -v` | 6 tests đạt | Fixture tệp/command, giữ assertion cũ; thêm guard credentials/Compose |
| `make down PROJECT=zt_refactor_check ENV_FILE=keys/completion-check.env`, rồi `make up` cùng tham số | Build Gateway/Dashboard/Agent và khởi động lại đạt | Volume DB còn, hash users và định danh node giữ nguyên |
| `make e2e PROJECT=zt_refactor_check ENV_FILE=keys/completion-check.env` | 16 luồng thật đạt | API, telemetry, WireGuard, WebSocket→SSH→PTY, RBAC, audit, logout đóng SSH và thu hồi JWT |
| SQL integration đi kèm e2e | Nâng 007→008 giữ dữ liệu; schema, audit, registration đạt | PostgreSQL thật trong DB tạm; CPU/timestamp alert là fixture, không phải CPU/mất mạng vật lý |
| `python3 tests/demo-liveness.py --env-file keys/completion-check.env --project zt_refactor_check` | Stale 15,00s; Offline 29,90s; một incident; phục hồi Online và resolved | Pause/unpause Worker thật, trong ngưỡng mất tín hiệu 15–45s; Telegram dry-run |
| Firefox 158.0 trên cụm thật | 47 kiểm tra đạt sau sửa logout | Admin/Viewer, search/filter, audit, hai lần SSH thật/đóng/mở lại, sáng/tối, menu bàn phím, viewport 1920/768/375/320 |
| Trạng thái lỗi Dashboard | Hiện cảnh báo và hồi phục API thật đạt | Lỗi fetch được giả lập có nhãn; không coi là ngắt mạng vật lý |
| `make doctor PROJECT=zt_refactor_check ENV_FILE=keys/completion-check.env` | Exit 0 | Chẩn đoán chỉ đọc; SSH banner không thay cho kiểm tra PTY ở e2e/browser |

Bổ sung 17 regression Gateway tập trung vào timer/listener, quota khi đồng thời,
startup thất bại và cleanup/backpressure. Không đổi kỳ vọng để che lỗi. Các bài
Python dò chuỗi source/round cũ có kỳ vọng vị trí lỗi thời không dùng làm tiêu
chí nghiệm thu; bộ Vitest đang hoạt động cập nhật import khi module di chuyển.
SSR 16 fixture so markup và kiểm tra AST là bằng chứng source/giả lập bổ sung.

Baseline browser có 43 kiểm tra đạt theo phạm vi cũ, nhưng **logout HTTP 400** ở
cả hai vai trò; bộ cũ chỉ kiểm tra xóa phiên trình duyệt. Không coi đây là PASS
thu hồi token phía Gateway. Phát hiện này được giữ nguyên trong rawlog. Bản sửa
gửi body JSON `{}` trong `api.logout`, thay vì POST JSON rỗng. Sau sửa, trình
duyệt thật xác nhận logout HTTP 200 và token cũ HTTP 401 ở cả Admin/Viewer.

CSS bundle trước/sau có cùng SHA-256:
`68905054dfe630587f7d86858683487be74796b1ea389354f7c1d76a02efcda5`.
Ảnh có số telemetry và audit khác nhau vì dữ liệu sống; sau bài pause Worker,
biểu đồ có khoảng ngắt và hiện đúng thông báo cách hai mẫu hơn 15 giây.
So 1.140 trường computed styles/geometry: 1.102 giống; 38 khác do thông báo gap,
hai dòng audit mới và thời điểm chụp CSS transition. Đã xem ảnh, đối chiếu chiều
cao và đợi animation kết thúc bằng sự kiện để xác nhận màu/vị trí đích. Không
sửa baseline hoặc xóa các khác biệt khỏi kết quả so sánh.

## Demo cục bộ và giữ dữ liệu

Đã chạy `make up` trên demo chính `zt_demo` thành công với image mới. Lượt
`make doctor` ngay sau khi container Worker bắt đầu báo heartbeat cũ 21,8 giây;
lần kiểm tra tiếp theo trả 0, heartbeat 2,8 giây, VPN/SSH banner hoạt động. Giữ
log cả hai lần; không coi container vừa start đồng nghĩa Agent đã gửi heartbeat.

Hash trước/sau xác nhận users/password/role/session_version và định danh node/
token/fingerprint giữ nguyên; không login/logout tài khoản demo chính. Metric
tăng 29.787→30.216 dòng tại thời điểm đo. 13/13 tệp giữ nguyên byte, gồm tám báo
cáo có sẵn và năm tệp env/login/key/WireGuard. Đã dọn container/network/volume của cụm thử
do phiên này tạo, giữ demo chính và dữ liệu hiện có.

Không đổi lệnh sử dụng: `make up`, mở `https://localhost`, xem `make doctor` và
làm theo [kịch bản demo](../DEMO.md). Tài khoản/mật khẩu hiện có không thay đổi.
Remote `minh-thanh` vẫn ở `7ee86a0`, remote `main` vẫn ở `1926d4e` khi kiểm tra
cuối phiên; các commit cải tổ chỉ có cục bộ.

## Tài nguyên và giới hạn

Hai snapshot cùng cụm Linux: Agent RSS 11,92→10,83MiB; tổng working set sáu
container 126,31→116,30MiB. Không thấy tăng bất thường ở các mẫu này; không suy
ra refactor làm giảm RAM hoặc chứng nhận trần bộ nhớ. Số đo không gồm kernel,
Docker daemon, hệ điều hành hoặc VM; không chứng minh tổng mô hình 500MB–1GB.

Windows native/service/reboot, hypervisor và Zero Inbound từ máy Internet độc
lập vẫn **CHƯA KIỂM CHỨNG**. Cross-build và Linux Docker không thay thế các phần
này. Đợt cải tổ không kiểm thử gửi Telegram thật; demo chính đang live có thể
tự gửi khi phát sinh sự cố thực tế. Không tự gửi thông điệp thử mới.

Rawlog, ảnh trước/sau và JSON không chứa token/mật khẩu ở:
`/home/mowftee/.cache/zt-refactor-20261019/` (cache cục bộ, không đưa vào Git).
Chạy lại dùng hướng dẫn [README](../../README.md) và [DEMO](../DEMO.md).
