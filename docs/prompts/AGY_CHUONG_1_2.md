# Prompt cho AGY: biên soạn Chương 1 và Chương 2

Bạn hỗ trợ biên soạn báo cáo đồ án cơ sở ngành Mạng máy tính và truyền thông dữ
liệu, định hướng an ninh mạng. Hãy đọc tài liệu đầu vào rồi viết hoàn chỉnh CHỈ
Chương 1 và Chương 2 cho dự án ZT-ServerOps / trust-me-bro. Nội dung phải đủ rõ
để sinh viên hiểu, chỉnh sửa và giải thích trước giảng viên.

## 1. Đầu vào và thứ tự ưu tiên

- Mẫu tham khảo: `/home/mowftee/Downloads/do-an-tren-mang.md`.
- Phiếu giao: `/home/mowftee/Downloads/Nhom_9_Phieu giao hoc phan ĐA CSN.doc`.
- Repository: `/home/mowftee/Projects/trust-me-bro`, nhánh `minh-thanh`.
- Đọc `AGENTS.md`, `.memory/project-rules.md`, `.memory/progress.md`, `README.md`,
  `docker-compose.yml`, `contracts/openapi.yaml`; xem source Gateway/Agent/UI và
  migrations ở mức cần thiết để mô tả đúng thiết kế.
- Đọc `docs/verification/commands-v5.md`, `docs/verification/dependency-review.md`,
  `docs/verification/completion.md`, `docs/VM_SETUP.md`, `docs/WINDOWS_WORKER.md`
  để biết hiện trạng và giới hạn.
  Đối chiếu ngày/phiên bản, vì tài liệu cũ có thể mô tả code trước nâng cấp.

Phiếu giao và chỉ đạo mới nhất của chủ dự án quyết định yêu cầu. Source/cấu hình
thực tế quyết định cách mô tả triển khai. Mẫu chỉ dùng để học bố cục và mức trình
bày; không phải yêu cầu chức năng của dự án này. Nếu yêu cầu và hiện trạng khác
nhau, phân biệt rõ, không sửa sự thật để làm báo cáo đẹp.

Nếu không truy cập được mẫu, phiếu hoặc repository, báo chính xác đầu vào cần
cung cấp; không giả vờ đã đọc. Chỉ đọc repository để lấy thông tin, không sửa
code/cấu hình/DB, không chạy kiểm thử làm thu hồi phiên hoặc gửi Telegram, không
đọc/chép secret trong `keys/` hay env thật, không commit/push.

## 2. Phạm vi cần viết

“Phần 1 và 2” ở đây là CHƯƠNG 1 và CHƯƠNG 2, không phải hai mục đầu của Mở đầu.
Mẫu tham khảo có Chương 1 tổng quan, Chương 2 thiết kế, Chương 3 thử nghiệm.
Hãy giữ cách phân vai đó và hệ thống đánh số 1.x/1.x.x, 2.x/2.x.x.

Chỉ xuất nội dung hai chương và danh sách nguồn đã dùng cho chúng. Không soạn
bìa, lời cảm ơn, mở đầu, chương 3, slide, kết luận toàn đồ án hoặc các báo cáo
review. Không sao chép tác giả, giảng viên, năm, câu văn hoặc nội dung cấu hình
của mẫu. Tên đề tài chính thức lấy từ phiếu giao; ZT-ServerOps là tên dự án.

## 3. Bối cảnh phải thể hiện đúng

- Đây là đồ án cơ sở ngành: thiết kế vừa đủ, tài nguyên hạn chế, chạy/demo và
  giải thích được. Không nâng thành kiến trúc production hoặc thêm dịch vụ.
- Hệ thống có Gateway, Worker/Mini-Agent, Web Console, PostgreSQL và cảnh báo
  Telegram. Backend Node.js/Fastify/TypeScript, frontend React/TypeScript,
  PostgreSQL theo yêu cầu 3NF, triển khai Linux/Docker Compose. Code hiện dùng
  Fastify 5; phiếu không khóa major version. Agent dùng Go; phiếu không cố định
  ngôn ngữ Agent. Kiểm tra lại repository trước khi mô tả phiên bản.
- WireGuard tạo VPN M2M, yêu cầu mã hóa ChaCha20-Poly1305; Gateway có cổng UDP51820.
  Zero Inbound áp dụng cho kết
  nối từ Internet vào Worker; vẫn cho phép dịch vụ nội bộ cần thiết qua VPN.
  Đừng mô tả Zero Inbound thành đóng luôn SSH trong VPN hoặc đóng mọi cổng Gateway.
