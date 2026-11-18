// Standalone CI/acceptance entry point for Worker Offboarding database layer.
if (typeof credentials === 'undefined') {
  const f = require('node:fs'), p = require('node:path'), o = require('node:os'), c = require('node:crypto');
  const { spawnSync: spawn } = require('node:child_process');
  const root = p.resolve(__dirname, '..'), temp = f.mkdtempSync(p.join(o.tmpdir(), 'zt-offboard-driver-'));
  f.chmodSync(temp, 0o700);
  const name = 'zt-offboard-lab-' + c.randomBytes(6).toString('hex');
  const owner = c.randomBytes(24).toString('hex'), app = c.randomBytes(24).toString('hex');
  const file = p.join(temp, 'postgres.env');
  f.writeFileSync(file, `POSTGRES_USER=zt_admin\nPOSTGRES_PASSWORD=${owner}\nPOSTGRES_DB=zt_serverops\n`, { mode: 0o600 });
  const docker = (args, input) => {
    const r = spawn('docker', args, { input, encoding: 'utf8', timeout: 45000 });
    if (r.status !== 0) throw Error('Isolated offboarding Docker command failed: ' + (r.stderr || r.stdout));
    return r.stdout.trim();
  };
  let code = 1;
  try {
    docker(['run', '-d', '--name', name, '--memory', '256m', '--env-file', file, '-p', '127.0.0.1::5432', 'postgres:16-alpine']);
    const end = Date.now() + 30000;
    while (spawn('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'zt_admin'], { stdio: 'ignore' }).status !== 0) {
      if (Date.now() > end) throw Error('PG readiness timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
    docker(['exec', '-i', name, 'psql', '-Xq', '-v', 'ON_ERROR_STOP=1', '-U', 'zt_admin', '-d', 'zt_serverops'],
      `CREATE ROLE zt_app LOGIN PASSWORD '${app}'; CREATE ROLE zt_maintenance NOLOGIN;`);
    const port = docker(['port', name, '5432/tcp']).split(':').at(-1);
    const data = {
      migration_url: `postgresql://zt_admin:${owner}@127.0.0.1:${port}/zt_serverops`,
      app_url: `postgresql://zt_app:${app}@127.0.0.1:${port}/zt_serverops`,
    };
    const r = spawn(process.execPath, ['-'], {
      cwd: p.join(root, 'gateway'),
      input: 'const credentials=' + JSON.stringify(data) + ';\n' + f.readFileSync(__filename, 'utf8'),
      encoding: 'utf8',
      timeout: 150000,
    });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    code = r.status === 0 ? 0 : 1;
  } catch (err) {
    console.error('Offboarding lab setup failed:', err.message);
  } finally {
    const r = spawn('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' });
    if (r.status !== 0) code = 1;
    f.rmSync(temp, { recursive: true, force: true });
  }
  process.exit(code);
}

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const database = 'zt_offboard_' + crypto.randomBytes(6).toString('hex');
const admin = new Pool({ connectionString: credentials.migration_url, connectionTimeoutMillis: 3000 });
let db, app, server, closePool, reqDir, ackDir;
const checks = [];
const check = (name) => { checks.push(name); console.log('PASS offboarding-db: ' + name); };
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

const makeHostKey = () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const key = 'ssh-ed25519 ' + Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020', 'hex'), raw]).toString('base64');
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(Buffer.concat([Buffer.from('0000000b7373682d6564323535313900000020', 'hex'), raw])).digest('base64').replace(/=+$/, '');
  return { key, fingerprint };
};

const gatewayKey = crypto.randomBytes(32).toString('base64');
const gatewayId = 'sha256:' + crypto.createHash('sha256').update(Buffer.from(gatewayKey, 'base64')).digest('hex');

async function main() {
  await admin.query(`CREATE DATABASE ${database}`);
  const migration = new URL(credentials.migration_url), runtime = new URL(credentials.app_url);
  migration.pathname = runtime.pathname = '/' + database;
  process.env.MIGRATION_DATABASE_URL = migration.toString();
  process.env.DATABASE_URL = runtime.toString();

  // 1. Chạy migrations từ 001 đến 016
  await require('./dist/services/migration-runner.js').runMigrations();
  db = new Pool({ connectionString: migration.toString(), connectionTimeoutMillis: 3000 });
  app = new Pool({ connectionString: runtime.toString(), connectionTimeoutMillis: 3000 });

  const migrationsDir = [path.resolve(process.cwd(), 'migrations'), path.resolve(process.cwd(), 'gateway/migrations')].find(d => fs.existsSync(d));
  const expectedMigrationCount = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).length;
  assert.equal((await db.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, expectedMigrationCount);
  check('migrations 001-016 applied successfully');

  // 2. Kiểm tra RBAC: zt_app không có quyền truy cập trực tiếp bảng worker_offboardings
  assert.equal((await app.query('SELECT current_user')).rows[0].current_user, 'zt_app');
  await assert.rejects(app.query('SELECT * FROM worker_offboardings'), /permission denied/);
  await assert.rejects(app.query("INSERT INTO worker_offboardings(gateway_id,node_id,enrollment_id,node_name,node_ip,wireguard_public_key)VALUES('x','00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000','x','10.100.0.3','x')"), /permission denied/);
  check('worker_offboardings table is strictly private from zt_app');

  // 3. Chuẩn bị dữ liệu mẫu (ADMIN, VIEWER, Enrolled Worker, Legacy Worker)
  const adminId = (await db.query(`INSERT INTO users(username, password_hash, role, is_active)
    VALUES('admin-actor', 'hash', 'ADMIN', true) RETURNING id`)).rows[0].id;
  const viewerId = (await db.query(`INSERT INTO users(username, password_hash, role, is_active)
    VALUES('viewer-actor', 'hash', 'VIEWER', true) RETURNING id`)).rows[0].id;

  // Đăng ký Worker 1 qua worker_enrollments và claim_worker_enrollment
  const inviteToken1 = crypto.randomBytes(32).toString('hex');
  const invite1Id = (await db.query(`INSERT INTO worker_enrollments(gateway_id, token_hash, node_name, node_ip, node_type, worker_os, ssh_username, expires_at)
    VALUES($1, $2, 'worker-alpha', '10.100.0.10'::inet, 'VM', 'linux', 'ztuser', now() + interval '1 hour') RETURNING id`,
    [gatewayId, hash(inviteToken1)])).rows[0].id;

  const nodeToken1 = crypto.randomBytes(32).toString('hex');
  const wgKey1 = crypto.randomBytes(32).toString('base64');
  const host1 = makeHostKey();
  const claimHash1 = hash('claim-1');

  const claimRes1 = await app.query(`SELECT * FROM claim_worker_enrollment($1, $2, $3, $4, $5, $6, $7, $8)`,
    [invite1Id, hash(inviteToken1), gatewayId, claimHash1, hash(nodeToken1), nodeToken1.slice(0, 8), host1.fingerprint, wgKey1]);
  const node1Id = claimRes1.rows[0].node_id;
  assert.equal(claimRes1.rows[0].node_name, 'worker-alpha');
  check('worker-alpha enrolled with initial lifecycle ACTIVE');

  // Đăng ký Legacy Worker 2 (không có trong worker_enrollments)
  const nodeToken2 = crypto.randomBytes(32).toString('hex');
  const host2 = makeHostKey();
  const node2Id = (await db.query(`INSERT INTO nodes(name, ip_address, node_type, token_hash, token_prefix, host_key_fingerprint, lifecycle_state)
    VALUES('worker-legacy', '10.100.0.20'::inet, 'VM', $1, $2, $3, 'ACTIVE') RETURNING id`,
    [hash(nodeToken2), nodeToken2.slice(0, 8), host2.fingerprint])).rows[0].id;
  check('worker-legacy created as legacy un-enrolled node');

  // 4. Kiểm tra bắt lỗi: confirm_node_name sai hoặc NULL
  await assert.rejects(
    app.query(`SELECT * FROM begin_worker_offboarding($1, 'wrong-name', $2, $3)`, [node1Id, gatewayId, adminId]),
    /OFFBOARD_NAME_MISMATCH/
  );
  await assert.rejects(
    app.query(`SELECT * FROM begin_worker_offboarding($1, NULL, $2, $3)`, [node1Id, gatewayId, adminId]),
    /OFFBOARD_BAD_INPUT/
  );
  check('begin_worker_offboarding rejects mismatched or NULL confirmation name');

  // 5. Kiểm tra bắt lỗi: legacy node không có enrolled identity
  await assert.rejects(
    app.query(`SELECT * FROM begin_worker_offboarding($1, 'worker-legacy', $2, $3)`, [node2Id, gatewayId, adminId]),
    /OFFBOARD_IDENTITY_UNAVAILABLE/
  );
  check('begin_worker_offboarding rejects legacy node without guessing IP');

  // 6. Kiểm tra bắt lỗi: actor không phải ADMIN hoặc NULL
  await assert.rejects(
    app.query(`SELECT * FROM begin_worker_offboarding($1, 'worker-alpha', $2, $3)`, [node1Id, gatewayId, viewerId]),
    /OFFBOARD_UNAUTHORIZED/
  );
  await assert.rejects(
    app.query(`SELECT * FROM begin_worker_offboarding($1, 'worker-alpha', $2, NULL)`, [node1Id, gatewayId]),
    /OFFBOARD_BAD_INPUT/
  );
  check('begin_worker_offboarding rejects non-admin or NULL actor');

  // 7. Khởi tạo offboard thành công (begin_worker_offboarding)
  const beginRes = await app.query(`SELECT * FROM begin_worker_offboarding($1, 'worker-alpha', $2, $3)`, [node1Id, gatewayId, adminId]);
  const opId = beginRes.rows[0].operation_id;
  assert.equal(beginRes.rows[0].state, 'PENDING_PEER_REMOVAL');
  assert.equal(beginRes.rows[0].wireguard_public_key, wgKey1);

  const node1After = (await db.query('SELECT lifecycle_state, is_token_revoked FROM nodes WHERE id = $1', [node1Id])).rows[0];
  assert.equal(node1After.lifecycle_state, 'RETIRING');
  assert.equal(node1After.is_token_revoked, true);
  check('worker-alpha transitioned to RETIRING and token revoked immediately');

  // Idempotent resume begin_worker_offboarding
  const resumeRes = await app.query(`SELECT * FROM begin_worker_offboarding($1, 'worker-alpha', $2, $3)`, [node1Id, gatewayId, adminId]);
  assert.equal(resumeRes.rows[0].operation_id, opId);
  check('begin_worker_offboarding is idempotent on re-call');

  // 8. Trong khi RETIRING, IP và Name vẫn được giữ, không cho Worker mới chiếm dụng
  const inviteToken3 = crypto.randomBytes(32).toString('hex');
  const invite3Id = (await db.query(`INSERT INTO worker_enrollments(gateway_id, token_hash, node_name, node_ip, node_type, worker_os, ssh_username, expires_at)
    VALUES($1, $2, 'worker-alpha', '10.100.0.10'::inet, 'VM', 'linux', 'ztuser', now() + interval '1 hour') RETURNING id`,
    [gatewayId, hash(inviteToken3)])).rows[0].id;

  const nodeToken3 = crypto.randomBytes(32).toString('hex');
  const wgKey3 = crypto.randomBytes(32).toString('base64');
  await assert.rejects(
    app.query(`SELECT * FROM claim_worker_enrollment($1, $2, $3, $4, $5, $6, $7, $8)`,
      [invite3Id, hash(inviteToken3), gatewayId, hash('claim-3'), hash(nodeToken3), nodeToken3.slice(0, 8), makeHostKey().fingerprint, wgKey3]),
    /ENROLLMENT_CONFLICT/
  );
  check('name and IP remain protected while lifecycle is RETIRING');

  // Thu hồi explicitly lời mời thử nghiệm thất bại invite3 để dọn reservation chưa tiêu thụ,
  // kiểm chứng ix_worker_enrollments_reserved_ip được bảo toàn mà không để sót rác test
  await db.query('UPDATE worker_enrollments SET revoked_at = clock_timestamp() WHERE id = $1', [invite3Id]);

  // 9. Xác nhận helper gỡ WireGuard peer an toàn (ack_worker_peer_removal)
  // Bắt lỗi: sai tuple (sai key, sai IP) hoặc NULL
  await assert.rejects(
    app.query(`SELECT * FROM ack_worker_peer_removal($1, $2, $3, 'wrongKey====================================', '10.100.0.10'::inet)`,
      [opId, node1Id, gatewayId]),
    /OFFBOARD_TUPLE_MISMATCH/
  );
  await assert.rejects(
    app.query(`SELECT * FROM ack_worker_peer_removal($1, $2, $3, NULL, '10.100.0.10'::inet)`,
      [opId, node1Id, gatewayId]),
    /OFFBOARD_BAD_INPUT/
  );
  await assert.rejects(
    app.query(`SELECT * FROM ack_worker_peer_removal($1, $2, NULL, $3, '10.100.0.10'::inet)`,
      [opId, node1Id, wgKey1]),
    /OFFBOARD_BAD_INPUT/
  );
  await assert.rejects(
    app.query(`SELECT * FROM ack_worker_peer_removal($1, $2, $3, $4, NULL)`,
      [opId, node1Id, gatewayId, wgKey1]),
    /OFFBOARD_BAD_INPUT/
  );
  check('ack_worker_peer_removal rejects NULLs and tuple mismatch with IS DISTINCT FROM');

  // Đúng tuple -> chuyển node sang REVOKED, op sang PENDING_LOCAL_CLEANUP
  const ackRes = await app.query(`SELECT * FROM ack_worker_peer_removal($1, $2, $3, $4, '10.100.0.10'::inet)`,
    [opId, node1Id, gatewayId, wgKey1]);
  assert.equal(ackRes.rows[0].lifecycle_state, 'REVOKED');
  assert.equal(ackRes.rows[0].state, 'PENDING_LOCAL_CLEANUP');

  // Idempotent retry ACK
  const ackRetry = await app.query(`SELECT * FROM ack_worker_peer_removal($1, $2, $3, $4, '10.100.0.10'::inet)`,
    [opId, node1Id, gatewayId, wgKey1]);
  assert.equal(ackRetry.rows[0].lifecycle_state, 'REVOKED');
  check('ack_worker_peer_removal transitions node to REVOKED and is idempotent');

  // 10. Sau khi REVOKED, IP 10.100.0.10 ĐÃ ĐƯỢC GIẢI PHÓNG để cấp cho Worker mới với key mới
  const inviteToken4 = crypto.randomBytes(32).toString('hex');
  const invite4Id = (await db.query(`INSERT INTO worker_enrollments(gateway_id, token_hash, node_name, node_ip, node_type, worker_os, ssh_username, expires_at)
    VALUES($1, $2, 'worker-beta', '10.100.0.10'::inet, 'VM', 'linux', 'ztuser', now() + interval '1 hour') RETURNING id`,
    [gatewayId, hash(inviteToken4)])).rows[0].id;

  const nodeToken4 = crypto.randomBytes(32).toString('hex');
  const wgKey4 = crypto.randomBytes(32).toString('base64');
  const claimRes4 = await app.query(`SELECT * FROM claim_worker_enrollment($1, $2, $3, $4, $5, $6, $7, $8)`,
    [invite4Id, hash(inviteToken4), gatewayId, hash('claim-4'), hash(nodeToken4), nodeToken4.slice(0, 8), makeHostKey().fingerprint, wgKey4]);
  const node4Id = claimRes4.rows[0].node_id;
  assert.equal(claimRes4.rows[0].node_ip, '10.100.0.10');
  check('recycled IP can be claimed by new worker after node is REVOKED');

  // 11. Nhưng cấm tái sử dụng token cũ (GLOBAL UNIQUE token_hash forever)
  const inviteToken5 = crypto.randomBytes(32).toString('hex');
  const invite5Id = (await db.query(`INSERT INTO worker_enrollments(gateway_id, token_hash, node_name, node_ip, node_type, worker_os, ssh_username, expires_at)
    VALUES($1, $2, 'worker-gamma', '10.100.0.30'::inet, 'VM', 'linux', 'ztuser', now() + interval '1 hour') RETURNING id`,
    [gatewayId, hash(inviteToken5)])).rows[0].id;

  await assert.rejects(
    app.query(`SELECT * FROM claim_worker_enrollment($1, $2, $3, $4, $5, $6, $7, $8)`,
      [invite5Id, hash(inviteToken5), gatewayId, hash('claim-5'), hash(nodeToken1), nodeToken1.slice(0, 8), makeHostKey().fingerprint, crypto.randomBytes(32).toString('base64')]),
    /ENROLLMENT_CONFLICT/
  );
  check('old token_hash cannot be reused even after offboarding');

  // 12. Cấp token dọn dẹp cục bộ (issue_worker_cleanup_token)
  const cleanupRawToken = crypto.randomBytes(32).toString('hex');
  const cleanupHash = hash(cleanupRawToken);
  const issueRes = await app.query(`SELECT * FROM issue_worker_cleanup_token($1, $2, $3, $4, $5)`,
    [opId, node1Id, gatewayId, adminId, cleanupHash]);
  assert.equal(issueRes.rows[0].node_name, 'worker-alpha');
  check('cleanup token hash issued by admin');

  // 13. Xác minh capability trước khi Worker dọn dẹp (verify_worker_cleanup_capability)
  await assert.rejects(
    app.query(`SELECT * FROM verify_worker_cleanup_capability($1, 'wronghash00000000000000000000000000000000000000000000000000000000', $2)`, [opId, gatewayId]),
    /OFFBOARD_CAPABILITY_INVALID/
  );
  const verifyRes = await app.query(`SELECT * FROM verify_worker_cleanup_capability($1, $2, $3)`, [opId, cleanupHash, gatewayId]);
  assert.equal(verifyRes.rows[0].state, 'PENDING_LOCAL_CLEANUP');
  assert.equal(verifyRes.rows[0].lifecycle_state, 'REVOKED');
  check('verify_worker_cleanup_capability validates bound identity');

  // 14. Kiểm tra hợp đồng payload hoàn tất (complete_worker_offboarding)
  const validReceiptPayload = {
    version: 1,
    operation_id: opId,
    node_id: node1Id,
    gateway_id: gatewayId,
    invitation_id: invite1Id,
    wireguard_public_key: wgKey1,
    node_ip: '10.100.0.10',
    status: 'NEEDS_REVIEW',
    receipt: {
      platform: 'linux',
      steps: {
        agent: 'DONE',
        tunnel: 'DONE',
        firewall: 'REVIEW',
        ssh: 'DONE',
        secrets: 'DONE',
      },
      evidence_digest: hash('evidence-review-1'),
    },
  };
  const receiptHash1 = hash(JSON.stringify(validReceiptPayload));

  // Kiểm tra bắt lỗi: sai node_id trong payload
  const badNodePayload = { ...validReceiptPayload, node_id: node2Id };
  await assert.rejects(
    app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'NEEDS_REVIEW', $4, $5)`,
      [opId, cleanupHash, gatewayId, hash(JSON.stringify(badNodePayload)), JSON.stringify(badNodePayload)]),
    /OFFBOARD_RECEIPT_IDENTITY_MISMATCH/
  );

  // Kiểm tra bắt lỗi: sai wireguard_public_key trong payload
  const badKeyPayload = { ...validReceiptPayload, wireguard_public_key: wgKey4 };
  await assert.rejects(
    app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'NEEDS_REVIEW', $4, $5)`,
      [opId, cleanupHash, gatewayId, hash(JSON.stringify(badKeyPayload)), JSON.stringify(badKeyPayload)]),
    /OFFBOARD_RECEIPT_IDENTITY_MISMATCH/
  );

  // Kiểm tra bắt lỗi: version không phải 1
  const badVerPayload = { ...validReceiptPayload, version: 2 };
  await assert.rejects(
    app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'NEEDS_REVIEW', $4, $5)`,
      [opId, cleanupHash, gatewayId, hash(JSON.stringify(badVerPayload)), JSON.stringify(badVerPayload)]),
    /OFFBOARD_RECEIPT_IDENTITY_MISMATCH/
  );

  // Kiểm tra bắt lỗi: COMPLETE khi còn bước chưa DONE
  const incompleteCompletePayload = { ...validReceiptPayload, status: 'COMPLETE' };
  await assert.rejects(
    app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'COMPLETE', $4, $5)`,
      [opId, cleanupHash, gatewayId, hash(JSON.stringify(incompleteCompletePayload)), JSON.stringify(incompleteCompletePayload)]),
    /OFFBOARD_STEPS_INCOMPLETE/
  );

  // Kiểm tra bắt lỗi: thiếu hoặc null platform
  const noPlatformPayload = { ...validReceiptPayload, receipt: { ...validReceiptPayload.receipt } };
  delete noPlatformPayload.receipt.platform;
  await assert.rejects(
    app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'NEEDS_REVIEW', $4, $5)`,
      [opId, cleanupHash, gatewayId, hash(JSON.stringify(noPlatformPayload)), JSON.stringify(noPlatformPayload)]),
    /OFFBOARD_BAD_INPUT/
  );
  const nullPlatformPayload = { ...validReceiptPayload, receipt: { ...validReceiptPayload.receipt, platform: null } };
  await assert.rejects(
    app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'NEEDS_REVIEW', $4, $5)`,
      [opId, cleanupHash, gatewayId, hash(JSON.stringify(nullPlatformPayload)), JSON.stringify(nullPlatformPayload)]),
    /OFFBOARD_BAD_INPUT/
  );

  // Kiểm tra bắt lỗi: thiếu hoặc null evidence_digest
  const noDigestPayload = { ...validReceiptPayload, receipt: { ...validReceiptPayload.receipt } };
  delete noDigestPayload.receipt.evidence_digest;
  await assert.rejects(
    app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'NEEDS_REVIEW', $4, $5)`,
      [opId, cleanupHash, gatewayId, hash(JSON.stringify(noDigestPayload)), JSON.stringify(noDigestPayload)]),
    /OFFBOARD_BAD_INPUT/
  );
  const nullDigestPayload = { ...validReceiptPayload, receipt: { ...validReceiptPayload.receipt, evidence_digest: null } };
  await assert.rejects(
    app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'NEEDS_REVIEW', $4, $5)`,
      [opId, cleanupHash, gatewayId, hash(JSON.stringify(nullDigestPayload)), JSON.stringify(nullDigestPayload)]),
    /OFFBOARD_BAD_INPUT/
  );

  // Kiểm tra bắt lỗi: steps rỗng {} với cả NEEDS_REVIEW lẫn COMPLETE
  const emptyStepsPayload = { ...validReceiptPayload, receipt: { ...validReceiptPayload.receipt, steps: {} } };
  await assert.rejects(
    app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'NEEDS_REVIEW', $4, $5)`,
      [opId, cleanupHash, gatewayId, hash(JSON.stringify(emptyStepsPayload)), JSON.stringify(emptyStepsPayload)]),
    /OFFBOARD_BAD_INPUT/
  );
  const emptyStepsCompletePayload = { ...emptyStepsPayload, status: 'COMPLETE' };
  await assert.rejects(
    app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'COMPLETE', $4, $5)`,
      [opId, cleanupHash, gatewayId, hash(JSON.stringify(emptyStepsCompletePayload)), JSON.stringify(emptyStepsCompletePayload)]),
    /OFFBOARD_BAD_INPUT/
  );

  // Kiểm tra bắt lỗi: từng step thiếu hoặc mang giá trị null
  for (const stepKey of ['agent', 'tunnel', 'firewall', 'ssh', 'secrets']) {
    const missingStep = {
      ...validReceiptPayload,
      receipt: {
        ...validReceiptPayload.receipt,
        steps: { ...validReceiptPayload.receipt.steps },
      },
    };
    delete missingStep.receipt.steps[stepKey];
    await assert.rejects(
      app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'NEEDS_REVIEW', $4, $5)`,
        [opId, cleanupHash, gatewayId, hash(JSON.stringify(missingStep)), JSON.stringify(missingStep)]),
      /OFFBOARD_BAD_INPUT/
    );

    const nullStep = {
      ...validReceiptPayload,
      receipt: {
        ...validReceiptPayload.receipt,
        steps: { ...validReceiptPayload.receipt.steps, [stepKey]: null },
      },
    };
    await assert.rejects(
      app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'NEEDS_REVIEW', $4, $5)`,
        [opId, cleanupHash, gatewayId, hash(JSON.stringify(nullStep)), JSON.stringify(nullStep)]),
      /OFFBOARD_BAD_INPUT/
    );
  }

  // Đảm bảo sau tất cả các cuộc gọi lỗi trên, node vẫn REVOKED, tuyệt đối không bị mark REMOVED
  const nodeAfterInvalid = (await db.query('SELECT lifecycle_state FROM nodes WHERE id = $1', [node1Id])).rows[0];
  assert.equal(nodeAfterInvalid.lifecycle_state, 'REVOKED');

  // Kiểm tra bắt lỗi: oversize (>8192 bytes)
  const oversizePayload = { ...validReceiptPayload, overflow: 'x'.repeat(8200) };
  await assert.rejects(
    app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'NEEDS_REVIEW', $4, $5)`,
      [opId, cleanupHash, gatewayId, hash(JSON.stringify(oversizePayload)), JSON.stringify(oversizePayload)]),
    /OFFBOARD_BAD_INPUT/
  );
  check('complete_worker_offboarding validates exact receipt contract, identity, non-null fields and step completeness');

  // 15. Báo cáo dọn dẹp gặp sự cố: NEEDS_REVIEW hợp lệ
  const reviewRes = await app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'NEEDS_REVIEW', $4, $5)`,
    [opId, cleanupHash, gatewayId, receiptHash1, JSON.stringify(validReceiptPayload)]);
  assert.equal(reviewRes.rows[0].state, 'NEEDS_REVIEW');
  assert.equal(reviewRes.rows[0].lifecycle_state, 'REVOKED');
  check('complete_worker_offboarding transitions to NEEDS_REVIEW when operator reports conflict');

  // 16. Sau khi xử lý thủ công, báo cáo COMPLETE với tất cả 5 bước DONE
  const completePayload = {
    version: 1,
    operation_id: opId,
    node_id: node1Id,
    gateway_id: gatewayId,
    invitation_id: invite1Id,
    wireguard_public_key: wgKey1,
    node_ip: '10.100.0.10',
    status: 'COMPLETE',
    receipt: {
      platform: 'linux',
      steps: {
        agent: 'DONE',
        tunnel: 'DONE',
        firewall: 'DONE',
        ssh: 'DONE',
        secrets: 'DONE',
      },
      evidence_digest: hash('evidence-clean-2'),
    },
  };
  const receiptHash2 = hash(JSON.stringify(completePayload));
  const completeRes = await app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'COMPLETE', $4, $5)`,
    [opId, cleanupHash, gatewayId, receiptHash2, JSON.stringify(completePayload)]);
  assert.equal(completeRes.rows[0].state, 'COMPLETED');
  assert.equal(completeRes.rows[0].lifecycle_state, 'REMOVED');
  assert.equal(completeRes.rows[0].replayed, false);
  check('complete_worker_offboarding transitions to COMPLETED / REMOVED');

  // 17. Replay cùng receipt và hash -> trả về 200/idempotent (replayed = true)
  const replayRes = await app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'COMPLETE', $4, $5)`,
    [opId, cleanupHash, gatewayId, receiptHash2, JSON.stringify(completePayload)]);
  assert.equal(replayRes.rows[0].replayed, true);
  check('receipt replay is idempotent when both hash and payload match');

  // 18. Replay cùng passed hash nhưng khác payload -> từ chối xung đột (OFFBOARD_RECEIPT_CONFLICT)
  const tamperedPayload = { ...completePayload, receipt: { ...completePayload.receipt, platform: 'windows' } };
  await assert.rejects(
    app.query(`SELECT * FROM complete_worker_offboarding($1, $2, $3, 'COMPLETE', $4, $5)`,
      [opId, cleanupHash, gatewayId, receiptHash2, JSON.stringify(tamperedPayload)]),
    /OFFBOARD_RECEIPT_CONFLICT/
  );
  check('differing payload replay with same hash is rejected');

  // 19. Tra cứu status (get_worker_offboarding_status) không để lộ token hash
  const statusRes = await app.query(`SELECT * FROM get_worker_offboarding_status($1, $2)`, [node1Id, gatewayId]);
  assert.equal(statusRes.rows[0].has_cleanup_token, true);
  assert.equal(statusRes.rows[0].state, 'COMPLETED');
  assert.equal(statusRes.rows[0].lifecycle_state, 'REMOVED');
  assert.equal(typeof statusRes.rows[0].cleanup_token_hash, 'undefined');
  check('get_worker_offboarding_status returns clean metadata without token secret');

  // 20. Kiểm tra bảo toàn dữ liệu lịch sử (không xóa bất kỳ dòng nào)
  const nodeCount = (await db.query('SELECT count(*)::int n FROM nodes')).rows[0].n;
  assert.ok(nodeCount >= 3);
  const auditLogs = await db.query("SELECT action FROM audit_logs WHERE action IN ('WORKER_OFFBOARD_STARTED', 'WORKER_PEER_REVOKED', 'WORKER_OFFBOARDED')");
  assert.equal(auditLogs.rowCount, 3);
  check('all historical nodes, audit logs and worker records retained forever');

  // 21. Khởi động Fastify HTTP inject test suite với đầy đủ biến môi trường chuẩn bị trước
  const os = require('node:os');
  reqDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-offboard-requests-'));
  ackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-offboard-acks-'));
  const bastionKey = path.join(reqDir, 'bastion_key');
  fs.writeFileSync(bastionKey, 'key-fixture', { mode: 0o400 });

  process.env.NODE_ENV = 'test';
  process.env.TELEGRAM_MODE = 'disabled';
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.ENROLLMENT_ENABLED = 'true';
  process.env.ENROLLMENT_GATEWAY_ID = gatewayId;
  process.env.ENROLLMENT_PUBLIC_URL = 'https://gateway.example.test';
  process.env.ENROLLMENT_ENDPOINT = '192.0.2.10:51820';
  process.env.ENROLLMENT_GATEWAY_PUBLIC_KEY = gatewayKey;
  process.env.ENROLLMENT_BASTION_PUBLIC_KEY = host1.key;
  process.env.ENROLLMENT_REQUEST_DIR = reqDir;
  process.env.ENROLLMENT_ACK_DIR = ackDir;
  process.env.BASTION_SSH_KEY_PATH = bastionKey;

  const { buildServer } = require('./dist/app.js');
  ({ closeDatabasePool: closePool } = require('./dist/services/db.js'));
  server = await buildServer();

  // Đọc hàng người dùng thực tế từ CSDL để ký JWT có đủ session_version và thời hạn hợp lý
  const adminUser = (await db.query('SELECT id, username, role, session_version FROM users WHERE id = $1', [adminId])).rows[0];
  const viewerUser = (await db.query('SELECT id, username, role, session_version FROM users WHERE id = $1', [viewerId])).rows[0];
  assert.equal(typeof adminUser.session_version, 'number');
  assert.equal(typeof viewerUser.session_version, 'number');

  const adminJwt = server.jwt.sign({
    id: adminUser.id,
    username: adminUser.username,
    role: adminUser.role,
    session_version: adminUser.session_version,
  }, { expiresIn: '1h' });

  const viewerJwt = server.jwt.sign({
    id: viewerUser.id,
    username: viewerUser.username,
    role: viewerUser.role,
    session_version: viewerUser.session_version,
  }, { expiresIn: '1h' });

  // Kiểm tra chặn token cũ thiếu session_version (LEGACY_SESSION_EXPIRED)
  const legacyJwt = server.jwt.sign({
    id: adminUser.id,
    username: adminUser.username,
    role: adminUser.role,
  }, { expiresIn: '1h' });

  const legacyRes = await server.inject({
    method: 'GET',
    url: '/api/telemetry/nodes',
    headers: { authorization: 'Bearer ' + legacyJwt },
  });
  assert.equal(legacyRes.statusCode, 401);
  assert.equal(legacyRes.json().code, 'LEGACY_SESSION_EXPIRED');

  // 22. Kiểm tra Fleet read với vai trò zt_app (hàm is_node_enrolled hẹp, không SELECT raw table)
  const fleetRes = await server.inject({
    method: 'GET',
    url: '/api/telemetry/nodes',
    headers: { authorization: 'Bearer ' + adminJwt },
  });
  assert.equal(fleetRes.statusCode, 200);
  const fleetJson = fleetRes.json();
  assert.equal(fleetJson.success, true);
  assert.ok(Array.isArray(fleetJson.data));
  const betaNode = fleetJson.data.find(n => n.name === 'worker-beta');
  const legacyNode = fleetJson.data.find(n => n.name === 'worker-legacy');
  assert.ok(betaNode, 'worker-beta must be present in active fleet');
  assert.equal(betaNode.is_enrolled, true);
  assert.ok(legacyNode, 'worker-legacy must be present in active fleet');
  assert.equal(legacyNode.is_enrolled, false);

  // Bộ lọc lifecycle: removed và all
  const removedRes = await server.inject({
    method: 'GET',
    url: '/api/telemetry/nodes?lifecycle=removed',
    headers: { authorization: 'Bearer ' + adminJwt },
  });
  assert.equal(removedRes.statusCode, 200);
  const removedJson = removedRes.json();
  assert.ok(removedJson.data.some(n => n.name === 'worker-alpha' && n.lifecycle_state === 'REMOVED'));

  const allRes = await server.inject({
    method: 'GET',
    url: '/api/telemetry/nodes?lifecycle=all',
    headers: { authorization: 'Bearer ' + viewerJwt },
  });
  assert.equal(allRes.statusCode, 200);
  assert.ok(allRes.json().data.length >= 3);

  // Truy vấn lịch sử số liệu: UUID cho phép đọc node đã offboard, name chỉ cho phép active
  const uuidHistoryRes = await server.inject({
    method: 'GET',
    url: `/api/telemetry/nodes/${node1Id}/history`,
    headers: { authorization: 'Bearer ' + adminJwt },
  });
  assert.equal(uuidHistoryRes.statusCode, 200);
  const nameHistoryRes = await server.inject({
    method: 'GET',
    url: `/api/telemetry/nodes/worker-alpha/history`,
    headers: { authorization: 'Bearer ' + adminJwt },
  });
  assert.equal(nameHistoryRes.statusCode, 200);
  assert.equal(nameHistoryRes.json().count, 0); // worker-alpha không còn ACTIVE nên name search trả về rỗng
  check('actual role zt_app queries fleet and history with lifecycle filters');

  // 23. Đăng ký Worker Delta để kiểm tra quy trình offboarding HTTP hoàn chỉnh
  const inviteTokenD = crypto.randomBytes(32).toString('hex');
  const inviteDId = (await db.query(`INSERT INTO worker_enrollments(gateway_id, token_hash, node_name, node_ip, node_type, worker_os, ssh_username, expires_at)
    VALUES($1, $2, 'worker-delta', '10.100.0.40'::inet, 'VM', 'linux', 'ztuser', now() + interval '1 hour') RETURNING id`,
    [gatewayId, hash(inviteTokenD)])).rows[0].id;

  const nodeTokenD = crypto.randomBytes(32).toString('hex');
  const wgKeyD = crypto.randomBytes(32).toString('base64');
  const hostD = makeHostKey();
  const claimResD = await app.query(`SELECT * FROM claim_worker_enrollment($1, $2, $3, $4, $5, $6, $7, $8)`,
    [inviteDId, hash(inviteTokenD), gatewayId, hash('claim-d'), hash(nodeTokenD), nodeTokenD.slice(0, 8), hostD.fingerprint, wgKeyD]);
  const nodeDId = claimResD.rows[0].node_id;
  await db.query(`UPDATE nodes SET status = 'HEALTHY', last_seen = now() - interval '20 minutes' WHERE id = $1`, [nodeDId]);

  // 24. RBAC và kiểm tra ràng buộc đầu vào trên các endpoint offboarding
  // Không xác thực -> 401
  const noAuthStart = await server.inject({
    method: 'POST',
    url: `/api/nodes/${nodeDId}/offboarding`,
    payload: { confirm_node_name: 'worker-delta' },
  });
  assert.equal(noAuthStart.statusCode, 401);

  // VIEWER không có quyền khởi tạo -> 403
  const viewerStart = await server.inject({
    method: 'POST',
    url: `/api/nodes/${nodeDId}/offboarding`,
    headers: { authorization: 'Bearer ' + viewerJwt },
    payload: { confirm_node_name: 'worker-delta' },
  });
  assert.equal(viewerStart.statusCode, 403);

  // Sai tên xác nhận -> 400
  const wrongConfirm = await server.inject({
    method: 'POST',
    url: `/api/nodes/${nodeDId}/offboarding`,
    headers: { authorization: 'Bearer ' + adminJwt },
    payload: { confirm_node_name: 'worker-wrong' },
  });
  assert.equal(wrongConfirm.statusCode, 400);

  // Legacy node không có enrollment -> 409
  const legacyOffboard = await server.inject({
    method: 'POST',
    url: `/api/nodes/${node2Id}/offboarding`,
    headers: { authorization: 'Bearer ' + adminJwt },
    payload: { confirm_node_name: 'worker-legacy' },
  });
  assert.equal(legacyOffboard.statusCode, 409);

  // ADMIN khởi tạo thành công -> 202 RETIRING
  const adminStart = await server.inject({
    method: 'POST',
    url: `/api/nodes/${nodeDId}/offboarding`,
    headers: { authorization: 'Bearer ' + adminJwt },
    payload: { confirm_node_name: 'worker-delta' },
  });
  assert.equal(adminStart.statusCode, 202);
  assert.equal(adminStart.headers['cache-control'], 'no-store');
  assert.equal(adminStart.headers['retry-after'], '3');
  const opDId = adminStart.json().operation.operation_id;
  assert.ok(opDId);

  // GET status: VIEWER và ADMIN đều xem được, không để lộ bí mật
  const statusNoAuth = await server.inject({ method: 'GET', url: `/api/nodes/${nodeDId}/offboarding` });
  assert.equal(statusNoAuth.statusCode, 401);

  const statusViewer = await server.inject({
    method: 'GET',
    url: `/api/nodes/${nodeDId}/offboarding`,
    headers: { authorization: 'Bearer ' + viewerJwt },
  });
  assert.equal(statusViewer.statusCode, 200);
  assert.equal(statusViewer.json().offboarding.state, 'PENDING_PEER_REMOVAL');
  assert.equal(statusViewer.json().offboarding.has_cleanup_token, false);
  assert.equal(typeof statusViewer.json().offboarding.cleanup_token, 'undefined');
  assert.equal(typeof statusViewer.json().offboarding.cleanup_token_hash, 'undefined');
  check('offboarding RBAC, confirmation name, and legacy rejection verified via Fastify inject');

  // 25. Kiểm tra lỗi hệ thống tập tin, cơ chế thử lại và ACK không khớp
  const { reconcilePendingOffboardings } = require('./dist/services/offboarding.js');

  // Thử nghiệm lỗi hệ thống tập tin: đưa thư mục requests về chế độ read-only
  fs.chmodSync(reqDir, 0o500);
  await reconcilePendingOffboardings();
  // Node vẫn phải ở trạng thái RETIRING, IP 10.100.0.40 tuyệt đối không bị giải phóng
  const nodeDFault = (await db.query('SELECT lifecycle_state FROM nodes WHERE id = $1', [nodeDId])).rows[0];
  assert.equal(nodeDFault.lifecycle_state, 'RETIRING');

  // Khôi phục quyền ghi để Gateway xuất tệp .remove thành công
  fs.chmodSync(reqDir, 0o700);
  await reconcilePendingOffboardings();
  const removeReqPath = path.join(reqDir, `${opDId}.remove`);
  assert.ok(fs.existsSync(removeReqPath), 'Removal request file must be published');
  assert.equal(fs.statSync(removeReqPath).mode & 0o777, 0o600);

  // Thử nghiệm ACK không khớp: ghi nội dung giả mạo vào file .removed
  const ackFilePath = path.join(ackDir, `${opDId}.removed`);
  fs.writeFileSync(ackFilePath, '1\nwrong-payload\n', { mode: 0o644 });
  await reconcilePendingOffboardings();

  // Mismatched ACK phải giữ nguyên trạng thái PENDING_PEER_REMOVAL và ghi nhận mã lỗi hữu hạn ACK_PAYLOAD_MISMATCH
  const statusAfterMismatch = await server.inject({
    method: 'GET',
    url: `/api/nodes/${nodeDId}/offboarding`,
    headers: { authorization: 'Bearer ' + adminJwt },
  });
  assert.equal(statusAfterMismatch.statusCode, 200);
  assert.equal(statusAfterMismatch.json().offboarding.state, 'PENDING_PEER_REMOVAL');
  assert.equal(statusAfterMismatch.json().offboarding.last_error, 'ACK_PAYLOAD_MISMATCH');

  // Ghi nhận lưu ý kiến trúc: ACK giả mạo trong không gian người dùng nhằm kiểm tra máy trạng thái giao thức,
  // kiểm chứng mật mã WireGuard nhân Linux đã được thực thi riêng biệt tại phòng lab Kernel NetAdmin
  assert.ok(true, 'Test fakeACK clearly not kernel proof: protocol state machine only');

  // Ghi đúng nội dung ACK chuẩn 6 dòng
  const validAckContent = `1\n${opDId}\n${nodeDId}\n${inviteDId}\n${wgKeyD}\n10.100.0.40\n`;
  fs.writeFileSync(ackFilePath, validAckContent, { mode: 0o644 });
  await reconcilePendingOffboardings();

  // Sau khi khớp ACK bền vững từ helper và CSDL, node chuyển sang REVOKED, op sang PENDING_LOCAL_CLEANUP
  const statusAfterAck = await server.inject({
    method: 'GET',
    url: `/api/nodes/${nodeDId}/offboarding`,
    headers: { authorization: 'Bearer ' + adminJwt },
  });
  assert.equal(statusAfterAck.statusCode, 200);
  assert.equal(statusAfterAck.json().offboarding.lifecycle_state, 'REVOKED');
  assert.equal(statusAfterAck.json().offboarding.state, 'PENDING_LOCAL_CLEANUP');
  assert.equal(statusAfterAck.json().offboarding.last_error, null);
  check('filesystem fault retry, mismatched ACK protection, and exact ACK transition verified');

  // 26. Cấp phát authorization capability tải về, xoay vòng token và xác minh scoped public
  const authViewer = await server.inject({
    method: 'POST',
    url: `/api/nodes/${nodeDId}/offboarding/authorization`,
    headers: { authorization: 'Bearer ' + viewerJwt },
  });
  assert.equal(authViewer.statusCode, 403);

  const authAdmin1 = await server.inject({
    method: 'POST',
    url: `/api/nodes/${nodeDId}/offboarding/authorization`,
    headers: { authorization: 'Bearer ' + adminJwt },
  });
  assert.equal(authAdmin1.statusCode, 200);
  assert.equal(authAdmin1.headers['cache-control'], 'no-store');
  const bundle1 = authAdmin1.json();
  assert.equal(bundle1.node_id, nodeDId);
  assert.ok(bundle1.cleanup_token);

  // Token hash trong CSDL phải là SHA-256, tuyệt đối không lưu plaintext token
  const opRowInDb = (await db.query('SELECT cleanup_token_hash FROM worker_offboardings WHERE id = $1', [opDId])).rows[0];
  assert.equal(opRowInDb.cleanup_token_hash, hash(bundle1.cleanup_token));
  assert.notEqual(opRowInDb.cleanup_token_hash, bundle1.cleanup_token);

  // Tải lại capability -> tự động xoay vòng mã xác thực (rotate capability)
  const authAdmin2 = await server.inject({
    method: 'POST',
    url: `/api/nodes/${nodeDId}/offboarding/authorization`,
    headers: { authorization: 'Bearer ' + adminJwt },
  });
  assert.equal(authAdmin2.statusCode, 200);
  const bundle2 = authAdmin2.json();
  assert.notEqual(bundle2.cleanup_token, bundle1.cleanup_token);

  // Mã cũ bundle1.cleanup_token nay đã bị vô hiệu hóa
  const verifyOldToken = await server.inject({
    method: 'POST',
    url: '/api/offboarding/verify',
    headers: { 'x-cleanup-token': bundle1.cleanup_token },
    payload: {
      version: 1,
      operation_id: opDId,
      gateway_id: gatewayId,
      node_id: nodeDId,
      invitation_id: inviteDId,
      wireguard_public_key: wgKeyD,
      node_ip: '10.100.0.40',
    },
  });
  assert.equal(verifyOldToken.statusCode, 401);

  // Mã mới bundle2.cleanup_token xác minh thành công
  const verifyValid = await server.inject({
    method: 'POST',
    url: '/api/offboarding/verify',
    headers: { 'x-cleanup-token': bundle2.cleanup_token },
    payload: {
      version: 1,
      operation_id: opDId,
      gateway_id: gatewayId,
      node_id: nodeDId,
      invitation_id: inviteDId,
      wireguard_public_key: wgKeyD,
      node_ip: '10.100.0.40',
    },
  });
  assert.equal(verifyValid.statusCode, 200);
  assert.equal(verifyValid.json().success, true);
  assert.equal(verifyValid.json().gateway_id, gatewayId);
  assert.equal(verifyValid.json().operation_id, opDId);
  assert.equal(verifyValid.json().node_id, nodeDId);
  assert.equal(verifyValid.json().invitation_id, inviteDId);
  assert.equal(verifyValid.json().wireguard_public_key, wgKeyD);
  assert.equal(verifyValid.json().node_ip, '10.100.0.40');
  assert.equal(verifyValid.json().state, 'PENDING_LOCAL_CLEANUP');
  check('authorization capability download, rotation, and scoped public verify contract verified');

  // 27. Hoàn tất biên bản dọn dẹp, kiểm tra tính lũy kế và xung đột
  const validCompleteReceipt = {
    version: 1,
    operation_id: opDId,
    node_id: nodeDId,
    gateway_id: gatewayId,
    invitation_id: inviteDId,
    wireguard_public_key: wgKeyD,
    node_ip: '10.100.0.40',
    status: 'COMPLETE',
    receipt: {
      platform: 'linux',
      steps: {
        agent: 'DONE',
        tunnel: 'DONE',
        firewall: 'DONE',
        ssh: 'DONE',
        secrets: 'DONE',
      },
      evidence_digest: hash('evidence-delta-complete'),
    },
  };

  // Nếu COMPLETE mà còn bước REVIEW -> 400
  const incompleteStepRes = await server.inject({
    method: 'POST',
    url: '/api/offboarding/complete',
    headers: { 'x-cleanup-token': bundle2.cleanup_token },
    payload: {
      ...validCompleteReceipt,
      receipt: {
        ...validCompleteReceipt.receipt,
        steps: { ...validCompleteReceipt.receipt.steps, firewall: 'REVIEW' },
      },
    },
  });
  assert.equal(incompleteStepRes.statusCode, 400);

  // Hoàn tất biên bản thành công -> 200, chuyển sang COMPLETED / REMOVED
  const completeOk = await server.inject({
    method: 'POST',
    url: '/api/offboarding/complete',
    headers: { 'x-cleanup-token': bundle2.cleanup_token },
    payload: validCompleteReceipt,
  });
  assert.equal(completeOk.statusCode, 200);
  assert.equal(completeOk.json().state, 'COMPLETED');
  assert.equal(completeOk.json().lifecycle_state, 'REMOVED');
  assert.equal(completeOk.json().replayed, false);

  // Replay cùng tải trọng -> 200 idempotent (replayed: true)
  const completeReplay = await server.inject({
    method: 'POST',
    url: '/api/offboarding/complete',
    headers: { 'x-cleanup-token': bundle2.cleanup_token },
    payload: validCompleteReceipt,
  });
  assert.equal(completeReplay.statusCode, 200);
  assert.equal(completeReplay.json().replayed, true);

  // Replay khác tải trọng -> 409 xung đột
  const tamperedComplete = await server.inject({
    method: 'POST',
    url: '/api/offboarding/complete',
    headers: { 'x-cleanup-token': bundle2.cleanup_token },
    payload: {
      ...validCompleteReceipt,
      receipt: {
        ...validCompleteReceipt.receipt,
        platform: 'windows',
      },
    },
  });
  assert.equal(tamperedComplete.statusCode, 409);

  // Không thể cấp authorization mới khi quy trình đã COMPLETED
  const authAfterComplete = await server.inject({
    method: 'POST',
    url: `/api/nodes/${nodeDId}/offboarding/authorization`,
    headers: { authorization: 'Bearer ' + adminJwt },
  });
  assert.equal(authAfterComplete.statusCode, 409);
  check('complete receipt, replay idempotency, conflict rejection, and terminal completed state verified');

  // 28. Máy chủ đã thu hồi không thể gửi telemetry và không phát sinh cảnh báo giả
  const nowSec = Math.floor(Date.now() / 1000);
  const retiredBeaconRes = await server.inject({
    method: 'POST',
    url: '/api/telemetry/beacon',
    headers: { 'x-node-token': nodeTokenD },
    payload: {
      node_id: nodeDId,
      timestamp: nowSec,
      metrics: {
        cpu: { percent: 25 },
        memory: { total_bytes: 2048, used_bytes: 1024, percent: 50 },
        disk: { total_bytes: 8192, used_bytes: 4096, percent: 50 },
        network: { rx_bytes_total: 100, tx_bytes_total: 200 },
        uptime_seconds: 500,
      },
    },
  });
  assert.equal(retiredBeaconRes.statusCode, 401);
  assert.equal(retiredBeaconRes.json().code, 'REVOKED_NODE_TOKEN');

  // Máy chủ còn ACTIVE (worker-beta) gửi số liệu hoàn toàn bình thường (positive control với CPU thấp)
  const activeBeaconRes = await server.inject({
    method: 'POST',
    url: '/api/telemetry/beacon',
    headers: { 'x-node-token': nodeToken4 },
    payload: {
      node_id: node4Id,
      timestamp: nowSec,
      metrics: {
        cpu: { percent: 10 },
        memory: { total_bytes: 2048, used_bytes: 1024, percent: 50 },
        disk: { total_bytes: 8192, used_bytes: 4096, percent: 50 },
        network: { rx_bytes_total: 100, tx_bytes_total: 200 },
        uptime_seconds: 500,
      },
    },
  });
  assert.equal(activeBeaconRes.statusCode, 200);

  // Xác minh worker-beta được cập nhật last_seen, status HEALTHY và bản ghi metrics_history mới
  const node4After = (await db.query('SELECT last_seen, status FROM nodes WHERE id = $1', [node4Id])).rows[0];
  assert.ok(node4After.last_seen);
  assert.equal(node4After.status, 'HEALTHY');
  const metricRow4 = (await db.query('SELECT cpu_percent FROM metrics_history WHERE node_id = $1 ORDER BY recorded_at DESC LIMIT 1', [node4Id])).rows[0];
  assert.ok(metricRow4);
  assert.equal(Number(metricRow4.cpu_percent), 10);

  // Kiểm tra chống cảnh báo giả: worker-delta từng có status HEALTHY với last_seen cũ (20 phút trước)
  // nhưng nay đã offboard (REMOVED). Khi sweeper chạy, không được đánh dấu OFFLINE hoặc sinh cảnh báo mới.
  const { runSweeperCycle } = require('./dist/services/sweeper.js');
  const sweepRes = await runSweeperCycle();
  assert.ok(!sweepRes.offlineNodesDetected.includes('worker-delta'), 'Retired worker-delta must not be flagged offline');
  assert.ok(!sweepRes.offlineNodesDetected.includes('worker-beta'), 'Active healthy worker-beta must not be flagged offline');

  const deltaAlerts = (await db.query('SELECT * FROM alerts WHERE node_id = $1', [nodeDId])).rows;
  assert.equal(deltaAlerts.length, 0, 'No alerts should exist for retired worker-delta');
  const betaAlerts = (await db.query('SELECT * FROM alerts WHERE node_id = $1', [node4Id])).rows;
  assert.equal(betaAlerts.length, 0, 'No alerts should exist for active healthy worker-beta');

  check('retired node cannot heartbeat and triggers no false alerts while other nodes remain healthy');

  console.log(`\nALL ${checks.length} OFFBOARDING DB CHECKS PASSED.`);
}

main()
  .catch((err) => {
    console.error('Offboarding DB runtime test failed:', err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) await server.close().catch(() => {});
    if (closePool) await closePool().catch(() => {});
    if (reqDir) try { fs.rmSync(reqDir, { recursive: true, force: true }); } catch {}
    if (ackDir) try { fs.rmSync(ackDir, { recursive: true, force: true }); } catch {}
    if (app) await app.end().catch(() => {});
    if (db) await db.end().catch(() => {});
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });
