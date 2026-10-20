import fs from 'node:fs';
import { z } from 'zod';
import { getClient, closeDatabasePool } from '../services/db.js';
import { hashPassword, hashToken, verifyPassword } from '../utils/crypto.js';

// Nhận bí mật qua stdin, không đưa mật khẩu/token vào argv hoặc log.
const Input = z.object({
  admin_password: z.string().min(12),
  viewer_password: z.string().min(12),
  node_token: z.string().min(32),
  host_key_fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/),
  node_name: z.string().min(3).max(64).default('node-worker-01'),
  node_ip: z.string().ip({ version: 'v4' }).default('10.100.0.2'),
  node_type: z.enum(['DOCKER', 'VM', 'BARE_METAL']).default('DOCKER'),
}).strict();

async function setupDemo() {
  const input = Input.parse(JSON.parse(fs.readFileSync(0, 'utf8')));
  const client = await getClient();
  try {
    await client.query('BEGIN');
    for (const [username, role, password] of [
      ['demo-admin', 'ADMIN', input.admin_password],
      ['demo-viewer', 'VIEWER', input.viewer_password],
    ]) {
      const existing = await client.query('SELECT password_hash, role, is_active FROM users WHERE username = $1;', [username]);
      if (existing.rows.length) {
        const user = existing.rows[0];
        if (!verifyPassword(password, user.password_hash) || user.role !== role || !user.is_active) {
          throw new Error(`Tài khoản ${username} đã tồn tại với cấu hình khác; giữ nguyên, không ghi đè.`);
        }
      } else {
        await client.query(
          'INSERT INTO users (username, password_hash, role, is_active) VALUES ($1, $2, $3, TRUE);',
          [username, hashPassword(password), role],
        );
      }
    }
    const tokenHash = hashToken(input.node_token);
    const existingNode = await client.query('SELECT token_hash, is_token_revoked, ip_address, host_key_fingerprint, node_type FROM nodes WHERE name = $1;', [input.node_name]);
    if (existingNode.rows.length) {
      const node = existingNode.rows[0];
      if (node.token_hash !== tokenHash || node.is_token_revoked || node.ip_address !== input.node_ip || node.host_key_fingerprint !== input.host_key_fingerprint || node.node_type !== input.node_type) {
        throw new Error('Node đã tồn tại với token/IP/host key khác; giữ nguyên, không ghi đè.');
      }
    } else {
      await client.query(
        `INSERT INTO nodes (name, ip_address, node_type, token_hash, token_prefix, host_key_fingerprint)
         VALUES ($1, $2::inet, $3, $4, $5, $6);`,
        [input.node_name, input.node_ip, input.node_type, tokenHash, input.node_token.slice(0, 8), input.host_key_fingerprint],
      );
    }
    await client.query('COMMIT');
    console.log('Đã chuẩn bị demo-admin (ADMIN), demo-viewer (VIEWER) và node. Không ghi đè định danh có sẵn.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

setupDemo().catch((error: unknown) => {
  // Không in Zod input, chuỗi kết nối hoặc nội dung stdin chứa bí mật.
  console.error(error instanceof z.ZodError || error instanceof SyntaxError ? 'Dữ liệu setup-demo không hợp lệ.' : 'Setup demo thất bại; kiểm tra kết nối DB và định danh có sẵn. Không tự ghi đè dữ liệu.');
  process.exitCode = 1;
}).finally(closeDatabasePool);