- Web demo hiện bind loopback; không mô tả là website đã public trên cloud.
  Supabase/Vercel/AWS mới được trao đổi, chưa là kiến trúc được triển khai.
- Web SSH đi từ trình duyệt qua WebSocket đến Gateway/Bastion rồi SSH/PTY tới
  Worker. ADMIN được mở SSH; VIEWER chỉ giám sát. Quyền ADMIN ứng dụng không
  đồng nghĩa tài khoản SSH root. Khóa Ed25519 có yêu cầu quyền file400.
- Telemetry gồm CPU, RAM, disk, network I/O, uptime; heartbeat theo phiếu3giây,
  phát hiện mất tín hiệu15–45giây. Mặc định code hiện là Stale15s/Offline30s,
  sweeper5s; CPU cao là một sự cố riêng. Network RX/TX hiện là byte tích lũy trên
  một giao diện, không được gắn nhãn byte/giây nếu chưa tính tốc độ.
- RAM khoảng10MB/Agent và cụm500MB–1GB là mục tiêu/yêu cầu tài nguyên, không phải
  kết quả đo đã đạt. Không tự dựng số liệu hoặc thêm cache để tăng RAM tiêu thụ.
- Linux/Docker có bằng chứng chạy thật, Telegram live đã từng được kiểm chứng.
  Native Windows, reboot guest và Zero Inbound từ máy ngoài độc lập chưa nghiệm
  thu. Phiếu yêu cầu VM + Docker nhưng không cố định hai VM hay bắt buộc Windows.
  Viết mô hình VM là thiết kế/kế hoạch khi chưa có bằng chứng hoàn thành.
- Đợt cải tổ code hiện mới có kế hoạch; không viết các file/module dự kiến như
  thể đã được triển khai. Audit không ghi nội dung từng lệnh SSH; mô tả đúng
  loại sự kiện và quyền đọc/ghi thực tế, không tuyên bố chống được quản trị DB.
- Phân tích các biện pháp tiếp cận Zero Trust có trong thiết kế; không khẳng
  định chỉ có VPN là đạt đầy đủ Zero Trust hoặc hệ thống an toàn tuyệt đối.

## 4. Bố cục cần triển khai

CHƯƠNG 1. TỔNG QUAN VÀ CƠ SỞ LÝ THUYẾT VỀ QUẢN TRỊ MÁY CHỦ AN TOÀN

1.1. Tổng quan về quản trị và giám sát máy chủ
     Khái niệm, nhiệm vụ, nhu cầu quản lý tập trung và vấn đề truy cập từ xa.
1.2. Cơ sở an ninh cho hệ thống
     Zero Trust, Zero Inbound, xác thực, RBAC và vai trò nhật ký hoạt động.
1.3. Giao thức và cơ chế sử dụng
     WireGuard/M2M; SSH, Ed25519, WebSocket/PTY; telemetry/heartbeat/trạng thái;
     cảnh báo CPU/offline qua Telegram. Giải thích nguyên lý và liên hệ đề tài.
1.4. Công nghệ và môi trường thực nghiệm
     Linux, VMware/VirtualBox, Docker Compose, Fastify/TypeScript, React,
     PostgreSQL/3NF và Go Agent; phân biệt vai trò máy ảo với container.
1.5. Kết luận chương 1
     Tóm lược nền tảng cần dùng và dẫn sang phân tích, thiết kế ở Chương 2.

CHƯƠNG 2. PHÂN TÍCH VÀ THIẾT KẾ HỆ THỐNG ZT-SERVEROPS

2.1. Phân tích yêu cầu bài toán
     2.1.1. Mục tiêu thiết kế.
     2.1.2. Điều kiện và ràng buộc thiết kế.
     2.1.3. Thông số kỹ thuật theo phiếu giao.
     2.1.4. Tiêu chí đánh giá và phương pháp kiểm chứng dự kiến.
     Dùng bảng yêu cầu/thông số/căn cứ/cách kiểm chứng; tách mục tiêu khỏi kết quả.
2.2. Thiết kế ý tưởng
     2.2.1. Đề xuất phương án kiến trúc và đường truy cập.
     2.2.2. Phân tích phương án và lý do lựa chọn.
     So sánh ngắn các cách giải quyết đúng bài toán, ví dụ SSH trực tiếp với
     truy cập qua Gateway/VPN. Nêu đánh đổi và chọn phương án code đang thực hiện;
     không bịa khảo sát doanh nghiệp, định lượng hiệu năng hoặc quyết định mới.
