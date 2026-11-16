import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  query: vi.fn(),
  sendTestAlert: vi.fn(),
  isPaired: vi.fn(), getPairOtp: vi.fn(),
}));

vi.mock('../src/services/db.js', () => ({ query: mock.query }));
vi.mock('../src/services/telegram.js', () => ({
  telegramService: {
    sendTestAlert: mock.sendTestAlert,
    isPaired: mock.isPaired, getPairOtp: mock.getPairOtp,
  },
}));
vi.mock('../src/config/env.js', () => ({ config: { TELEGRAM_MODE: 'live' } }));

import { telegramRoutes } from '../src/routes/telegram.js';

const adminUser = {
  id: '956947db-c94f-453a-8798-908e6a197a3e',
  username: 'test-admin',
  role: 'ADMIN',
  is_active: true,
  session_version: 1,
};

const viewerUser = {
  id: '8a123456-c94f-453a-8798-908e6a197a3f',
  username: 'test-viewer',
  role: 'VIEWER',
  is_active: true,
  session_version: 1,
};

let app: FastifyInstance;
let adminToken: string;
let viewerToken: string;

beforeEach(async () => {
  vi.clearAllMocks();
  mock.isPaired.mockReturnValue(false); mock.getPairOtp.mockReturnValue('isolated-pairing-fixture');
  mock.query.mockImplementation(async (sql: string, params?: any[]) => {
    if (sql.includes('FROM users WHERE id')) {
      const id = params?.[0];
      if (id === viewerUser.id) return { rows: [{ ...viewerUser }], rowCount: 1 };
      return { rows: [{ ...adminUser }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });

  mock.sendTestAlert.mockResolvedValue({
    success: true,
    dryRun: false,
  });

  app = Fastify();
  await app.register(jwt, {
    secret: 'isolated-route-test-secret-at-least-32-characters',
    sign: { algorithm: 'HS256' },
    verify: { algorithms: ['HS256'] },
  });
  await app.register(telegramRoutes, { prefix: '/api/telegram' });

  adminToken = app.jwt.sign({
    id: adminUser.id,
    username: adminUser.username,
    role: adminUser.role,
    session_version: 1,
  });

  viewerToken = app.jwt.sign({
    id: viewerUser.id,
    username: viewerUser.username,
    role: viewerUser.role,
    session_version: 1,
  });
});

it('pairing information requires Admin, is no-store, and hides OTP once paired', async () => {
  expect((await app.inject('/api/telegram/pairing')).statusCode).toBe(401);
  const forbidden = await app.inject({ url: '/api/telegram/pairing', headers: { authorization: `Bearer ${viewerToken}` } });
  expect(forbidden.statusCode).toBe(403);
  expect(mock.getPairOtp).not.toHaveBeenCalled();
  const allowed = await app.inject({ url: '/api/telegram/pairing', headers: { authorization: `Bearer ${adminToken}` } });
  expect(allowed.headers['cache-control']).toBe('no-store');
  expect(allowed.json()).toEqual({ mode: 'live', paired: false, otp: 'isolated-pairing-fixture' });
  mock.isPaired.mockReturnValue(true);
  const paired = await app.inject({ url: '/api/telegram/pairing', headers: { authorization: `Bearer ${adminToken}` } });
  expect(paired.json().otp).toBeNull();
  expect(mock.getPairOtp).toHaveBeenCalledTimes(1);
});

afterEach(async () => {
  await app.close();
});

describe('Telegram Test Alert API', () => {
  it('requires authentication and rejects unauthenticated request with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/telegram/test',
    });
    expect(res.statusCode).toBe(401);
    expect(mock.sendTestAlert).not.toHaveBeenCalled();
  });

  it('allows an ADMIN to send test alert and records TELEGRAM_TEST in audit_logs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/telegram/test',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.dryRun).toBe(false);
    expect(mock.sendTestAlert).toHaveBeenCalledWith(adminUser.username, adminUser.role);

    // Kiểm tra ghi vào audit_logs với action TELEGRAM_TEST
    const auditInsert = mock.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO audit_logs') && sql.includes('TELEGRAM_TEST')
    );
    expect(auditInsert).toBeDefined();

    // Tuyệt đối không chạm bảng alerts
    const alertInsert = mock.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO alerts')
    );
    expect(alertInsert).toBeUndefined();
  });

  it('enforces rate limit and rejects rapid duplicate submissions with 429', async () => {
    // Cuộc gọi thứ 2 liên tiếp ngay sau cuộc gọi trước đó
    const res = await app.inject({
      method: 'POST',
      url: '/api/telegram/test',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('handles dry-run mode and returns dryRun: true', async () => {
    mock.sendTestAlert.mockResolvedValueOnce({
      success: true,
      dryRun: true,
      reason: 'Đang ở chế độ giả lập dry-run',
    });

    // Mock Date.now() nhảy qua 16 giây
    const realDateNow = Date.now;
    try {
      Date.now = () => realDateNow() + 20000;
      const res = await app.inject({
        method: 'POST',
        url: '/api/telegram/test',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.dryRun).toBe(true);
      expect(body.message).toContain('giả lập');
    } finally {
      Date.now = realDateNow;
    }
  });

  it('handles unconfigured or failed telegram gracefully with 400', async () => {
    mock.sendTestAlert.mockResolvedValueOnce({
      success: false,
      dryRun: false,
      reason: 'Chưa cấu hình Telegram',
    });

    const realDateNow = Date.now;
    try {
      Date.now = () => realDateNow() + 40000;
      const res = await app.inject({
        method: 'POST',
        url: '/api/telegram/test',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe('TELEGRAM_TEST_FAILED');
      expect(body.detail).toContain('Chưa cấu hình');
    } finally {
      Date.now = realDateNow;
    }
  });
});
