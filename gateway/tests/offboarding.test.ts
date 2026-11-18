import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sshBlob = Buffer.concat([
  Buffer.from('0000000b7373682d6564323535313900000020', 'hex'),
  crypto.randomBytes(32),
]).toString('base64');
const validSshKey = 'ssh-ed25519 ' + sshBlob;

const mock = vi.hoisted(() => ({
  query: vi.fn(),
  terminateSessions: vi.fn(),
  invalidateTickets: vi.fn(),
  config: {
    NODE_ENV: 'test',
    JWT_SECRET: 'test-jwt-secret-minimum-32-chars-long-for-testing',
    ENROLLMENT_ENABLED: true,
    ENROLLMENT_GATEWAY_ID: '',
    ENROLLMENT_PUBLIC_URL: 'https://gateway.example.test',
    ENROLLMENT_ENDPOINT: '192.0.2.10:51820',
    ENROLLMENT_GATEWAY_PUBLIC_KEY: '',
    ENROLLMENT_BASTION_PUBLIC_KEY: '',
    ENROLLMENT_REQUEST_DIR: '',
    ENROLLMENT_ACK_DIR: '',
    BASTION_SSH_KEY_PATH: '',
  },
}));

vi.mock('../src/services/db.js', () => ({ query: mock.query }));
vi.mock('../src/config/env.js', () => ({ config: mock.config }));
vi.mock('../src/services/bastion/registry.js', () => ({ terminateSessionsForNode: mock.terminateSessions }));
vi.mock('../src/services/bastion/tickets.js', () => ({ invalidateTicketsForNode: mock.invalidateTickets }));

import { offboardingRoutes } from '../src/routes/offboarding.js';
import { enrollmentPublicConfig } from '../src/services/enrollment-contract.js';
import {
  buildRemovalPayload,
  canonicalJson,
  HELPER_ERROR_WHITELIST,
  mapSqlOffboardError,
  OffboardingError,
  publishWorkerPeerRemoval,
  reconcilePendingOffboardings,
  revokeNodeAccess,
  safeDirectory,
  validateRemovalIdentity,
} from '../src/services/offboarding.js';

