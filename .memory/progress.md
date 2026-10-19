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
- Việc dependency: audit mới Gateway runtime4 package, toàncâyGateway9 vàDashboard9;
  không gọi đây là4exploit đã chứng minh. Đối chiếu advisory upstream với cấu hình
  thật; HS256/secret tĩnh/cacheoff, khôngHTTP2/private404/stream, Nginxstatic.
  Chưa tìm đường bypass cụ thể nhưng Fastify4/JWT vẫn OPEN, Fastify4 hếtLTS.
- Gateway đổi baseNode20→22, Vite dev/preview chỉloopback. Build/unit18Go+58Gateway
  và16luồng runtime cùngSQLschema/audit/registration thật đạt trên cụm riêng Node22.
  docs/verification/dependency-review.md ghi điều kiện và phần chưavá, không tự
  nâng major framework hoặc gọi bản này đã sạch securityaudit.
- Việc Dashboard: sync/time/heartbeatage và last sample rõ, lọcstatus hoạt động,
  charttimestamp thật/ngắtgap>15s, RX/TX tíchlũy, giải thíchOS-neutral không dựng
  nhãnWindows. Terminalretry, READYtimeout, nềninert/focus và AltEsc; giữ login.
- Docker tsc/Vite đạt; Firefox157 với cụmLinux riêng đạt17checks: API/SSHlệnhthật,
  đóngshell/mởphiênmới, audit, Viewer, theme và viewport1920/768/375/320khôngtràn.
  Fetcherror là giảlập trongbrowser rồi trảAPIthật; không là mấtmạng vật lý.
  SSRfixtures chart/unknownRAM/timegap đạt; không gọi đây là Windows runtime.
- Phát hiện cuối: demo.py up buildGateway/UI nhưng có thể giữ imageWorker cũ khi
  image đã tồn tại. Đã thêm --build ở bước upWorker, build/recreateWorker thật và
  chạy lại nguyên lệnhup thành công; --validate-config và --check của binary mới
  hoạt động. Không thu hồiJWT/chạylogout trên demo chính; checksum/identities giữ nguyên.
- Bàn giao kỹ thuật18/10: README/DEMO/VM_SETUP cập nhật, WINDOWS_WORKER.md có lệnh
  từng bước và nhãnWindows chưachạy. completion.md + rawunit/runtime/resources/
  Windowsstatic/browser/rollout +3ảnh gộp bằng chứng, không làm slide/báo cáo môn học.
- DBoutage thực ở cụm riêng: auth/me vànodes trả503 khiPGdừng, cùngJWT làm việc lại
  sauPGstart; mainDBkhông dừng. Liveness15.19/30.21s, CPULabthreshold20.21peak30.26.
- Go build thực khiến CPUhost main vượt85:88.66%/87.25%, auditCPU_HIGH vàTelegram
  ackmessage14/15. Đây là cảnh báo tự động do tải thật, không testpayload, không
  nativeWindows. Đã ghi completion-cpu-telegram-live.json và cập nhật nhận xét
  trước đó 'không gửi thêm tin': getMe chỉđọc, nhưng dịch vụlive tự gửi khiCPUcao.
- Finalrollout users/nodes/passwordhash/sessionversions/env/key giữ nguyên;
  metrics20292→20521, audit127→129 (haiCPU_HIGH thực), Node20.20.2→22.23.3.
  Workerimage thật đãrebuild; rawdata/volume demo chính không xóa, ownerJWTkhônglogout.
- Đã dọn đúng zt_completion_check containers/networks/volumes do lượt này tạo;
  giữ env test để tái lập. NativeWindows/Internet/RAMWindows vẫn CHƯA KIỂM CHỨNG;
  runtime4package dependencyOPEN; LinuxAgent≈11MiBRSS, containers≈128MiB snapshot.
- Read-only remotecheck: minh-thanh vẫn65bfd42, main1926d4e. Cáccommit mới cục bộ,
  khôngpush, chỉpush khi chủ dự án duyệt. Sáu báo cáo untracked cũ giữ nguyên.

