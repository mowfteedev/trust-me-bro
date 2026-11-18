# Vận hành và khôi phục

## Xác định bản bàn giao

Chạy từ repo đã review/commit. Manifest chứa SHA256 source/migration và image
ID; không chứa `.env`, khóa hoặc cấu hình container. Một tag image có thể
thay đổi; khi đối chiếu dùng ID/digest trong manifest, không chỉ tên tag.

```sh
python3 deploy/scripts/release_manifest.py --require-clean \
  --image zt-serverops-gateway:RELEASE_TAG \
  --image zt-serverops-proxy:RELEASE_TAG \
  --image zt-serverops-wireguard:RELEASE_TAG \
  --image postgres:16-alpine --output /tmp/zt-release.json
```

`--require-clean` từ chối source chưa commit. Khi khảo sát có thể bỏ cờ này;
manifest ghi `dirty: true`, không coi commit đơn lẻ là toàn bộ bản đang chạy.
Runtime cần build từ source tương ứng; manifest tự nó không chứng minh image
đã được build từ commit ấy. Không hot-copy `dist` vào container để tạo bản
bàn giao không tái dựng được.

## Sao lưu Compose

Thực hiện trên Gateway trong repo đúng phiên bản. `keys/` phải chứa env được
chọn, khóa WireGuard/Bastion, bundle và cấu hình riêng cần giữ. Mã nguồn,
Compose/Caddy và systemd theo Git; mọi cấu hình sửa ngoài Git phải có bản riêng
trong vùng sao lưu hoặc ghi nhận đường khôi phục. Bộ cài native dùng quy trình
riêng trong `deploy/RECOVERY.md`.

Tạo thư mục cha trên ổ riêng, quyền `0700`. Không đặt backup trong repo.
Ví dụ dưới đây dùng `/media/private/zt-backups`; thay bằng ổ đã có thật:

```sh
python3 deploy/scripts/recovery.py backup --project zt_ec2 \
  --env-file keys/ec2.env --config-dir keys \
  --output /media/private/zt-backups/before-upgrade-20261116
python3 deploy/scripts/recovery.py verify \
  --backup /media/private/zt-backups/before-upgrade-20261116
```

`pg_dump` lấy snapshot DB nhất quán; không dừng Gateway hoặc xóa volume.
Backup có `database.dump`, `config.tar`, `manifest.json` với checksum. Thư mục
`0700`, archive/manifest `0600`; cấu hình khôi phục `0600` hoặc giữ `0400`
nếu nguồn là tệp chỉ đọc; từ chối symlink/ghi đè. Lệnh chỉ in kết quả an toàn, không
in cấu hình hay output lỗi PostgreSQL. **Archive chứa bí mật dạng đọc được**,
quyền file không thay thế mã hóa ổ đĩa; sao chép sang nơi bảo vệ ngoài EC2 và
kiểm checksum sau chép. Không đưa vào Git/artifact CI/chia sẻ công khai.

DB và cấu hình là hai lượt đọc, không phải snapshot nguyên tử chung: tránh
đăng ký/đổi khóa, thu hồi Worker hoặc cập nhật cấu hình trong lúc sao lưu. Xem hướng
dẫn thu hồi và gỡ máy an toàn tại [deploy/automation/README.md](file:///home/mowftee/Projects/trust-me-bro/deploy/automation/README.md). Không cam kết RPO
nếu chưa có lịch sao lưu và kiểm bản sao ngoài máy.

## Diễn tập khôi phục, không ghi vào DB đang chạy

```sh
python3 deploy/scripts/recovery.py restore \
  --backup /media/private/zt-backups/before-upgrade-20261116 \
  --output-config /media/private/zt-backups/restored-check-20261116
```

Công cụ tạo PostgreSQL **mới**, network `none`, không publish port; xác minh
restore thành công và đếm các bảng users/nodes/alerts/audit/schema migrations.
Container kiểm tra được xóa cùng volume sau khi xong. Config được phục hồi
vào thư mục mới `0700`, không ghi đè thư mục đang dùng. `RESTORE-RESULT.json`
ghi loại bằng chứng; kiểm DB không đồng nghĩa đã đăng nhập Dashboard/Web SSH.

Tùy chọn `--container zt_recovery_demo --keep-container` giữ DB lab để xem
thêm. Tên bắt buộc có prefix `zt_recovery_`, container tồn tại bị từ chối.
PG tạm dùng trust chỉ trong namespace cô lập; không expose/network-connect
container này. Đóng nó bằng `docker rm -fv zt_recovery_demo` sau khi kiểm.

## Khôi phục dịch vụ sau mất máy

1. Chuẩn bị máy mới, checkout đúng commit và kiểm image ID/migration manifest.
   Giữ Gateway cũ tắt trong bước chuyển danh tính; không chạy hai Gateway với
   cùng khóa/IP một cách tùy tiện.
2. Chép backup riêng tư, chạy `verify` rồi diễn tập `restore` ở trên; đối chiếu
   số bảng, danh tính node và cấu hình cần thiết. Không đưa secrets vào log.
3. Khôi phục keys/env vào vị trí mới, giữ mode `0700/0600` và Bastion private
   key `0400` với đúng owner mà Gateway đọc được. Chọn Compose project và volume
   mới; không `down -v` dự án đang dùng.
4. Với cutover thật, tạo DB mới của Compose rồi dùng `pg_restore --exit-on-error`
   từ dump đã kiểm; phải có các role `zt_admin`, `zt_app`, `zt_maintenance` trước
   khi restore ACL. Dùng DB owner; không chạy restore bằng role ứng dụng.
   Công cụ diễn tập cố ý không cung cấp lệnh ghi đè DB có sẵn.
5. Chạy provisioner bình thường để cấp lại mật khẩu role từ env riêng; role
   app/maintenance của diễn tập là `NOLOGIN`, không có mật khẩu trong dump role.
   Chạy migrator đúng image nếu có migration mới, rồi Gateway **và WireGuard
   helper cùng nhau** để namespace khớp; Caddy/Postgres giữ đúng cấu hình.
6. Kiểm health, pin/handshake, đăng nhập mới, Admin/Viewer, Web SSH, telemetry
   và kiểm service tự chạy. JWT/phiên cũ trong snapshot có thể cần thu hồi;
   quyết định rõ trước khi mở truy cập. Chuyển endpoint/DNS chỉ theo phạm vi
   được duyệt; không tự đổi Cloudflare trong đợt cải thiện này.
7. Ghi kết quả, giữ backup trước cutover. Nếu lỗi, dừng bản mới và quay lại
   image/config/DB cũ đã bảo toàn; không trộn schema mới với image cũ.

Bước cutover cần thực hiện và kiểm riêng trên máy mới; diễn tập DB không tự
xác nhận toàn bộ hệ thống đã khôi phục.
