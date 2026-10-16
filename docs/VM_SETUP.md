# Mô hình hai VM để kiểm chứng trước khi nộp

**CHƯA KIỂM CHỨNG trên hypervisor.** Máy làm việc có KVM kernel khả dụng nhưng
chưa có VirtualBox/VMware, chương trình chạy VM hoặc guest image. Cụm Docker đã chạy WireGuard/SSH thật, nhưng không thay
thế bằng chứng hai VM hoặc kiểm tra inbound từ Internet.

Mô hình giữ nguyên ứng dụng: VM Gateway chạy PostgreSQL, Fastify, React/Caddy và
WireGuard helper trong Compose; VM Worker chạy WireGuard, OpenSSH và Mini-Agent Go.
Gateway VPN là `10.100.0.1`, Worker VPN là `10.100.0.2`. Worker chủ động kết nối
UDP51820 tới địa chỉ Gateway mà nó truy cập được. Không dùng hai peer cùng khóa
hoặc cùng địa chỉ VPN đồng thời.

## Chuẩn bị thủ công

1. Tạo hai VM Linux. Gateway cần Docker Engine/Compose, Python3, OpenSSL và
   OpenSSH client; Worker cần OpenSSH server và wireguard-tools. Mini-Agent dùng
   binary Go được build trước cho Linux/kiến trúc CPU của Worker. Kernel
   cần hỗ trợ WireGuard. Cài theo hướng dẫn của bản Linux đang dùng; lệnh cài đặt
   package/hypervisor chưa được chạy trong phiên này.
2. Trên Gateway, dùng bootstrap của dự án để tạo env/khóa riêng và khởi động các
   service Gateway như kịch bản demo. Khi chuyển sang Worker VM, dừng container
   `node_worker_01` của demo để giải phóng peer `10.100.0.2`; giữ
   `wireguard_gateway` hoạt động. Không xóa volume hoặc dùng DB đang chứa dữ liệu
   quan trọng để thử cấu hình VM.
3. Chuyển cấu hình Worker và khóa qua kênh tin cậy. `keys/wg0-node.conf` được sinh
   cho Docker có Endpoint `gateway:51820`; trong bản sao trên Worker VM phải thay
   bằng IP/DNS thực của Gateway. Không sửa khóa peer hoặc AllowedIPs. Đặt bản sao
   cấu hình tại `/etc/wireguard/wg0.conf`, quyền 600, rồi bật bằng công cụ quản lý
   WireGuard của VM. `wg0` của Gateway nằm trong namespace container helper;
   không dựng thêm một interface Gateway cùng khóa trên host VM.
4. Trên Worker VM, tạo tài khoản SSH riêng có shell, cài public key Bastion vào
   authorized_keys của tài khoản đó. Dùng private SSH host key của Worker với
   quyền 400 và owner đúng tài khoản dịch vụ; public key cung cấp trực tiếp cho
   Gateway để ghim SHA256 fingerprint. Cấu hình sshd chỉ ListenAddress
   `10.100.0.2`, xác thực public key, tắt password/root login và forwarding như
   `deploy/demo/sshd_config`. Đặt `BASTION_DEFAULT_USER` tại Gateway theo tài khoản
   thực tế của VM; không tự đổi sang root.
5. Đăng ký node bằng CLI `gateway/dist/scripts/setup-demo.js` nhận JSON qua stdin:
   điền `node_name`, `node_ip=10.100.0.2`, `node_type=VM`, token ngẫu nhiên và
   fingerprint lấy từ public host key tin cậy, cùng mật khẩu tài khoản demo.
   Không đưa secrets vào argv/log. CLI giữ nguyên node/tài khoản có cấu hình khác;
   không ghi đè node Docker cũ. Dùng DB riêng cho mô hình VM để tránh trùng node/IP với demo Docker
   trước bước này. Không tự sửa DB đang dùng chỉ để đổi nhãn.
6. Chạy Mini-Agent trên Worker với NODE_ID đúng node_name, NODE_TOKEN khớp token
   đăng ký, GATEWAY_URL `http://10.100.0.1:3000`, BEACON_INTERVAL_SECONDS 3.0 và
   JITTER_RATIO 0.0. `agent/install.sh` có sẵn cho Linux/systemd, nhưng đường cài
   đặt lên VM **chưa được kiểm chứng** trong phiên này.
7. Dùng console của VM khi áp firewall thủ công. Worker cho phép loopback,
   established/related và SSH từ `10.100.0.1` qua wg0; chặn mọi kết nối mới vào từ
   NIC ngoài, gồm cả IPv6 nếu được bật. Giữ outbound UDP51820 tới Gateway để NAT
   hoạt động. Kiểm tra cả port forwarding của hypervisor/router: không chuyển
   tiếp bất kỳ cổng Worker nào. Không copy mù luật iptables của container lên host
   có dịch vụ khác; repository không tự áp firewall cho máy chủ.
8. Gateway chỉ cần UDP51820 từ phía ngoài. Proxy mặc định bind loopback; dùng
   trình duyệt trong Gateway VM hoặc một mạng quản trị riêng để xem console.
   Nếu đổi PROXY_BIND_IP sang NIC quản trị, phải xác nhận NIC này không nhận
   Internet ingress. Không mở PostgreSQL hoặc Fastify 3000 ra ngoài.

## Kiểm chứng và ghi bằng chứng

Các công cụ dưới đây đã chạy trong namespace container thật; khi kiểm tra Worker
VM, chạy bằng quyền phù hợp trong guest. Không có kết quả PASS trên VM sẵn có.

```sh
wg show wg0 latest-handshakes
wg show wg0 transfer
ss -lnt
iptables -S
```

Tại Gateway, interface thuộc helper nên dùng lệnh đã chạy trong cụm:

```sh
docker compose --env-file keys/demo.env -p zt_demo --profile demo exec -T wireguard_gateway wg show wg0 latest-handshakes
docker compose --env-file keys/demo.env -p zt_demo --profile demo exec -T wireguard_gateway wg show wg0 transfer
```

Kết quả mong đợi: handshake khác 0 và transfer tăng; SSH chỉ lắng nghe IP VPN;
Internet NIC không nhận kết nối mới; agent cập nhật Online mỗi 3 giây. Chụp cấu hình
NIC/port forwarding của hai VM, kết quả truy cập SSH qua Dashboard, audit và thử
kết nối SSH vào NIC ngoài từ máy độc lập. Dừng agent để kiểm tra Stale/Offline,
rồi bật lại. Từ Dashboard, Viewer phải bị từ chối mở SSH; Admin thao tác terminal
và logout phải đóng phiên.

Không xuất private keys, token, mật khẩu hoặc `wg showconf` vào báo cáo. Bổ sung
bằng chứng VM vào `docs/verification/` sau khi chạy; trước đó ghi rõ
**CHƯA KIỂM CHỨNG**. Đây là phần triển khai cần thực hiện trên môi trường VM được
chủ dự án chuẩn bị, không phải thông báo rằng yêu cầu VM đã hoàn thành.
