# Tiến độ — 2026-10-16

## Phạm vi và Git

- Chủ dự án đã cho tiếp tục code/cấu hình/kiểm chứng, không làm slide/báo cáo môn học.
- Nhánh duy nhất: `minh-thanh`; nền Round4 `8d559101fc9bb8c45a5b39fafb5f8ff700724477`.
- `main` giữ tại `1926d4e`, không merge/push/deploy production.
- Sáu báo cáo untracked đã có từ đầu được giữ nguyên và không đưa vào commit này.
- Hai tài liệu môn học tạo ngoài ý muốn đã chuyển ra `/tmp/zt-unrequested-documents/`,
  không nằm trong repository/bàn giao.
- Đã đọc/lưu 10 skill, 3 workflows; snapshot22tệp có manifest SHA256.

## Đã thực hiện

- WireGuard kernel thật, helper chung namespace Gateway; worker demo có SSH Ed25519,
  chỉ nghe VPN, firewall namespace DROP và không publish port. Private SSH chmod400.
- Cụm demo `zt_demo` dùng env/volumes riêng; giữ `.env` và DB cũ. Bootstrap không
  xoay khóa; setup CLI dùng stdin + transaction, từ chối ghi đè định danh khác.
- Online/Stale/Offline, CPU/offline incident + audit atomic, resolve và chống lặp;
  sửa timestamp microsecond guard làm bỏ lỡ Offline. Telegram mặc định dry-run.
- Migration008 bỏ tỷ lệ RAM/disk lưu dư; đọc tỷ lệ từ bytes, giữ API. Không sửa001–007.
- Dashboard hiển thị network/uptime, sửa dữ liệu stale và lỗi mạng, bỏ claims/menu
  chưa có chức năng, sửa theme bị HTML ép dark, giữ bố cục. JWT giới hạn HS256.
- Lockfiles và build npmci; README/demo/VM runbook cùng API contract bám source thật.

## Bằng chứng cuối

- Gateway tsc và Dashboard tsc/Vite build đạt. `docs/verification/build-start.txt`,
  `dashboard-build.txt`.
- 11 Agent unit +11 Gateway Vitest đạt; Gateway mock DB/fetch, không là runtime.
- `demo.py check`:16 kiểm tra cụm thật, SSH/PTY/audit START+END cùng phiên mới,
  logout thu hồi JWT và đóng SSH đang mở.
- Cảnh báo CPU: payload/timestamp giả lập, Fastify inject + PostgreSQL thật trong
  DB tạm riêng; không chèn dữ liệu giả vào dashboard demo.
- Upgrade007→008: DB test riêng bảo toàn UUID/FK/bytes/CPU/history/users/alerts/audit;
  parent+partitions không lưu2tỷ lệ dư; latest/history trả tỷ lệ từ bytes và số JSON.
- Chromium desktop1920x1080/tablet768x1024/mobile375x667: login, viewer, terminal,
  logout, lỗi mạng; không overflow/JSerrors. Đã xem ảnh thực tế và sửa tương phản theme.
- Dừng worker thật: Stale17.80s, Offline32.82s, một incident; khôi phục Online và resolve.
- Mạng thật: handshake/transfer WireGuard; transportSSH bị chặn, SSH qua VPN thành công.
- YAML OpenAPI parse và localrefs đạt; Python/shell syntax và gitdiffcheck sạch.
- Test Python dò chuỗi cũ giữ nguyên. Baseline trước sửa146/151; kỳ vọng khóa600,
  timeout10s, schema007... không dùng để chứng nhận chức năng schema008.

## Giới hạn và điểm còn thiếu

- MiniAgent RSS23.03MiB/PSS21.12MiB, chưa đạt mục tiêu khoảng10MB; giữurllib chuẩn
  thay vì tự viết HTTP parser. Snapshot tổng container112.199MiB, không phải benchmark.
- VMware/VirtualBox và quét từ Internet thật CHƯA KIỂM CHỨNG: chưa có hypervisor/VM
  khả dụng. Đã hỏi một lần và có `docs/VM_SETUP.md`; cần môi trường từ chủ dự án.
- Telegram live hoãn theo yêu cầu; không gửi thông điệp ra ngoài.
- Build/npm audit còn4cảnh báo phụ thuộc (1moderate,2high,1critical); chưa nâng major
  framework, không chứng nhận production hoặc audit sạch.
