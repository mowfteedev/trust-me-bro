# Kết quả cải thiện — 16/11/2026

Phạm vi được duyệt: mục 1, 2, 4–10 trong đề xuất. Giữ kiến trúc và bốn dịch
vụ hiện có; không thay đường Cloudflare. Bản bàn giao nằm trên nhánh
`improve/system-renovation-20261116`, chưa triển khai lên EC2.

## Thay đổi

| Mục | Kết quả |
| --- | --- |
| Phiên bản | Giữ thay đổi cũ, thêm manifest commit/source SHA/migrations/image; có CI và hướng dẫn cập nhật. |
| Bảo mật | OTP/chat ID không vào log thường; Admin chủ động xem ghép bot, no-store; che lỗi readiness/500; CORS cùng origin; nguồn IP chỉ tin proxy đã cấu hình. |
| Backup | Dump nhất quán của DB, cấu hình/khóa riêng tư, checksum, quyền 0400/0600; chỉ khôi phục vào PostgreSQL mới cô lập, từ chối ghi đè. |
| Cảnh báo | CPU phục hồi; ý định gửi lưu cùng transaction; tối đa ba lần thử; tiếp tục claim hết hạn sau restart; tin phục hồi chờ tin mở sự cố xử lý xong. |
| Tài khoản | Admin tạo/khóa/đổi quyền/reset mật khẩu; người dùng đổi mật khẩu; logout hiện tại/tất cả; giữ Admin cuối cùng, chống tự khóa, audit cùng transaction. |
| Worker | Chuẩn hóa OS/type khi tạo bundle, Linux dùng mount Linux; kiểm cấu hình ngoại tuyến; sửa hướng dẫn Windows Service, VM/máy thật và quy trình thay/gỡ. |
| Nghiệm thu | Một runner cho source/unit/build và lab DB thật; phân biệt giả lập/runtime, có ma trận phiếu giao và CI. |
| Hiệu năng | Dừng polling khi tab ẩn; tiếp tục khi quay lại; chống chồng request; lịch sử 5 giây; bucket giới hạn theo JWT đã xác thực, login theo IP. |
| Dashboard | Trang Tài khoản/Sự cố; Viewer đọc sự cố và nhật ký; trạng thái gửi/phục hồi, phân trang, liên kết máy/audit; bố cục desktop/mobile. |

## Bằng chứng kiểm tra

- Gateway: 246 unit/integration-mock PASS; ba ca SSH transport riêng mặc định
  không chạy trong runner unit. Không dùng con số này thay bằng chứng SSH thật.
- Dashboard: 29 ca logic/API/polling PASS. Build Gateway và React PASS.
- Python: 52 source/config/safety tests và 42 native installer tests PASS.
- Agent: `go test ./...` PASS trên source hiện tại; Windows amd64 cross-build
  PASS. Cross-build không xác nhận Windows Service chạy được.
- PostgreSQL 16 thật: 10 ca tài khoản PASS, gồm hai phiên độc lập, hai Admin
  hạ quyền chéo và rollback khi audit lỗi. Runtime dùng `zt_app` không superuser.
- PostgreSQL 16 thật: 10 ca delivery PASS, gồm rollback, enqueue đồng thời,
  lease sau crash, giới hạn retry và thứ tự mở/phục hồi. Telegram dùng fetch
  giả lập, không gửi ra ngoài.
- Restore thật: khôi phục đủ 13 migrations cùng users/nodes/alerts/audit;
  dữ liệu cấu hình và quyền file giữ nguyên. **Chưa kiểm đăng nhập ứng dụng
  vào chính DB được restore**; đây là ca riêng trước cutover.
- Cụm Docker đóng gói: bốn core + Worker mới, WireGuard handshake/heartbeat,
  HTTPS/API và 17 ca thực thi PASS, gồm Web SSH/PTY Unicode và thu hồi phiên.
  Lab dọn toàn bộ container/network/volume của mình, giữ Worker hiện hữu.
- Firefox thật + API/DB lab: 11 kiểm tra desktop/390px PASS, gồm tạo tài
  khoản, Viewer, sự cố, lọc phục hồi và không tràn ngang. Dữ liệu là fixture
  lab, không phải số liệu production. Collector host không tham gia ca này.

Runner kiểm tra tổng hợp:

```sh
python3 deploy/scripts/acceptance.py --runtime-labs --output /tmp/zt-check-NEW
```

Log, ảnh, credentials fixture và backup chỉ giữ trong thư mục riêng tư ngoài
Git; repo chỉ chứa công cụ và mô tả kết quả. Kết quả CI trên GitHub cần xem
ở đúng commit sau khi push, không suy từ kết quả cục bộ.

## Số đo tài nguyên và giới hạn

Ba mẫu `docker stats` trong lab: tổng bốn core khoảng **77,5–80,7 MiB**;
Worker container **6,0–6,2 MiB**. Chưa gồm RAM OS, Docker/containerd, cache
host hoặc hypervisor; không coi là RSS Agent hay ngân sách toàn EC2/VM.
Chưa đo sức chứa nhiều người dùng thực tế trên EC2.

JWT mới có `jti`, logout thường chỉ thu hồi phiên đó và Web SSH liên quan.
JWT cũ không có `jti` vẫn logout toàn bộ theo hành vi cũ đến khi hết hạn.
Đổi mật khẩu, khóa hoặc đổi quyền thu hồi mọi phiên của tài khoản.

Telegram có thể nhận trùng khi đã tiếp nhận nhưng kết nối/tiến trình mất
trước lúc lưu kết quả. `SENT` chỉ xác nhận API Telegram nhận tin, không xác
nhận người dùng đã đọc. Không gửi bù các sự cố cũ thiếu lịch sử delivery.

VM Windows/Linux, reboot, firewall từ Internet, Telegram thật và đăng nhập
ứng dụng sau restore: **CHƯA KIỂM CHỨNG ở bản này**. Hướng dẫn và checklist
đã chuẩn bị; chỉ kiểm trên đúng môi trường được phép trước nghiệm thu.

## Cập nhật sau khi review

Đọc [OPERATIONS.md](OPERATIONS.md). Giữ backup ngoài máy, chạy migrator tới
013 và provisioner bằng image mới, rồi tạo lại Gateway cùng helper WireGuard.
Không chạy image cũ với schema chưa đối chiếu. Không xóa volume, đổi danh tính
Worker hoặc triển khai EC2 chỉ vì checkout nhánh này.