## Chủ dự án duyệt push và review ZIP — 19/10/2026

- Sau báo cáo, chủ dự án đã duyệt push bảy commit đến f83265b lên đúng remote
  minh-thanh; đã xác nhận remote khớp, main vẫn1926d4e. Quyền push đó đã thực hiện.
- Công việc kiểm chứng Windows được chuyển sang review ZIP theo chỉ đạo mới.
  KVM API12 dùng được, nhưng không có guest/hypervisor; chỉ cross-build/vet lại
  Windows amd64/arm64 và compile test exe. Chưa tải ISO hoặc tạo/chạy Windows VM.
- ZIP mới: Downloads/zt-serverops-v1.1.0.zip, SHA256
  ffb8dc98eb3cf6482f300260acd06c8c276d063bb410613343ec808bd3610047.
  Giải nén riêng tại /home/mowftee/.cache/zt-friend-review/ffb8dc98eb3c;
  97 checksum khớp. Review và bằng chứng ở REVIEW.md trong thư mục đó.
- Không sửa mã ZIP hoặc mã ứng dụng minh-thanh. Dùng guild reviewer/security/
  tester/devops và ba reviewer độc lập có ranh giới; root chạy runtime.
- Build nguyên Dockerfile backend/frontend đạt; Python61 và module12 đạt;
  PGlite14 subcases đạt (reporter15 gồm cha), promtool3.5.0 SUCCESS4trườnghợp.
  Test Python đặc quyền dùng mock, PGlite/fetch giả lập; không quy thành VM/VPN.
- Đã chạy đủ5service thật trong project zt_friend_review, secrets/DB/volume riêng,
  localhost18080/18081/18082, Telegram chưa cấu hình. Không chạy installer/nft/WG
  host. OpenSSH fixture riêng trên Docker bridge, không phải VM hoặc WireGuard.
- BLOCKER thực: provision.ts dùng $2::inet rồi $2::text, PostgreSQL16 suy luận
  inet nên ssh_host thành10.77.0.2/32; SSH ENOTFOUND. PGlite tests bỏ lọt trường này.
  Lưu lỗi nguyên trạng trước; chỉ normalize ssh_host trong DB tạm để thử lỗi sau.
- Runtime sau normalize fixture:20checks,13đạt/7lỗi. Cookie cũ vẫn200 sau logout,
  SSH cũ vẫn chạy sau5,5s; shell exit không đóngWS/ghiDISCONNECT; resize123x37 bị mất
  thành24x80; XFF tự đặt đi vào audit; ViewerSSH403 đúng nhưng thiếu audit từchối.
- Firefox158:6checks,5đạt/1lỗi; Grafana thật renderpanel, layouthẹp CSS500px không
  tràn nhưng ẩn nútLogout. Không tuyên bố đã thử390px (Firefox giữ minimum500px).
  Nghi ngờ Escape từsource không tái hiện trongxterm, đã rút khỏi lỗi xác nhận.
- Snapshot5container≈227,4MiB, không tínhOS/daemon/Agent; collectorPython host
  khoảng23,3MiBRSS, chưa phải serviceDebian. Audit ZIP runtime1moderate(fast-jwt).
  Chưa nghiệm thu systemd/reboot/WGhai máy/ZeroInbound/Telegram thật; không có
  WindowsAgent, nhưng phiếu giao không bắt Windows hoặc ngôn ngữAgent cố định.
- Kết luận: có ý tưởng quản lýnode/UI/vận hành và Fastify5 đáng học; chưa nhận
  nguyên trạng làm bản demo vì lỗiSSH/logout. Không tự sửa hoặc tích hợp ZIP.
  Ghi nhớ review bằng commit riêng; không tự push thêm khi chưa được yêu cầu.
- Đã dọn đúng containers/networks/volumes của zt_friend_review và SSHfixture;
  ZIP và97file nguồn không đổi byte nào. Demo chính vẫnreadyz200, sáu báo cáo
  untracked cũ giữ nguyên; bằng chứng và cấu hình thử riêng còn trongcache.

## Hoàn thiện Makefile và Fastify5 — 19/10/2026