- Dừng mở rộng. Chỉ làm tiếp khi có VM/Telegram hoặc yêu cầu cụ thể mới.

## Chạy lại

`python3 deploy/scripts/demo.py up` rồi `check`; Dashboard `https://localhost`.
Tài khoản demo-admin/demo-viewer, mật khẩu cục bộ trong keys/demo-login.env0600.
`down` giữ volumes. Cụm đang chạy để chủ dự án dùng demo; không dừng dịch vụ khác.
Commit bàn giao xem `git log -1 --oneline`.

## Giao diện — thiết kế lại theo phản hồi chủ dự án (2026-10-16)

- Phạm vi phiên này chỉ UI, giữ React + TypeScript/TSX, CSS và các thư viện đã có;
  không đổi backend, DB, agent hoặc cấu hình hạ tầng. Nhánh vẫn `minh-thanh`.
- Thay bố cục DirectAdmin bằng console navy/cyan, một sidebar, danh sách node
  và vùng chi tiết tài nguyên. Màn đăng nhập, trạng thái loading/empty/error,
  biểu đồ có thời gian thật, số liệu mạng/uptime cùng dùng theme sáng/tối.
- Bỏ role switch giả; thông tin quyền theo session thật. Node selectable bằng
  button; drawer có focus cycle, Escape, phục hồi focus và khóa cuộn nền.
- Build TypeScript/Vite đạt trong Docker; chỉ recreate dashboard của `zt_demo`.
- Firefox thật (geckodriver tạm ngoài repository): viewport 1920,1440,768,375,320px
  không tràn ngang; đăng nhập sai/đúng, đổi theme, tìm kiếm/clear, Admin SSH chạy
  lệnh + đóng, logout, Viewer không có nút SSH, không có page error trong lượt thử.
- Mất kết nối và danh sách rỗng thử bằng fetch giả lập trong browser, không đổi
  PostgreSQL. Phục hồi về API thật sau thử. Stress100.0% là sửa DOM tạm để đo layout,
  không coi là telemetry thật và không lưu vào dashboard/DB.
- Tương phản token chữ/nền chính đo bằng sRGB từ canvas browser: dark thấp nhất
  5.69:1; light thấp nhất5.04:1 trong các cặp đã đo (không là chứng nhận WCAG toàn bộ).
- Ảnh và log kiểm tra phiên này: `/tmp/zt-ui-preview-v2/`, build log
  `/tmp/zt-ui-browser/build-final.txt`; không đè ảnh bằng chứng bàn giao cũ.
- Cập nhật selector NetworkRX/TX trong browser-smoke hiện có; có thể chọn thư mục
  ảnh qua ZT_UI_OUTPUT_DIR. Lượt hiện tại dùng Firefox/WebDriver, không chạy Playwright.
- Thay đổi UI đang chưa commit/push; sáu báo cáo untracked cũ vẫn giữ nguyên.

## Module nhật ký — chủ dự án yêu cầu bổ sung (2026-10-16)

- Yêu cầu mới cho phép thêm module log sau phiên UI; reuse audit_logs hiện có,
  không thêm DB/cache, migration hoặc thư viện. Tất cả còn trên minh-thanh,
  HEAD968581e; chưa commit/push các thay đổi UI và audit.
- API GET/api/audit/logs chỉ ADMIN qua quyền DB hiện tại; Viewer403, unauth401.
  Lọc7loại sự kiện, tìm literal tài khoản/tên/IPVPN node/IPghi nhận/target;
  phân trang25, sắp created_at+id, no-store. Không có API sửa/xóa.
- Nối được node_id từ FK và JSON cũ, không ép JSON tùy ý sangUUID. Chỉ chiếu
  8trường details có giới hạn/kiểu; không trả token/password/user_agent/rawJSON.
  Chi tiết CPU/ngưỡng và offline/IP/heartbeat được giữ để giải thích sự cố.
- Dashboard có màn Nhật ký hoạt động, table/card responsive, tìm/lọc/phân trang,
  xem ID phiên SSH, loading/error/empty, refresh thủ công. Viewer không có menu.
  Chỉ log vòng đời SSH và auth thành công đang có; không thu nội dung lệnh hoặc
  tự thêm log đăng nhập thất bại. README và OpenAPI đã mô tả phạm vi này.