describe('Worker Offboarding Unit & Route Suite', () => {
  let directory: string;
  let requestsDir: string;
  let acksDir: string;
  let app: FastifyInstance;
  let gatewayId: string;

  const adminId = '11111111-1111-4111-8111-111111111111';
  const viewerId = '22222222-2222-4222-8222-222222222222';
  const nodeId = '33333333-3333-4333-8333-333333333333';
  const opId = '44444444-4444-4444-8444-444444444444';
  const inviteId = '55555555-5555-4555-8555-555555555555';
  const wgKey = crypto.randomBytes(32).toString('base64');
  const nodeIp = '10.100.0.15';
  const rawCleanupToken = 'f'.repeat(64);
  const cleanupTokenHash = crypto.createHash('sha256').update(rawCleanupToken).digest('hex');

  let adminJwt: string;
  let viewerJwt: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-offboard-unit-'));
    requestsDir = path.join(directory, 'requests');
    acksDir = path.join(directory, 'acks');
    fs.mkdirSync(requestsDir, { mode: 0o700 });
    fs.mkdirSync(acksDir, { mode: 0o755 });

    mock.config.ENROLLMENT_ENABLED = true;
    mock.config.ENROLLMENT_GATEWAY_PUBLIC_KEY = crypto.randomBytes(32).toString('base64');
    mock.config.ENROLLMENT_BASTION_PUBLIC_KEY = validSshKey;
    mock.config.ENROLLMENT_GATEWAY_ID = '';
    mock.config.ENROLLMENT_REQUEST_DIR = requestsDir;
    mock.config.ENROLLMENT_ACK_DIR = acksDir;
    gatewayId = enrollmentPublicConfig(mock.config).gateway_id;

    // Mặc định phản hồi xác thực người dùng trong auth.middleware
    mock.query.mockImplementation(async (sql: string, params?: any[]) => {
      if (typeof sql === 'string' && sql.includes('FROM users')) {
        const isViewer = params?.[0] === viewerId;
        return {
          rows: [{
            id: params?.[0] || adminId,
            username: isViewer ? 'viewer-actor' : 'admin-actor',
            role: isViewer ? 'VIEWER' : 'ADMIN',
            is_active: true,
            session_version: 1,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    app = Fastify();
    await app.register(jwt, { secret: mock.config.JWT_SECRET });
    await app.register(offboardingRoutes, { prefix: '/api' });

    adminJwt = app.jwt.sign({ id: adminId, role: 'ADMIN', username: 'admin-actor', session_version: 1 });
    viewerJwt = app.jwt.sign({ id: viewerId, role: 'VIEWER', username: 'viewer-actor', session_version: 1 });
  });

  afterEach(async () => {
    if (app) await app.close();
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  });

  // 1. Service: canonicalJson
  describe('canonicalJson', () => {
    it('produces deterministic key-sorted JSON regardless of key insertion order', () => {
      const obj1 = { z: 1, a: 2, m: { b: 3, a: 4 } };
      const obj2 = { a: 2, m: { a: 4, b: 3 }, z: 1 };
      expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
      expect(canonicalJson(obj1)).toBe('{"a":2,"m":{"a":4,"b":3},"z":1}');
    });

    it('handles arrays and primitives correctly', () => {
      expect(canonicalJson([3, 2, 1])).toBe('[3,2,1]');
      expect(canonicalJson('hello')).toBe('"hello"');
      expect(canonicalJson(null)).toBe('null');
    });
  });

  // 2. Service: validateRemovalIdentity & buildRemovalPayload
  describe('Removal Identity Validation', () => {
    it('validates canonical UUIDs, WireGuard base64 key, and IPv4', () => {
      expect(() => validateRemovalIdentity(opId, nodeId, inviteId, wgKey, nodeIp)).not.toThrow();
      const payload = buildRemovalPayload(opId, nodeId, inviteId, wgKey, nodeIp);
      expect(payload).toBe(`1\n${opId}\n${nodeId}\n${inviteId}\n${wgKey}\n${nodeIp}\n`);
    });

    it('rejects invalid UUIDs, path traversal attempts, or malformed keys/IPs', () => {
      expect(() => validateRemovalIdentity('../escape', nodeId, inviteId, wgKey, nodeIp))
        .toThrowError(OffboardingError);
      expect(() => validateRemovalIdentity(opId, nodeId, inviteId, 'short-key', nodeIp))
        .toThrowError(OffboardingError);
      expect(() => validateRemovalIdentity(opId, nodeId, inviteId, wgKey, '999.999.999.999'))
        .toThrowError(OffboardingError);
    });
  });

  // 3. Service: safeDirectory
  describe('safeDirectory', () => {
    it('accepts valid 0700 request directory and 0755 ack directory in test mode', () => {
      expect(() => safeDirectory(requestsDir, true)).not.toThrow();
      expect(() => safeDirectory(acksDir, false)).not.toThrow();
    });

    it('rejects non-existent or relative paths', () => {
      expect(() => safeDirectory('./relative', true)).toThrow();
    });
  });

  // 4. Service: publishWorkerPeerRemoval
  describe('publishWorkerPeerRemoval', () => {
    it('writes atomic 0600 removal request and returns false when ACK is not yet present', () => {
      const ready = publishWorkerPeerRemoval(opId, nodeId, inviteId, wgKey, nodeIp);
      expect(ready).toBe(false);

      const target = path.join(requestsDir, `${opId}.remove`);
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(target, 'utf8')).toBe(buildRemovalPayload(opId, nodeId, inviteId, wgKey, nodeIp));
    });

    it('returns true when exact matching root ACK file is present', () => {
      const content = buildRemovalPayload(opId, nodeId, inviteId, wgKey, nodeIp);
      fs.writeFileSync(path.join(acksDir, `${opId}.removed`), content, { mode: 0o644 });

      const ready = publishWorkerPeerRemoval(opId, nodeId, inviteId, wgKey, nodeIp);
      expect(ready).toBe(true);
    });

    it('throws OFFBOARD_REMOVAL_REJECTED with whitelisted error code when helper writes .remove-error', () => {
      fs.writeFileSync(path.join(acksDir, `${opId}.remove-error`), 'PEER_REMOVE_FAILED\n', { mode: 0o644 });
      try {
        publishWorkerPeerRemoval(opId, nodeId, inviteId, wgKey, nodeIp);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('PEER_REMOVE_FAILED');
      }
    });

    it('maps non-whitelisted arbitrary error text to safe generic PEER_REMOVE_FAILED code', () => {
      fs.writeFileSync(path.join(acksDir, `${opId}.remove-error`), 'arbitrary internal error /etc/secret\n', { mode: 0o644 });
      try {
        publishWorkerPeerRemoval(opId, nodeId, inviteId, wgKey, nodeIp);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('PEER_REMOVE_FAILED');
        expect(err.message).not.toContain('/etc/secret');
      }
    });

    it('throws ACK_PAYLOAD_MISMATCH when ACK content differs from published request', () => {
      fs.writeFileSync(path.join(acksDir, `${opId}.removed`), '1\nmismatched-bytes\n', { mode: 0o644 });
      try {
        publishWorkerPeerRemoval(opId, nodeId, inviteId, wgKey, nodeIp);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('ACK_PAYLOAD_MISMATCH');
      }
    });
  });

  // 5. Service: reconcilePendingOffboardings
  describe('reconcilePendingOffboardings', () => {
    it('processes pending offboardings, calls DB ack on matching peerReady, and unlinks old .peer request', async () => {
      const content = buildRemovalPayload(opId, nodeId, inviteId, wgKey, nodeIp);
      fs.writeFileSync(path.join(acksDir, `${opId}.removed`), content, { mode: 0o644 });

      // Tạo tệp .peer cũ trong requests
      const oldPeerPath = path.join(requestsDir, `${inviteId}.peer`);
      fs.writeFileSync(oldPeerPath, 'old-peer-content', { mode: 0o600 });

      mock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('list_pending_worker_offboardings')) {
          return {
            rows: [{
              operation_id: opId,
              node_id: nodeId,
              invitation_id: inviteId,
              wireguard_public_key: wgKey,
              node_ip: nodeIp,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes('ack_worker_peer_removal')) {
          return { rows: [{ operation_id: opId, lifecycle_state: 'REVOKED' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      await reconcilePendingOffboardings();

      expect(mock.query).toHaveBeenCalledWith(
        'SELECT * FROM public.ack_worker_peer_removal($1, $2, $3, $4, $5::inet)',
        [opId, nodeId, gatewayId, wgKey, nodeIp]
      );
      expect(fs.existsSync(oldPeerPath)).toBe(false);
      // Tombstone .removed vẫn được bảo toàn bền vững
      expect(fs.existsSync(path.join(acksDir, `${opId}.removed`))).toBe(true);
    });

    it('records safe error code into database when peer removal fails or mismatches', async () => {
      fs.writeFileSync(path.join(acksDir, `${opId}.removed`), 'mismatched', { mode: 0o644 });

      mock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('list_pending_worker_offboardings')) {
          return {
            rows: [{
              operation_id: opId,
              node_id: nodeId,
              invitation_id: inviteId,
              wireguard_public_key: wgKey,
              node_ip: nodeIp,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      await reconcilePendingOffboardings();

      expect(mock.query).toHaveBeenCalledWith(
        'SELECT public.record_worker_offboarding_error($1, $2, $3)',
        [opId, gatewayId, 'ACK_PAYLOAD_MISMATCH']
      );
    });
  });

  // 6. Service: revokeNodeAccess & mapSqlOffboardError
  describe('revokeNodeAccess and mapSqlOffboardError', () => {
    it('revokes bastion sessions and tickets for target node', () => {
      revokeNodeAccess(nodeId);
      expect(mock.terminateSessions).toHaveBeenCalledWith(nodeId);
      expect(mock.invalidateTickets).toHaveBeenCalledWith(nodeId);
    });

    it('maps SQL error messages to standardized RFC 7807 codes without exposing raw SQL', () => {
      expect(mapSqlOffboardError(new Error('OFFBOARD_NAME_MISMATCH')).status).toBe(400);
      expect(mapSqlOffboardError(new Error('OFFBOARD_UNAUTHORIZED')).status).toBe(403);
      expect(mapSqlOffboardError(new Error('OFFBOARD_CAPABILITY_INVALID')).status).toBe(401);
      expect(mapSqlOffboardError(new Error('OFFBOARD_NODE_NOT_FOUND')).status).toBe(404);
      expect(mapSqlOffboardError(new Error('OFFBOARD_IDENTITY_UNAVAILABLE')).status).toBe(409);
      expect(mapSqlOffboardError(new Error('OFFBOARD_RECEIPT_CONFLICT')).status).toBe(409);
      expect(mapSqlOffboardError(new Error('unknown pg error')).status).toBe(503);
    });
  });

  // 7. Route: POST /api/nodes/:id/offboarding (ADMIN Start)
  describe('POST /api/nodes/:id/offboarding', () => {
    it('enforces RBAC: 401 on missing auth, 403 on VIEWER', async () => {
      const resNoAuth = await app.inject({
        method: 'POST',
        url: `/api/nodes/${nodeId}/offboarding`,
        payload: { confirm_node_name: 'worker-01' },
      });
      expect(resNoAuth.statusCode).toBe(401);

      const resViewer = await app.inject({
        method: 'POST',
        url: `/api/nodes/${nodeId}/offboarding`,
        headers: { authorization: 'Bearer ' + viewerJwt },
        payload: { confirm_node_name: 'worker-01' },
      });
      expect(resViewer.statusCode).toBe(403);
    });

    it('rejects invalid UUID or malformed payload', async () => {
      const resBadId = await app.inject({
        method: 'POST',
        url: '/api/nodes/invalid-uuid/offboarding',
        headers: { authorization: 'Bearer ' + adminJwt },
        payload: { confirm_node_name: 'worker-01' },
      });
      expect(resBadId.statusCode).toBe(400);

      const resBadBody = await app.inject({
        method: 'POST',
        url: `/api/nodes/${nodeId}/offboarding`,
        headers: { authorization: 'Bearer ' + adminJwt },
        payload: { unexpected_field: 'bad' },
      });
      expect(resBadBody.statusCode).toBe(400);
    });

    it('starts offboarding successfully as ADMIN, returning 202 with Retry-After and no-store headers', async () => {
      mock.query.mockImplementation(async (sql: string, params?: any[]) => {
        if (sql.includes('FROM users')) {
          return {
            rows: [{ id: adminId, username: 'admin-actor', role: 'ADMIN', is_active: true, session_version: 1 }],
            rowCount: 1,
          };
        }
        if (sql.includes('begin_worker_offboarding')) {
          return {
            rows: [{
              operation_id: opId,
              node_id: nodeId,
              node_name: 'worker-01',
              node_ip: nodeIp,
              node_type: 'VM',
              worker_os: 'linux',
              wireguard_public_key: wgKey,
              state: 'PENDING_PEER_REMOVAL',
              created_at: new Date().toISOString(),
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/nodes/${nodeId}/offboarding`,
        headers: { authorization: 'Bearer ' + adminJwt },
        payload: { confirm_node_name: 'worker-01' },
      });

      expect(res.statusCode).toBe(202);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['retry-after']).toBe('3');
      expect(res.json().status).toBe('RETIRING');
      expect(res.json().operation.operation_id).toBe(opId);
      expect(mock.terminateSessions).toHaveBeenCalledWith(nodeId);
    });
  });

  // 8. Route: GET /api/nodes/:id/offboarding (Status)
  describe('GET /api/nodes/:id/offboarding', () => {
    it('allows both ADMIN and VIEWER, returning safe metadata without token secrets', async () => {
      mock.query.mockImplementation(async (sql: string, params?: any[]) => {
        if (sql.includes('FROM users')) {
          return {
            rows: [{ id: viewerId, username: 'viewer-actor', role: 'VIEWER', is_active: true, session_version: 1 }],
            rowCount: 1,
          };
        }
        if (sql.includes('get_worker_offboarding_status')) {
          return {
            rows: [{
              operation_id: opId,
              node_id: nodeId,
              node_name: 'worker-01',
              node_ip: nodeIp,
              wireguard_public_key: wgKey,
              state: 'PENDING_PEER_REMOVAL',
              lifecycle_state: 'RETIRING',
              created_at: new Date().toISOString(),
              peer_removed_at: null,
              completed_at: null,
              last_error: 'ACK_PAYLOAD_MISMATCH',
              has_cleanup_token: true,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/nodes/${nodeId}/offboarding`,
        headers: { authorization: 'Bearer ' + viewerJwt },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const data = res.json().offboarding;
      expect(data.state).toBe('PENDING_PEER_REMOVAL');
      expect(data.last_error).toBe('ACK_PAYLOAD_MISMATCH');
      expect(data.has_cleanup_token).toBe(true);
      expect(data.cleanup_token).toBeUndefined();
      expect(data.cleanup_token_hash).toBeUndefined();
    });

    it('returns 200 with offboarding: null when process not started', async () => {
      mock.query.mockImplementation(async (sql: string, params?: any[]) => {
        if (sql.includes('FROM users')) {
          return {
            rows: [{ id: adminId, username: 'admin-actor', role: 'ADMIN', is_active: true, session_version: 1 }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/nodes/${nodeId}/offboarding`,
        headers: { authorization: 'Bearer ' + adminJwt },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().offboarding).toBeNull();
    });
  });

  // 9. Route: POST /api/nodes/:id/offboarding/authorization (Download capability)
  describe('POST /api/nodes/:id/offboarding/authorization', () => {
    it('enforces ADMIN role and rejects completed operations', async () => {
      mock.query.mockImplementation(async (sql: string, params?: any[]) => {
        if (sql.includes('FROM users')) {
          return {
            rows: [{ id: adminId, username: 'admin-actor', role: 'ADMIN', is_active: true, session_version: 1 }],
            rowCount: 1,
          };
        }
        if (sql.includes('get_worker_offboarding_status')) {
          return { rows: [{ operation_id: opId, state: 'COMPLETED' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/nodes/${nodeId}/offboarding/authorization`,
        headers: { authorization: 'Bearer ' + adminJwt },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('OFFBOARD_ALREADY_COMPLETED');
    });

    it('issues capability bundle, passes only token hash to SQL, and returns attachment', async () => {
      mock.query.mockImplementation(async (sql: string, params?: any[]) => {
        if (sql.includes('FROM users')) {
          return {
            rows: [{ id: adminId, username: 'admin-actor', role: 'ADMIN', is_active: true, session_version: 1 }],
            rowCount: 1,
          };
        }
        if (sql.includes('get_worker_offboarding_status')) {
          return { rows: [{ operation_id: opId, state: 'PENDING_LOCAL_CLEANUP' }], rowCount: 1 };
        }
        if (sql.includes('issue_worker_cleanup_token')) {
          return {
            rows: [{
              operation_id: opId,
              node_id: nodeId,
              node_name: 'worker-01',
              invitation_id: inviteId,
              wireguard_public_key: wgKey,
              node_ip: nodeIp,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/nodes/${nodeId}/offboarding/authorization`,
        headers: { authorization: 'Bearer ' + adminJwt },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-disposition']).toContain('attachment; filename="offboarding-worker-01.json"');

      const bundle = res.json();
      expect(bundle.operation_id).toBe(opId);
      expect(bundle.node_id).toBe(nodeId);
      expect(bundle.cleanup_token).toMatch(/^[0-9a-f]{64}$/);

      // Tham số truyền vào issue_worker_cleanup_token phải là mã băm SHA-256
      const issueCall = mock.query.mock.calls.find(c => c[0].includes('issue_worker_cleanup_token'));
      expect(issueCall).toBeDefined();
      const sqlParams = issueCall![1];
      expect(sqlParams).toContain(crypto.createHash('sha256').update(bundle.cleanup_token).digest('hex'));
      expect(sqlParams).not.toContain(bundle.cleanup_token);
    });
  });

  // 10. Route: POST /api/offboarding/verify (Scoped Public Verify)
  describe('POST /api/offboarding/verify', () => {
    it('requires X-Cleanup-Token header and validates bound identity', async () => {
      const resNoToken = await app.inject({
        method: 'POST',
        url: '/api/offboarding/verify',
        payload: {
          version: 1,
          operation_id: opId,
          gateway_id: gatewayId,
          node_id: nodeId,
          invitation_id: inviteId,
          wireguard_public_key: wgKey,
          node_ip: nodeIp,
        },
      });
      expect(resNoToken.statusCode).toBe(401);

      mock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('verify_worker_cleanup_capability')) {
          return {
            rows: [{
              operation_id: opId,
              node_id: nodeId,
              node_name: 'worker-01',
              node_ip: nodeIp,
              invitation_id: inviteId,
              wireguard_public_key: wgKey,
              state: 'PENDING_LOCAL_CLEANUP',
              lifecycle_state: 'REVOKED',
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const resOk = await app.inject({
        method: 'POST',
        url: '/api/offboarding/verify',
        headers: { 'x-cleanup-token': rawCleanupToken },
        payload: {
          version: 1,
          operation_id: opId,
          gateway_id: gatewayId,
          node_id: nodeId,
          invitation_id: inviteId,
          wireguard_public_key: wgKey,
          node_ip: nodeIp,
        },
      });

      expect(resOk.statusCode).toBe(200);
      expect(resOk.json().operation_id).toBe(opId);
      expect(resOk.json().gateway_id).toBe(gatewayId);
      expect(resOk.json().node_id).toBe(nodeId);
      expect(resOk.json().node_name).toBe('worker-01');
      expect(resOk.json().node_ip).toBe(nodeIp);
      expect(resOk.json().invitation_id).toBe(inviteId);
      expect(resOk.json().wireguard_public_key).toBe(wgKey);
      expect(resOk.json().state).toBe('PENDING_LOCAL_CLEANUP');
      expect(resOk.json().lifecycle_state).toBe('REVOKED');
    });

    it('rejects identity tuple mismatch with 409', async () => {
      mock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('verify_worker_cleanup_capability')) {
          return {
            rows: [{
              operation_id: opId,
              node_id: nodeId,
              invitation_id: inviteId,
              wireguard_public_key: wgKey,
              node_ip: '10.100.0.99', // khác với payload
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const resMismatch = await app.inject({
        method: 'POST',
        url: '/api/offboarding/verify',
        headers: { 'x-cleanup-token': rawCleanupToken },
        payload: {
          version: 1,
          operation_id: opId,
          gateway_id: gatewayId,
          node_id: nodeId,
          invitation_id: inviteId,
          wireguard_public_key: wgKey,
          node_ip: nodeIp,
        },
      });

      expect(resMismatch.statusCode).toBe(409);
      expect(resMismatch.json().code).toBe('OFFBOARD_TUPLE_MISMATCH');
    });
  });

  // 11. Route: POST /api/offboarding/complete (Scoped Public Complete)
  describe('POST /api/offboarding/complete', () => {
    const validReceipt = () => ({
      version: 1 as const,
      operation_id: opId,
      node_id: nodeId,
      gateway_id: gatewayId,
      invitation_id: inviteId,
      wireguard_public_key: wgKey,
      node_ip: nodeIp,
      status: 'COMPLETE' as const,
      receipt: {
        platform: 'linux' as const,
        steps: {
          agent: 'DONE' as const,
          tunnel: 'DONE' as const,
          firewall: 'DONE' as const,
          ssh: 'DONE' as const,
          secrets: 'DONE' as const,
        },
        evidence_digest: 'e'.repeat(64),
      },
    });

    it('requires all 5 steps to be DONE when status is COMPLETE', async () => {
      const incomplete = {
        ...validReceipt(),
        receipt: {
          ...validReceipt().receipt,
          steps: { ...validReceipt().receipt.steps, firewall: 'REVIEW' as const },
        },
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/offboarding/complete',
        headers: { 'x-cleanup-token': rawCleanupToken },
        payload: incomplete,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('OFFBOARD_STEPS_INCOMPLETE');
    });

    it('accepts valid COMPLETE receipt, hashes payload with canonicalJson, and handles idempotent replay', async () => {
      mock.query.mockImplementation(async (sql: string) => {
        if (sql.includes('complete_worker_offboarding')) {
          return {
            rows: [{
              operation_id: opId,
              node_id: nodeId,
              state: 'COMPLETED',
              lifecycle_state: 'REMOVED',
              replayed: false,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });

      const payload = validReceipt();
      const res = await app.inject({
        method: 'POST',
        url: '/api/offboarding/complete',
        headers: { 'x-cleanup-token': rawCleanupToken },
        payload,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().state).toBe('COMPLETED');
      expect(res.json().lifecycle_state).toBe('REMOVED');
      expect(res.json().replayed).toBe(false);

      // Kiểm tra receipt_hash được tính đúng chuẩn canonicalJson
      const completeCall = mock.query.mock.calls.find(c => c[0].includes('complete_worker_offboarding'));
      expect(completeCall).toBeDefined();
      const expectedReceiptHash = crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
      expect(completeCall![1][4]).toBe(expectedReceiptHash);
    });
  });
});