- Chủ dự án đồng ý cải tiến có chọn lọc sau review ZIP, yêu cầu kiểm tra Makefile
  và tiếp tục. Đang dùng guild devops/tester/reviewer/security, phân công độc lập
  phần script và dependency, reviewer chỉ đọc; không sửa ZIP, không thêm dịch vụ.
- a11a82e: Make nhận đúng PROJECT/ENV_FILE; clean chỉ bytecode, giữ log/keys/docs/
  symlink; doctor chỉ đọc Compose/HTTPS/DB/heartbeat/WG/SSH banner/key400; lệnh
  kiểm tra thiếu login file dừng, không tự tạo credentials mới. Help mô tả đúng
  mock không HTTP, logs snapshot80, e2e thu hồi phiên và Telegram gửi thật.
- 6a9d5b0: Fastify5.12.7, JWT10.2.5/fast-jwt6.3.5, plugins tương thích, giữ Node22.
  Nhận WS trực tiếp, errorhandler kế thừa/redaction, rate-limit vẫn trả429.
  68Vitest đạt, gồm10regressioncases mới; unit mockDB/fetch/SSH, pluginWS inject thật.
  Runtime audit0; toàn cây còn5package tooling (2moderate/1high/2critical), không
  đóng gói devdependencies vào runner. Dashboard dependency không sửa.
- e0c1a4f: latest/history lọc recorded_at<=NOW, giữ dòng tương lai trong DB.
  Phát hiện khi mainready200 nhưng heartbeat cũ, Agent429, WG/SSH còn hoạt động.
  DB có mẫu tương lai3h; mô phỏng clock rollback tạoTTL10.860.000ms ở rate-limit
  cũ và mới, là giả thuyết nguyên nhân chứ chưa xác minh lịch sử clock host.
  Tạo lại đúng Gateway/helper/Worker khôi phục heartbeat, không chỉnh giờ/xóa DB.
- make test đạt:68GatewayVitest chạy mới, Go thành công từcache (18testsource
  không đổi; không gọi đây là18lượt native mới). 4Python script tests mới đạt,
  gồm8trường hợp project/env; make help/mock/clean/status/logs chạy được; lệnh
  check-telegram chỉ dry-run cú pháp, không gửi cảnh báo thử mới.
- Cụm sạch zt_completion_check/env riêng/DBvolumes riêng/Telegramdry-run: make up
  và16luồng API/SSH/PTY/WireGuard/RBAC/audit/logout thật đạt. SQL thật upgrade007→008,
  audit/quyền/registration đạt; fixture tương lai giữ3dòng, latestCPU13 bỏCPU99,
  history2. CPU/timestamp alertfixtures không gọi làCPU/mấtmạng vật lý.
- Doctor cụm riêng: bình thường0; pause Worker thật tớiheartbeat17,8s trảnonzero
  và lỗiSSH; unpause hồi phục0. Thiếuenv trảnonzero không tạo file. Down/up giữ
  volume, hashusers/password/sessionversion/nodes/token/fingerprint/login file.
- make up chính thành công: Node22.23.3/Fastify5.12.7/JWT10.2.5 trongcontainer thực;
  doctor0, heartbeat1,4s, SSHbanner/VPN tốt. Hashidentities/sessionversions và
  env/login/Bastionkey/WGconfigs giữ nguyên; metric24.767,41future giữ nguyên.
  Không login/logout chính; không xóa dữ liệu hoặc volume. Đã dọn đúng cụm thử
  do lượt này tạo. Main vẫn chạy; Telegramlive có thể tự gửi nếu tải thật cao.
- Khi chủ dự án hỏi Fastify5, đã mở lại đúng phiếu Downloads, SHA256
  ae5baf56b25ecc521fbb2d8120ccc6f757f0aaeb26f324472414122a742c8fca. Ghi Backend
  Node.js(Fastify/TypeScript), không khóa phiên bản; Fastify5 phù hợp, Node22 đủ
  điều kiện. Đối chiếu tài liệu chính thức: Fastify4 hếtLTS30/06/2025.