- Build Gateway tsc, Dashboard tsc/Vite đạt.31 Gateway Vitest (20audit+11cũ) đạt,
  PostgreSQL được mock ở unit; không coi đây là bằng chứng DB thật.
- demo.py check đạt16luồng cụm thật +alerts/schema +runtime-audit mới. Audit test
  tạo/xóa DB riêng: SQLpagination/tieUUID, escapedLIKE/injection, legacyJSON,
  CPU/offline details, no-store, auth/RBAC/revokeJWT và không có writeAPI đều đạt.
- Firefox HTTPS thật: audit/searchVPN/filter/details/pagination, SSH chạy lệnh
  và END mới xuất hiện, ViewerUI không menu +API403; viewport768/375/320 không
  tràn ngang, không pageerrors. Empty/error là fetch giả lập trong browser và
  đã khôi phục API thật. Không chèn fixture audit vào DB demo.
- Bằng chứng bền: docs/verification/audit-runtime.txt và audit-browser.json.
  Ảnh /tmp/zt-audit-preview; build logs /tmp/zt-audit-*.txt. Browser smoke sẵn có
  cập nhật kiểm tra audit; lượt thực tế này dùng Firefox/WebDriver, không Playwright.
- Chủ dự án hỏi ý tưởng DB làmcache để đạt500MB–1GB. Đã đối chiếu trực tiếp phiếu:
  'toàn bộ cụm dịch vụ vận hành tối ưu trong phạm vi500MB–1GB RAM, đáp ứng môi
  trường tài nguyên giới hạn'. Nhận xét: đây là ngân sách vận hành, không cần
  tăng RAM để lấp khoảng; cache thêm footprint và chưa giải quyết RSSagent.
  Chưa triển khai cache; giữ mô hình hiện có, chỉ cân nhắc khi có nút thắt đo được.

## Chỉnh form đăng nhập theo ảnh phản hồi (2026-10-16)

- Khung vuông quanh input do global :focus-visible thắng outline:none của input;
  sửa selector riêng cho input trong form-input/fleet-search, giữ focus-within trên
  vỏ ô để bàn phím vẫn có chỉ báo rõ. Không tắt focus của button.
- Gom icon + tiêu đề form thành một hàng, bỏ eyebrow lặp, rút ghi chú thành một
  dòng. Form desktop cao445.5px bình thường,510.5px khi lỗi; cột giới thiệu509.7px.
- Build Dashboard đạt, HTTPS200. Firefox sáng/tối1920px, mobile375/320 không tràn,
  input outline none nhưng viền/shadow của wrapper vẫn hiện. Đã xem ảnh thực.
- Chỉ thử đăng nhập bị từ chối cho tài khoản không tồn tại ui-layout-check;
  không login/logout demo-admin/demo-viewer trong lượt này để tránh thu hồi phiên
  đang dùng của chủ dự án. Ảnh/checks tại /tmp/zt-login-preview.

## Hoàn thiện theo phương án đã duyệt — 2026-10-16

- Xác nhận phiếu không cố định ngôn ngữ Agent; thay Python bằng Go stdlib, giữ
  JSON/env định danh/heartbeat3s. Collector Linux host, RX/TX một interface wg0,
  disk theo mount; lỗi bỏ beacon thay vì gửi số0. UI giải thích phạm vi đo.
- HTTP có timeout/giới hạn đọc, không redirect/proxy để lộ token; SIGTERM hủy
  request/retry. Ngân sách mềm Go6MiB khi không có GOMEMLIMIT; không là capRSS.
- Đúng image Docker cuối: RSS10572–10752kB (~10.3–10.5MiB), retry503 cô lập
  với cùng Go runtime/budget tới10.59MiB. Python cũ23.03MiB. Gần mốc khoảng10MB,
  không cam kết cứng dưới10MB; snapshot container ~115MiB chưa gồmOS/daemon/VM.
- Caddy có IP ingress cụ thể; Gateway chỉ trustIP đó. LOGIN_FAILED an toàn,
  giới hạn10login/IP/phút trướcDB/audit. IPSSH START/END cả lateEND theo request;
  reconciler lấy IP START cùnguser/session hoặcnull, không dựnglocalhost.
- VéSSH chặn replay/saiNode/deadline/JWTexpiry. AuditAPI/UI có8events và
  attempted_username; chỉADMIN. Không thu nội dung lệnhSSH.
- make test:14Go tests (kèm21invalidconfigcases),49GatewayVitest đạt; mockDB/fetch
  trongunit. BuildGateway/Dashboard/GoWorker đạt; OpenAPI8refs +syntax/diff sạch.
- Bootstrap mới zt_fresh_check từ DB/volumes riêng đạt;16luồngthật +alerts/schema/
  auditSQL thật, grantdenyUPDATE/DELETE/TRUNCATE, headertrust/rate/reconciler đạt.
- GoWorker thật:Stale17.20s,Offline31.74s,1incident rồiOnline/resolve. CPU thật
  quaGo->HTTP->DBlab cóngưỡngbaseline+4.5,2thread10s,1incident/audit vàcooldown;
  không giả thànhvượt85%. CLIcheck-cpu đã chạy; không sửaGatewaydemo/DB chính.
- FirefoxHTTPS thật1440/375/320px:scope/footer/logfailed khôngtràn; actor/IP đúng;
  XFFgiả192.0.2.99 bịCaddy bỏqua (IP thực172.30.89.1). Ảnh/tmp/zt-hardening-browser.
- Bằng chứng mới gọn: hardening-unit.txt,hardening-runtime.txt,
  agent-go-resources.txt,hardening-browser.json trongdocs/verification.
- Bỏ nhãn151/151/chứngnhậncứng của smoke-test.sh cũ; entrypoint này giờ gọi
  check runtime thật. Giữ cácPython source-string tests/báo cáo cũ làm lịch sử,
  không đổi chúng để làm xanh. Installer build đã thử; systemd chỉmock.
- Đã down/up zt_demo để đổi ingressnetwork, giữvolumes: checksumenv/login/key
  configs không đổi; users/nodes/roles/sessionversions giữnguyên, metric8148->8250,
  audit113->113; HTTPS200, nodeOnline/heartbeatmới. Khônglogin/logoutadmin lúcrollout.
- VM:KVM kernel dùngđược nhưng khôngVMware/VirtualBox/guestimage, sudo-n không
  khảdụng. HaiVM/systemd/Internet vẫnCHƯAKIỂMCHỨNG; Telegram thật vẫnhoãn.
- KhôngmergeMain (1926d4e), khôngproduction. Bàn giao bằngcommit trênminh-thanh;
  xemgitlog. Chưa push thayđổi mới. Sáu báo cáo untracked cũ giữnguyên.

## Push và Telegram live — 2026-10-16

- d255616 đã push origin/minh-thanh; remote main vẫn1926d4e.
- Người dùng cung cấp token, xác nhận @da_mmt_bot. getMe thật trên host/Gateway
  đúng bot; không có webhook. Token lưu env cục bộ0600 được Git loại trừ.
- Đã bật live, người dùng /pair thành công; DB giữ chat sau Gateway restart.
- Thêm log kết quả gửi gồm node/severity/message_id, không có token/chat ID.
- check-telegram là lệnh gửi thật riêng: CPU99% mang nhãn TEST_GIA_LAP_CPU,
  DB tạm thật, sendAlert/API thật message_id4, hai beacon chỉ một incident/audit/
  lần gửi, CPU10% resolve; không tạo fixture trong DB dashboard, không poll Bot
  từ tiến trình test. DB tạm đã xóa. Các lệnh check/check-cpu vẫn dry-run.
- Worker pause thật: Stale16.64s, Offline31.89s, một incident; Telegram xác nhận
  message_id5; finally unpause, Online/resolve, HTTPS200, không login/logoutadmin.
- Gateway build và49Vitest hiện có đạt; unit mock DB/fetch. CLI setup hiển thị
  mode live đúng; không nâng phạm vi hoặc gửi thông điệp tới chat khác.
- Bằng chứng đã lọc token/OTP/chat ID: docs/verification/telegram-live.txt.
  README/DEMO hướng dẫn setup và phân biệt payload CPU giả lập với gửi Telegram thật.
- VM/systemd/Internet vẫn chưa kiểm chứng; không merge main/production, sáu báo cáo
  untracked cũ giữ nguyên.

