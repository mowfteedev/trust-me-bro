-- ==============================================================================
-- BẢN MIGRATION 003: KHỞI TẠO TÀI KHOẢN VÀ THIẾT LẬP MẪU MẶC ĐỊNH (v3.1)
-- Dự án: ZT-ServerOps (do-an-co-so-nganh)
-- Phụ trách: database (chủ trì), security, tech-lead
-- ==============================================================================

-- 1. TẠO TÀI KHOẢN QUẢN TRỊ VIÊN (ADMIN)
-- Mật khẩu mặc định: SecureAdmin2026! (Băm qua Scrypt chuẩn NIST SP 800-132)
INSERT INTO users (username, password_hash, role, is_active)
VALUES (
    'admin',
    '7b8761930e6e9030a1678561f5a87cea:9e660af5f8655bc58af3b5b8cbfa5a4a933d63640cdf8413a2d79ba8566f535179a18ec548bf86064645f579b2ac0883dd119d9ef4cd40e27c24acf038829234',
    'ADMIN',
    TRUE
)
ON CONFLICT (username) DO NOTHING;

-- 2. TẠO TÀI KHOẢN GIÁM SÁT VIÊN (VIEWER)
-- Mật khẩu mặc định: SecureViewer2026!
INSERT INTO users (username, password_hash, role, is_active)
VALUES (
    'viewer',
    '99b3aba269d84d5f21bf59f235b7bd03:3978dc1577b5881b395900fcbfd080bc2c4978883b60eac17b2934a3a3147a006f3187c7485b63d30c7092faddf7de157bfff7b4ca4a763debff1b7d7218ecfd',
    'VIEWER',
    TRUE
)
ON CONFLICT (username) DO NOTHING;

-- 3. TẠO MÁY CHỦ CON MẶC ĐỊNH (node-worker-01)
-- Khớp với pre-shared token trong docker-compose: secret-token-worker-01
INSERT INTO nodes (name, ip_address, node_type, token_hash, token_prefix, status)
VALUES (
    'node-worker-01',
    '10.100.0.2',
    'DOCKER',
    '10a3ce77a769aabf8361db2ba4aab0af15bdb1352c84f66dea2280049de5cecc',
    'secret-t',
    'HEALTHY'
)
ON CONFLICT (name) DO NOTHING;
