# Bộ nhớ quy tắc dự án

## Nguồn và phạm vi

- Ngày nạp: 2026-10-16 (Asia/Ho_Chi_Minh).
- Nguồn: `/home/mowftee/Templates/mowftee-guild`.
- Đã đọc 10 `SKILL.md`, README, 3 workflows và 5 mẫu bộ nhớ.
- Bản gốc: `mowftee-guild/`; `manifest.json` ghi SHA-256 của 22 tệp đã sao chép.
- Đây là bộ nhớ trên đĩa của dự án; các phiên sau đọc qua `AGENTS.md`.

## Chỉ đạo của chủ dự án

- Đính chính mới nhất: chủ dự án đã cho tiếp tục phần code, cấu hình và kiểm
  chứng, nhưng không muốn soạn slide/báo cáo môn học. Không tự tạo các sản phẩm
  này. Chỉ duy trì README, hướng dẫn chạy/demo và bằng chứng kỹ thuật cần thiết.

- Chỉ làm trên `minh-thanh`, tuyệt đối không merge vào main.
- Hoàn thiện đồ án theo phiếu giao, chạy thật, demo ổn, giải thích được.
- Tinh gọn, chuẩn mực, giữ kiến trúc. Không nâng phạm vi lên production.
- Bản nền Round 4 là `8d55910`; kiểm tra Git thực tế, giữ thay đổi chưa commit.
- Telegram chưa cần tích hợp tài khoản thật; chủ dự án bổ sung sau. Được giả lập
  để kiểm thử, ghi rõ giới hạn.
- Tự thực hiện và kiểm chứng các việc bắt buộc; chỉ hỏi khi thiếu quyết định phạm vi
  hoặc có nguy cơ ghi đè công việc/xóa dữ liệu. Không tự mở vòng nâng cấp mới.

## Áp dụng guild

- Tech lead: chọn thiết kế đơn giản, phân công có ranh giới, cập nhật bộ nhớ.
- Backend/database/security/devops: hợp đồng API, xác thực và RBAC, transaction,
  timeout, bảo vệ bí mật, mạng WireGuard và Zero Inbound theo phiếu giao.
- Frontend/designer: dữ liệu thật, đủ Loading/Empty/Error/Success, trạng thái rõ,
  giao diện dùng được trên màn hình nhỏ.
- Reviewer/tester: phản biện độc lập, nêu nguyên nhân/bằng chứng/cách sửa; không
  chứng nhận hoàn thành khi chưa chạy luồng chính. Không dùng sleep tùy tiện để
  che race condition trong bài test.
- Doc writer: chỉ lệnh cài đặt đã chạy thử, kịch bản demo và giới hạn; không soạn
  slide hoặc báo cáo môn học trong phạm vi hiện tại.
- Mẫu guild chỉ là mẫu, không sao chép số PASS, SLA, chữ ký hoặc chứng nhận.
- Áp dụng delegation bằng công cụ sẵn có; không đổi nhánh cho subagent khi người
  dùng đã yêu cầu làm trên `minh-thanh`.

## Đầu vào

- Phiếu giao: `/home/mowftee/Downloads/Nhom_9_Phieu giao hoc phan ĐA CSN.doc`.
- Nhóm 9, lớp 2026FE6083001; giảng viên TS. Nguyễn Đắc Hải.
- Hạn trên phiếu: 16/12/2026.
- Sản phẩm: 01 slide, 01 mô hình/mô phỏng, 01 quyển báo cáo theo QĐ 815/QĐ-ĐHCN.
- Kỹ thuật: WireGuard M2M, Zero Inbound máy con, VM + Docker, React Dashboard,
  WebSocket/SSH/PTY, ADMIN/VIEWER, CPU/RAM/disk/network/uptime, Telegram sự cố
  offline và CPU, UDP 51820 tại Gateway, Ed25519 chmod 400, heartbeat 3s,
  phát hiện mất tín hiệu 15–45s, RAM agent khoảng 10MB và cụm 500MB–1GB,
  trạng thái Online/Stale/Offline; Fastify/TypeScript/PostgreSQL/Linux/Compose.

## Chỉ đạo UI — 2026-10-16

- Công việc hiện tại chỉ sửa giao diện. Chủ dự án yêu cầu thiết kế lại vì bản UI
  đầu chưa ưng ý; giao diện chuyên nghiệp về an ninh/giám sát, vừa tầm đồ án.
- Giữ ngôn ngữ/công nghệ đúng phiếu: Dashboard React, code TypeScript/TSX.
  Không tự chuyển agent sang Go theo đề xuất trước trong phiên làm UI.

## Bổ sung sau phiên UI — 2026-10-16

- Chủ dự án yêu cầu thêm module ghi log: được bổ sung API đọc audit và UI ADMIN
  trên nền audit_logs sẵn có, giữ phạm vi đồ án và stack TypeScript/React/PostgreSQL.
- Ý tưởng thêm DBcache mới chỉ được hỏi để nhận xét; chưa triển khai cache.

## Phạm vi được duyệt sau phản biện — 2026-10-16

- Chủ dự án duyệt phương án sửa telemetry/log/RAM và kiểm chứng an ninh, rồi
  xác nhận Agent có thể dùng ngôn ngữ khác nếu phiếu giao không cố định.
- Đã đọc lại phụ lục: chỉ cố định Fastify/TypeScript, React, PostgreSQL; không
  cố định ngôn ngữ Mini-Agent. Chuyển Agent sang Go stdlib được phép; giữ backend/UI.
- Giao diện đã được chủ dự án chấp nhận. Chỉ bổ sung giải thích phạm vi số liệu
  và sự kiện LOGIN_FAILED; không mở vòng thiết kế lại hoặc thêm dịch vụ/cache.