## Hoàn thiện Windows Worker — 2026-10-18

- Chỉ minh-thanh, sau65bfd42; chủ dự án yêu cầu commit từng việc và **không push**
  trước khi duyệt. Mô hình chọn: máy Arch Linux hiện tại chạy Gateway Docker +
  Windows VM Worker. Không tự làm slide/báo cáo môn học.
- Việc Gateway: nhận beacon không có Linux load_avg, không dựng timestamp/network/
  uptime bằng số0 khi thiếu. Từ chối RAM/disk used>total trước transaction.
- Thêm register-node CLI cục bộ dùng stdin + quyền one-shot migrator, không mở
  API enrolment. SQL idempotent, chặn xung đột name/IP/token/host fingerprint,
  không thay tài khoản/node cũ hoặc cấp thêm quyền.
- Build Gateway và58Vitest đạt (DB/fetch giả lập). Test CLI trên PostgreSQL thật
  trong DB riêng đạt: thêmVM, chạy lại, từ chối xung đột, giữ nguyên nodeDocker/
  users/grants; DB tạm đã xóa. Logs /tmp/zt-completion-{gateway-unit,registration-runtime}.txt.
- Test đầu ghi nhận giả định sai về quyền INSERT nodes: migration006 đã cấp quyền,
  GRANTSELECT/UPDATE ở007 không thu hồi quyền đó. Đã sửa kỳ vọng mới thành kiểm
  tra quyền không đổi, không gọi đây là lỗi đăng ký hoặc giả PASS; không sửa test
  cũ. Runtime role vẫn có quyền bootstrap cũ, không tuyên bố cách ly quản trị DB.
- Native Windows/VMware/VirtualBox chưa có trên máy; không có guest image, pwsh,
  VBoxManage/vmrun/qemu. Cross-build/PowerShell parser không thay kiểm thử guest.
- Việc Agent: thêm collector Win32 stdlib 64-bit, Windows service LocalService,
  JSON config tự chứa, installer ACL/giữconfig, log2x1MiB, --validate-config và
  --check không gửi HTTP. Linux giữ /proc + giao thức, Windows bỏ load_avg.
-18Go tests +21invalidconfigsubcases đạt; race/vet Linux, vet/testcompileWindows
  amd64 và buildamd64/arm64 đạt. make test Docker Go +58GatewayVitest đạt.
  Reviewer độc lập đã đối chiếu ABI MIB_IF_ROW2/CPU; sửa quota disk total/available
  cùng phạm vi, đồng bộ SCM bằngchannel/mutex và guard junction/config bộ cài.
- Installer được parser PowerShell7.6.7 Linux kiểm tra; SCM/ACL/Win32/RAM Windows
  vẫn CHƯA KIỂM CHỨNG. LocalService là identity dùng chung; không chống admin hoặc
  mọi dịch vụ khác chạy cùng identity. Không phát hành hoặc push binaries lênGit.
- Việc triển khai: prepare/register-node.py + bộ PowerShell setup/check/restore
  giữ nodeDocker .2, chuẩn bị Windows .3 và host fingerprint lấy qua kênh tin cậy.
  Peer bổ sung theo khóa riêng, kiểm tra overlap runtime/config, đăng ký idempotent
  qua migrator; không đưa private Gateway key vào Worker bundle hoặc secret vào argv.
- prepare thật đã tạo keys/windows-worker-01 bằng WireGuard keygen thật, bundle0700/
  files0600, chạy lại từ chối ghi đè và checksumenv/login/configs cũ không đổi.
  Chưa register/apply peerWindows vì chưa có SSHhostPUBLIC key thật từVM.
- Setup/check/restore có guard reparse/owner/statepaths, SSHnonadmin/khóa/VPN-only,
  firewall chỉ2rule cóscope, dependencyWG; không tự tắt rule khác hoặc sửa firewall
  host. PowerShellparser và guardLinux/mock đạt; không gọi đây là PASSWindows.
- Thêm verify-vm.py dùng luồng16checks thực, WindowsEncodedCommand + Win32NT marker,
  Admin/Viewer/SSH/audit/logout. Entry point này thu hồi phiên demo-account; chỉ
  chạy trên target đã đăng ký. NhánhWindows vẫn chưa chạy, không dựng VM giả.
