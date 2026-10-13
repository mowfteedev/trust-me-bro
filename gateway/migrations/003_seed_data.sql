-- ==============================================================================
-- BẢN MIGRATION 003: KHỞI TẠO TÀI KHOẢN VÀ THIẾT LẬP MẪU MẶC ĐỊNH (v3.2)
-- Dự án: ZT-ServerOps (do-an-co-so-nganh)
-- Phụ trách: database (chủ trì), security, tech-lead
-- ==============================================================================
--
-- CHÚ THÍCH BẢO MẬT (CWE-798 PREVENTION):
-- Để triệt tiêu hoàn toàn lỗ hổng thông tin xác thực mặc định (Default Credentials),
-- bản migration này KHÔNG TỰ ĐỘNG chèn tài khoản admin/viewer hay node token mẫu.
-- Việc khởi tạo tài khoản quản trị viên ban đầu được thực hiện an toàn thông qua:
-- 1. Kịch bản độc lập: `npm run bootstrap:admin` (gateway/src/scripts/bootstrap-admin.ts)
-- 2. Hoặc cấu hình biến môi trường an toàn lúc triển khai.
-- ==============================================================================

SELECT 1;