- Giữ Telegram dry-run; không soạn slide/báo cáo môn học; vẫn chỉ minh-thanh.

## Telegram được cho triển khai thật — 2026-10-16

- Chủ dự án đã cấp token và xác nhận bot đúng là @da_mmt_bot (hai chữ m).
- Được bật live, ghép nối OTP và gửi cảnh báo kiểm thử tới chat đã ghép nối.
  Chỉ đạo này thay việc hoãn Telegram trước đây; môi trường mới vẫn mặc định dry-run.
- Token chỉ ở keys/demo.env0600, không đưa token/OTP/chat ID vào Git hoặc báo cáo.
- Không thêm dịch vụ, thư viện hoặc trang cài đặt ngoài phạm vi đồ án.

## Hoàn thiện Linux Gateway + Windows Worker — 2026-10-18

- Chủ dự án cho triển khai Agent Windows, bộ cài VM, kiểm chứng SSH/VPN/telemetry/
  cảnh báo/tài nguyên và chỉnh dashboard tập trung; giữ kiến trúc và Linux Agent.
- Gateway tiếp tục chạy Docker trên máy Arch Linux hiện tại; Windows VM là Worker.
  Hai VM không phải số lượng bắt buộc trong phiếu giao.
- Xong từng việc thì commit riêng trên minh-thanh. **KHÔNG PUSH** cho đến khi chủ
  dự án xem kết quả và duyệt; chỉ đạo này thay quyền push của những phiên trước.
- Tự quyết định việc thông thường; ghi vấn đề nghiêm trọng và phần chưa kiểm chứng
  để báo cáo cuối. Không soạn slide/báo cáo môn học.

## Makefile và dependency — 19/10/2026

- Quyền push trước đã dùng để đưa bảy commit đến f83265b lên minh-thanh. Các
  commit mới sau đó vẫn chờ chủ dự án duyệt, không suy ra quyền push tiếp.
- Sau review ZIP, chủ dự án đồng ý giữ bản của mình, cải tiến có chọn lọc và
  yêu cầu kiểm tra Makefile. Phạm vi: cleanup an toàn, chọn project/env, doctor
  chỉ đọc và Fastify/JWT phù hợp; không tích hợp nguyên bản ZIP hoặc thêm dịch vụ.
- Đã đọc lại phiếu gốc khi được hỏi về Fastify5: chỉ ghi Backend Node.js
  (Fastify/TypeScript), không khóa phiên bản. Nâng Fastify5 vẫn đúng công nghệ.

## Quy ước bố cục code — chỉ đạo 19/10/2026

- Chủ dự án yêu cầu code rõ ràng, rành mạch, gọn; phân chia thư mục theo trách
  nhiệm và đặt tên giúp tìm được nơi xử lý chức năng.
- Giảm xuống dòng/dòng trống không cần thiết. Giữ khối logic dễ đọc và định dạng
  theo ngôn ngữ; không dồn nhiều câu lệnh vào một dòng chỉ để giảm số dòng.
- Comment vừa phải, tập trung vào lý do thiết kế, ranh giới bảo mật, điều kiện
  quan trọng hoặc hành vi khó thấy; bỏ banner và lời kể lại code dư thừa.
- Chương trình chính/entry point chủ yếu gọi các hàm khởi tạo, chạy và dừng.
  Đưa logic nghiệp vụ và phần định nghĩa hàm ra đơn vị phù hợp; hạn chế hàm lồng
  trong main. Callback/closure cần thiết vẫn dùng khi giúp code dễ hiểu.
- Chia module vừa đủ theo kiến trúc hiện có, không thêm tầng/hàm bọc hoặc nhiều
  file rất nhỏ chỉ để main trông ngắn. Giữ hành vi, API, xác thực và dữ liệu.
- Chủ dự án đang hỏi về Supabase/Vercel/AWS để cân nhắc cải tổ; chưa chốt chuyển
  dịch vụ, migrate DB hoặc triển khai cloud. Không suy ra quyền tạo tài nguyên
  trả phí hay triển khai từ câu hỏi tìm hiểu nền tảng.

## Nguyên tắc ưu tiên được nhắc lại — 19/10/2026

- Mọi đề xuất và thay đổi phải tuân theo phiếu giao, đồng thời tối ưu trong phạm
  vi đồ án: code rõ/gọn, tài nguyên phù hợp, ít thành phần và dễ chạy/demo.
- Giải thích lợi ích cụ thể của việc thêm/thay công nghệ; đối chiếu với yêu cầu
  môn học. Supabase/Vercel/AWS là lựa chọn theo nhu cầu, không là yêu cầu mới.
- Ưu tiên hoàn thiện và kiểm chứng kiến trúc đang có; không tăng phạm vi hoặc
  chuyển cloud chỉ để dùng thêm nền tảng. Không tự nâng chuẩn lên production.

## Chuẩn bị prompt cho báo cáo — 19/10/2026

- Chỉ đạo mới cho phép hỗ trợ chuẩn bị phần tài liệu: đọc mẫu đồ án người khác
  `Downloads/do-an-tren-mang.md`, soạn prompt để chủ dự án đưa AGY viết phần1/2.
- Theo cấu trúc mẫu, hiểu phần1/2 là Chương1 tổng quan/cơ sở lý thuyết và Chương2
  phân tích/thiết kế. Lượt này chỉ soạn prompt, không tự viết báo cáo hoặc slide.
- Phiếu giao/source thực tế ưu tiên hơn nội dung mẫu EVE-NG; không sao chép hoặc
  gán kết quả VM/Windows/Internet và các cải tổ dự kiến thành đã hoàn thành.
