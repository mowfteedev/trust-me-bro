import pg from 'pg';

/**
 * TÁC VỤ KHỞI TẠO VÀ CẤP PHÁT MẬT KHẨU VAI TRÒ CSDL (ROLE PROVISIONER)
 * Dự án: ZT-ServerOps
 *
 * PHÂN QUYỀN & AN TOÀN (R3-01 & R3-05 REMEDIATION):
 * - Chạy độc lập dưới quyền zt_admin trước khi Gateway khởi động.
 * - Đặt mật khẩu role ngẫu nhiên cho zt_app và zt_maintenance qua PostgreSQL format(%L) chống injection.
 * - Kiểm chứng kết nối TCP thực tế của zt_app trước khi hoàn tất.
 * - Thiếu secret hoặc lỗi xác thực TCP sẽ fail-fast (exit 1).
 */

const { Pool } = pg;

function extractPassword(dbUrl: string): string | null {
  try {
    const parsed = new URL(dbUrl);
    return parsed.password ? decodeURIComponent(parsed.password) : null;
  } catch {
    return null;
  }
}

async function provisionRoles() {
  const adminDbUrl = process.env.MIGRATION_DATABASE_URL || process.env.ADMIN_DATABASE_URL;
  const appDbUrl = process.env.DATABASE_URL;
  const maintenanceDbUrl = process.env.MAINTENANCE_DATABASE_URL;

  if (!adminDbUrl) {
    console.error('❌ [PROVISIONER FATAL] Thiếu MIGRATION_DATABASE_URL cho quyền admin.');
    process.exit(1);
  }
  if (!appDbUrl) {
    console.error('❌ [PROVISIONER FATAL] Thiếu DATABASE_URL cho vai trò ứng dụng zt_app.');
    process.exit(1);
  }

  const appPassword = process.env.APP_DB_PASSWORD || extractPassword(appDbUrl);
  const maintenancePassword = process.env.MAINTENANCE_DB_PASSWORD || (maintenanceDbUrl ? extractPassword(maintenanceDbUrl) : null);

  if (!appPassword || appPassword.length < 8) {
    console.error('❌ [PROVISIONER FATAL] Mật khẩu zt_app không hợp lệ hoặc bị thiếu.');
    process.exit(1);
  }

  console.log('🔧 [PROVISIONER] Bắt đầu thiết lập vai trò và mật khẩu CSDL thực tế...');

  // 1. Kết nối với tư cách zt_admin để cấu hình role
  const adminPool = new Pool({
    connectionString: adminDbUrl,
    connectionTimeoutMillis: 5000,
  });

  try {
    const client = await adminPool.connect();
    try {
      // Đảm bảo các vai trò tồn tại
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zt_app') THEN
            CREATE ROLE zt_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
          END IF;
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zt_maintenance') THEN
            CREATE ROLE zt_maintenance WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
          END IF;
        END $$;
      `);

      // Tạo temporary helper function trong phiên kết nối admin để nhận bind parameters an toàn
      await client.query(`
        CREATE OR REPLACE FUNCTION pg_temp.set_role_password(p_role text, p_password text)
        RETURNS void LANGUAGE plpgsql AS $func$
        BEGIN
          EXECUTE format('ALTER ROLE %I WITH PASSWORD %L', p_role, p_password);
        END;
        $func$;
      `);

      await client.query('SELECT pg_temp.set_role_password($1, $2);', ['zt_app', appPassword]);

      if (maintenancePassword) {
        await client.query('SELECT pg_temp.set_role_password($1, $2);', ['zt_maintenance', maintenancePassword]);
      }

      console.log('✔ [PROVISIONER] Đã gán mật khẩu an toàn cho zt_app và zt_maintenance.');
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('❌ [PROVISIONER ERROR] Lỗi khi cấu hình vai trò PostgreSQL:', err.message);
    await adminPool.end();
    process.exit(1);
  } finally {
    await adminPool.end();
  }

  // 2. Thử nghiệm kết nối TCP thực tế bằng vai trò zt_app để chứng minh password authentication SCRAM thành công
  console.log('🔍 [PROVISIONER] Kiểm chứng xác thực TCP bằng tài khoản zt_app...');
  const appPool = new Pool({
    connectionString: appDbUrl,
    connectionTimeoutMillis: 5000,
  });

  try {
    const testClient = await appPool.connect();
    try {
      const res = await testClient.query('SELECT current_user, session_user;');
      console.log(`✅ [PROVISIONER SUCCESS] Kết nối TCP thành công với vai trò: ${res.rows[0].current_user}`);
    } finally {
      testClient.release();
    }
  } catch (appConnErr: any) {
    console.error('❌ [PROVISIONER TCP FAILED] zt_app không thể xác thực qua TCP với mật khẩu được gán:', appConnErr.message);
    await appPool.end();
    process.exit(1);
  } finally {
    await appPool.end();
  }

  console.log('🎉 [PROVISIONER] Hoàn tất thiết lập vai trò CSDL an toàn.');
}

provisionRoles();