- README/DEMO và docs/verification/commands-v5.md, dependency-review.md cập nhật
  kết quả/giới hạn. Rawlog ở ~/.cache/zt-makefile-completion, không có secret
  trong báo cáo. WindowsVM/service/reboot/ZeroInbound máy độc lập vẫn CHƯA KIỂM CHỨNG.
- Chỉ minh-thanh, không merge/reset/main/production, không push thêm. Các commit
  mới sau f83265b chờ duyệt; sáu báo cáo untracked cũ giữ nguyên.

## Push được duyệt và định hướng cải tổ — 19/10/2026

- Chủ dự án yêu cầu push trước khi đưa ý kiến cải tổ. Đã push đúng5commit
  f83265b→1a024ae lên origin/minh-thanh; ls-remote xác nhận1a024ae56c18a76ee1d4d902daf52381f6900f30.
  Remote main vẫn1926d4e532d62d3e1c5e7b8d286d3229e4d22f32, không merge/forcepush.
- Chỉ đạo mới: bố cục rõ, gọn, ít dòng trống/comment; main chủ yếu gọi hàm,
  hạn chế định nghĩa hàm lồng; thư mục phân trách nhiệm. Đã lưu quy ước chi tiết
  vào project-rules.md, giữ tính dễ đọc và không thêm lớp bọc vô ích.
- Đã khảo sát entrypoint/thư mục hiện có để trả lời hướng cải tổ; lượt này chưa
  thay mã ứng dụng hoặc chuyển dịch vụ. Dùng guild tech-lead ở mức phù hợp.
- Tra cứu tài liệu chính thức Supabase/PostgreSQL/Auth/Storage/Realtime,
  Vercel/Vite và AWS EC2/security groups. Vercel KB hiện ghi WebSocket native
  public beta có giới hạn duration; không lặp lại khẳng định cũ rằng Vercel
  tuyệt đối không hỗ trợ WS. Gateway còn cần WireGuard/UDP và tiến trình lâu dài.
- Câu hỏi về ba nền tảng là bước tìm hiểu; chưa tạo cloud account/resource,
  migrate DB, thay auth hoặc deploy. Các thay đổi sau push này vẫn chưa push.
- Chủ dự án nhắc lại nguyên tắc quyết định: tuân theo phiếu giao và tối ưu.
  Đã lưu vào project-rules.md; ưu tiên cụm Linux/Compose/PostgreSQL và kiểm chứng
  WorkerVM, cân nhắc cloud theo nhu cầu thực thay vì mặc định thêm ba nền tảng.

## Kế hoạch cải tổ code — 19/10/2026

- Chủ dự án yêu cầu lập kế hoạch trước; lượt này chỉ khảo sát source và viết kế
  hoạch, chưa sửa mã ứng dụng, chạy lại runtime, chuyển dịch vụ hoặc push.
- Đã dùng guild tech-lead/code-reviewer; reviewer độc lập chỉ đọc Gateway/Bastion,
  root khảo sát frontend/Agent/scripts/build/importers, không có chỉnh sửa trùng.
- Kế hoạch lưu ở .memory/refactor-plan.md: baseline → entrypoint Gateway/Agent
  → Dashboard logic/layout → CSS → SSH modules → scripts/bàn giao. Mỗi phần
  commit riêng, kiểm chứng đúng phạm vi, giữ API/giao diện/DB và kiến trúc hiện có.
- Điểm rủi ro phải giữ: Fastify errorhandler trước routes; shared SSH registry/
  timer và cleanup/audit; React polling/effect cleanup; thứ tự CSS cascade;
  Go buildtags/cross-build và CLI/env/credentials. Không tách theo số dòng.
- Số test trước chỉ là baseline lịch sử, không là PASS refactor. Các test dò
  source/probe cũ có kỳ vọng lỗi thời; phải dùng kiểm tra hành vi khi triển khai.
- WindowsVM/native/reboot/Internet vẫn chưa kiểm chứng, là phần nghiệm thu riêng.
  Chỉ minh-thanh, giữ sáu báo cáo untracked, không push thêm.
