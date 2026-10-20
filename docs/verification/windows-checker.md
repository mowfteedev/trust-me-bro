# Kiểm tra firewall Windows — 20/10/2026

`check-worker.ps1` phân loại rule bằng protocol, port, địa chỉ, interface,
application/service, package và edge traversal. Tên/DisplayGroup không quyết
định kết quả. Filter thiếu hoặc không nhận diện được vẫn tạo issue và exit1.
Chỉ áp dụng trên VM lab chuyên dụng, không chứng nhận Zero Inbound Internet.

- DHCP client: chỉ UDP68←67 hoặc546←547, svchost và serviceDhcp.
- ICMP: chỉ lỗi mạng/PMTU và điều khiển IPv6 có type/phạm vi cụ thể.
  NS/NA giữ nguồnAny để bảo toàn địa chỉ on-link và DAD nguồn`::`; giao thức
  yêu cầu hoplimit255. [RFC4861, mục7.1](https://www.rfc-editor.org/rfc/rfc4861.html#section-7.1).
- Rule TCP/UDP ứng dụng hoặc tunnel khác vẫn phải được xem xét.

Trên VM thật, đã lưu cấu hình trước thay đổi rồi tắt đúng năm rule không dùng:
`CoreNet-IPv6-In`, `CoreNet-Teredo-In`, `CoreNet-IPHTTPS-In`, `CoreNet-IGMP-In`,
`CoreNet-ICMP6-RS-In`. Hai rule NS/NA chuyển EdgeTraversalPolicy sangBlock.
Không tắt DHCP hoặc IPv6 neighbor discovery. Đây là cấu hình lab đã rà soát,
không phải danh sách tự động áp cho mọi Windows Server.

| Kiểm tra | Kết quả | Phạm vi |
|---|---|---|
| `test-firewall-policy.ps1` | 30ca đạt trên PowerShell7.4 container và5.1.20348.558 Windows | Filter tổng hợp: giả tênCoreNet, đổi program/service/port/scope, thiếu filter |
| Parser của4script được triển khai | 0lỗi trên PowerShell5.1 thật | Checker, helper policy, common và test |
| Checker trên ActiveStore thật | exit0,14rule điều khiển,0rule cần xem xét,0issue | Dịch vụ, SSH config, listener, firewall và đường Gateway |
| Thêm rule TCP thật tên`CoreNet-ZT-Regression-In` | exit1 và liệt kê đúng rule | TCP18746, transportEthernet, chỉ nguồn host192.168.122.1 |
| Gỡ rule thử trongfinally, chạy lại | exit0 | Không sửa kỳ vọng để bỏ qua rule lạ |
| Sau reboot | exit0; WG/sshd/Agent đềuRunning | Binary Agent giữ SHA256 trước reboot |

Lệnh chạy từ thư mục chứa đầy đủ `deploy/windows/*.ps1`, trong PowerShellAdmin:

```powershell
.\test-firewall-policy.ps1
.\check-worker.ps1
```

WinRM tạm được giới hạn nguồn host, sau đó tắt rule trước khi chạy checker.
Lệnh WinRM chủ động đóng đường kết nối nên phía điều khiển bị timeout; không
tính timeout thànhPASS. Kết quả local được đọc lại qua SSH VPN, sau reboot cũng
kiểm tra lại. Checker vẫn chỉ kiểm tra local; cần phép thử mạng độc lập riêng.
Raw JSON và cấu hình backup ở cache được trỏ bởi `keys/close-gaps-path`.