2.3. Thiết kế chi tiết
     2.3.1. Kiến trúc và mô hình mạng: thành phần, ranh giới tin cậy, IP/port,
            hướng kết nối, phân biệt demo Docker hiện tại với Worker VM dự kiến.
     2.3.2. Thiết kế thành phần và cấu hình: Gateway, Worker, WireGuard, SSH,
            reverse proxy, khóa, phân quyền và mạng Compose; không đưa secret.
     2.3.3. Thiết kế dịch vụ và luồng xử lý: đăng nhập/RBAC; nhận telemetry và
            cập nhật trạng thái; cấp vé/mở/đóng SSH và logout; incident/cảnh báo/
            recovery/Telegram; audit. Dùng luồng ngắn gắn với source thực tế.
     2.3.4. Thiết kế dữ liệu: bảng/quan hệ/PK/FK theo migrations, chỉ ra cách
            chuẩn hóa cần thiết và phần dữ liệu tính toán; không tự dựng schema.
     2.3.5. Thiết kế Web Console: màn hình, thông tin hiển thị, quyền thao tác,
            loading/empty/error/dữ liệu cũ; mô tả thiết kế, không viết hướng dẫn demo.
2.4. Kết luận chương 2
     Tóm tắt lựa chọn và thiết kế làm cơ sở cho chương thử nghiệm do phần khác
     phụ trách; không tự viết kết quả thử nghiệm hoặc khẳng định hoàn thành VM.

Có thể chia mục con ba cấp khi cần, giữ trục bố cục của mẫu và tránh mục quá nhỏ.
Nội dung EVE-NG, Cisco VLAN/VTP/OSPF/STP, Telnet, DHCP/DNS của mẫu không tự trở
thành nội dung đồ án này. Không bê các cấu hình đó sang báo cáo ZT-ServerOps.

## 5. Cách viết và đầu ra

Viết tiếng Việt học thuật vừa sức sinh viên, thuật ngữ nhất quán; giải thích từ
viết tắt ở lần đầu. Mỗi mục có diễn giải, nguyên lý/lựa chọn và liên hệ đề tài,
không chỉ liệt kê công nghệ. Giữ Chương 1 là cơ sở lý thuyết, Chương 2 là thiết
kế; tránh lặp cùng nội dung hoặc biến Chương 2 thành README cài đặt/nhật ký test.

Ưu tiên đoạn văn; bảng cho so sánh, thông số và phân quyền. Có sơ đồ kiến trúc,
luồng xử lý cần thiết và ERD theo schema thật ở dạng Mermaid, kèm chú thích
Hình 2.x/Bảng 2.x nhất quán để có thể chuyển sang Word. Chỉ trích cấu hình ngắn
có tác dụng giải thích thiết kế, không chép source hoặc hàng trang lệnh.

Lý thuyết cần trích dẫn nguồn chính thống đã thực sự đọc, đánh số [1], [2] và
đưa thông tin nguồn/URL ở cuối. Ưu tiên tài liệu chuẩn và tài liệu chính thức
của công nghệ. Không bịa tài liệu tham khảo, tác giả, ngày truy cập, hình ảnh,
số đo, thử nghiệm hoặc ảnh chụp thành công. Mẫu không được xem là nguồn đúng
cho mọi khái niệm. Nếu chưa có hướng dẫn định dạng đầy đủ của QĐ815, không tự
khẳng định cỡ chữ/lề/giãn dòng đã tuân thủ; xuất Markdown sạch để định dạng sau.

Tự đối chiếu dàn ý với mẫu, phiếu và source rồi viết đủ hai chương trong cùng
lượt, không dừng sau dàn ý để hỏi có tiếp tục. Không tự đặt chỉ tiêu số trang
hoặc kéo dài bằng lý thuyết không phục vụ đề tài. Chỗ thiếu thông tin thật ghi
`[CẦN BỔ SUNG: ...]` cụ thể; không lấp bằng giả định được trình bày như sự thật.

Đầu ra: bản thảo Markdown hoàn chỉnh gồm hai chương và nguồn đã dùng. Nếu có
quyền ghi workspace, lưu vào `docs/BAO_CAO_CHUONG_1_2.md`; không ghi đè tài liệu
người dùng có sẵn. Cuối câu trả lời ghi ngắn các điểm cần người viết xác nhận,
tách khỏi nội dung chương. Không tự tuyên bố đạt toàn bộ phiếu giao.
