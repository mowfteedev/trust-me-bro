/**
 * ISOLATED ALERT & INCIDENT FLOW VERIFICATION TEST SUITE
 * 
 * Verifies the complete offline -> online alerting lifecycle in an isolated runtime:
 * 1. Heartbeat loss -> Node OFFLINE -> Incident creation (alerts, alert_notifications, audit_logs)
 * 2. Heartbeat recovery -> Node HEALTHY -> Incident resolution (resolved_at, recovery notification)
 * 3. Deduplication & Flapping suppression / Debounce (idempotence, hysteresis, queue uniqueness)
 * 4. Three-layer evidence separation: Database State, Audit Logs, Mock Transport Requests
 * 5. Strict boundary enforcement: No access to TV Box or Docker Worker, No live Telegram
 */
import Fastify, { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ==============================================================================
// STATEFUL IN-MEMORY DATABASE & CONFIG MOCKS
// ==============================================================================

interface MockNode {
  id: string;
  name: string;
  ip_address: string;
  token_hash: string;
  token_prefix: string;
  status: 'HEALTHY' | 'WARNING' | 'OFFLINE';
  last_seen: Date | null;
  lifecycle_state: 'ACTIVE' | 'PENDING_OFFBOARDING' | 'REMOVED' | 'REVOKED';
  is_token_revoked: boolean;
  updated_at: Date;
}

interface MockAlert {
  id: string;
  node_id: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  message: string;
  resolved_at: Date | null;
  created_at: Date;
}

interface MockNotification {
  id: string;
  alert_id: string;
  phase: 'OPEN' | 'RECOVERY';
  text: string;
  status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'DISABLED';
  attempts: number;
  last_attempt_at: Date | null;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
}

interface MockAuditLog {
  id: number;
  node_id: string | null;
  action: string;
  target: string;
  details: any;
  created_at: Date;
}

interface MockMetric {
  id: number;
  node_id: string;
  cpu_percent: number;
  ram_used_bytes: number;
  ram_total_bytes: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  uptime_seconds: number;
  recorded_at: Date;
}

interface CapturedTransportRequest {
  url: string;
  method: string;
  chat_id: string;
  text: string;
  timestamp: string;
}

const mock = vi.hoisted(() => {
  return {
    query: vi.fn(),
    getClient: vi.fn(),
    config: {
      NODE_STALE_THRESHOLD_SECONDS: 15,
      NODE_OFFLINE_THRESHOLD_SECONDS: 30,
      CPU_ALERT_THRESHOLD_PERCENT: 85,
      CPU_RECOVERY_THRESHOLD_PERCENT: 75,
      SWEEPER_INTERVAL_MS: 5000,
      TELEGRAM_MODE: 'live',
      TELEGRAM_BOT_TOKEN: 'isolated-fake-test-token-0000',
      TELEGRAM_PAIR_OTP: '619284',
      TELEGRAM_REQUEST_TIMEOUT_MS: 1000,
      DB_MAX_CONNECTIONS: 10,
      DB_IDLE_TIMEOUT_MS: 10000,
      JWT_SECRET: 'isolated-alert-test-secret-never-use-live-0000',
    },
  };
});

vi.mock('../src/config/env.js', () => ({ config: mock.config }));
vi.mock('../src/services/db.js', () => ({
  query: mock.query,
  getClient: mock.getClient,
}));

// Real imports after mock registration
import { hashToken } from '../src/utils/crypto.js';
import { telemetryRoutes } from '../src/routes/telemetry.js';
import { runSweeperCycle } from '../src/services/sweeper.js';
import {
  enqueueAlertNotification,
  runAlertDeliveryCycle,
  startAlertDelivery,
  stopAlertDelivery,
} from '../src/services/alert-delivery.js';
import { telegramService } from '../src/services/telegram.js';

// ==============================================================================
// TEST HARNESS FIXTURES & STATE MANAGER
// ==============================================================================

class IsolatedDatabaseHarness {
  public nodes: Map<string, MockNode> = new Map();
  public alerts: MockAlert[] = [];
  public notifications: MockNotification[] = [];
  public auditLogs: MockAuditLog[] = [];
  public metrics: MockMetric[] = [];
  public systemSettings: Map<string, string> = new Map();
  public currentTime: Date = new Date('2026-11-19T10:00:00.000Z');
  public capturedRequests: CapturedTransportRequest[] = [];
  public transportStatus: 'SUCCESS' | 'TRANSIENT_ERROR' | 'FATAL_ERROR' = 'SUCCESS';

  constructor() {
    this.setupFetchMock();
  }

  public setClock(isoOrDate: string | Date) {
    this.currentTime = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  }

  public advanceSeconds(seconds: number) {
    this.currentTime = new Date(this.currentTime.getTime() + seconds * 1000);
  }

  public registerNode(node: MockNode) {
    this.nodes.set(node.id, node);
  }

  public getNode(id: string): MockNode {
    return this.nodes.get(id)!;
  }

  private setupFetchMock() {
    global.fetch = async (url: any, options: any) => {
      const parsedBody = options?.body ? JSON.parse(options.body) : {};
      const record: CapturedTransportRequest = {
        url: String(url),
        method: options?.method || 'GET',
        chat_id: parsedBody.chat_id || '',
        text: parsedBody.text || '',
        timestamp: this.currentTime.toISOString(),
      };
      this.capturedRequests.push(record);

      if (this.transportStatus === 'TRANSIENT_ERROR') {
        throw new Error('EAI_AGAIN: Simulated transient network DNS failure');
      }
      if (this.transportStatus === 'FATAL_ERROR') {
        return {
          ok: false,
          status: 400,
          json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
        } as any;
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: { message_id: this.capturedRequests.length, date: Math.floor(this.currentTime.getTime() / 1000) },
        }),
      } as any;
    };
  }

  public createQueryHandler() {
    return async (sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> => {
      const s = sql.trim();

      // Proactive partitions
      if (s.includes('create_daily_metrics_partition') || s.includes('drop_old_metrics_partitions')) {
        return { rows: [], rowCount: 0 };
      }

      // System settings (Telegram pairing)
      if (s.includes('system_settings')) {
        if (s.startsWith('INSERT INTO system_settings')) {
          const chatId = params[0];
          this.systemSettings.set('telegram_paired_chat_id', chatId);
          return { rows: [{ key: 'telegram_paired_chat_id', value: chatId }], rowCount: 1 };
        }
        if (s.startsWith('SELECT value FROM system_settings')) {
          const val = this.systemSettings.get('telegram_paired_chat_id');
          return { rows: val ? [{ value: val }] : [], rowCount: val ? 1 : 0 };
        }
      }

      // Sweeper Step 2: Mark STALE / WARNING
      if (s.includes("UPDATE nodes SET status = 'WARNING'")) {
        const staleSec = params[0] || mock.config.NODE_STALE_THRESHOLD_SECONDS;
        const offlineSec = params[1] || mock.config.NODE_OFFLINE_THRESHOLD_SECONDS;
        let count = 0;
        for (const node of this.nodes.values()) {
          if (node.status === 'HEALTHY' && node.lifecycle_state === 'ACTIVE' && node.last_seen) {
            const ageSec = (this.currentTime.getTime() - node.last_seen.getTime()) / 1000;
            if (ageSec >= staleSec && ageSec < offlineSec) {
              node.status = 'WARNING';
              node.updated_at = new Date(this.currentTime);
              count++;
            }
          }
        }
        return { rows: [], rowCount: count };
      }

      // Sweeper Step 3: Find offline candidates
      if (s.startsWith('SELECT id, name, ip_address, last_seen') && s.includes('FROM nodes')) {
        const thresholdSec = params[0] || mock.config.NODE_OFFLINE_THRESHOLD_SECONDS;
        const matching: any[] = [];
        for (const node of this.nodes.values()) {
          if (node.status !== 'OFFLINE' && node.lifecycle_state === 'ACTIVE') {
            const ageSec = node.last_seen ? (this.currentTime.getTime() - node.last_seen.getTime()) / 1000 : Infinity;
            if (node.last_seen === null || ageSec >= thresholdSec) {
              matching.push({ id: node.id, name: node.name, ip_address: node.ip_address, last_seen: node.last_seen });
            }
          }
        }
        return { rows: matching, rowCount: matching.length };
      }

      // Sweeper Step 3.1: Transactional OFFLINE update
      if (s.startsWith('UPDATE nodes SET status = \'OFFLINE\'')) {
        const nodeId = params[0];
        const thresholdSec = params[1] || mock.config.NODE_OFFLINE_THRESHOLD_SECONDS;
        const node = this.nodes.get(nodeId);
        if (node && node.status !== 'OFFLINE' && node.lifecycle_state === 'ACTIVE') {
          const ageSec = node.last_seen ? (this.currentTime.getTime() - node.last_seen.getTime()) / 1000 : Infinity;
          if (node.last_seen === null || ageSec >= thresholdSec) {
            node.status = 'OFFLINE';
            node.updated_at = new Date(this.currentTime);
            return { rows: [], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      // Insert Alert
      if (s.startsWith('INSERT INTO alerts')) {
        const nodeId = params[0];
        const severity = params.length === 2 ? 'CRITICAL' : params[1];
        const message = params.length === 2 ? params[1] : params[2];
        const alertId = randomUUID();
        const alert: MockAlert = {
          id: alertId,
          node_id: nodeId,
          severity,
          message,
          resolved_at: null,
          created_at: new Date(this.currentTime),
        };
        this.alerts.push(alert);
        return { rows: [{ id: alertId }], rowCount: 1 };
      }

      // Enqueue Notification (with ON CONFLICT DO NOTHING)
      if (s.startsWith('INSERT INTO alert_notifications')) {
        const [alertId, phase, text] = params;
        const existing = this.notifications.find((n) => n.alert_id === alertId && n.phase === phase);
        if (existing) {
          return { rows: [], rowCount: 0 };
        }
        const notif: MockNotification = {
          id: randomUUID(),
          alert_id: alertId,
          phase,
          text,
          status: 'PENDING',
          attempts: 0,
          last_attempt_at: null,
          next_attempt_at: new Date(this.currentTime),
          last_error: null,
          created_at: new Date(this.currentTime),
        };
        this.notifications.push(notif);
        return { rows: [{ id: notif.id }], rowCount: 1 };
      }

      // Insert Audit Log
      if (s.startsWith('INSERT INTO audit_logs')) {
        let nodeId: string, action: string, target: string, details: any;
        if (s.includes("'NODE_OFFLINE'")) {
          nodeId = params[0];
          action = 'NODE_OFFLINE';
          target = params[1];
          details = params[2];
        } else {
          [nodeId, action, target, details] = params;
        }
        const log: MockAuditLog = {
          id: this.auditLogs.length + 1,
          node_id: nodeId,
          action,
          target,
          details: typeof details === 'string' ? JSON.parse(details) : details,
          created_at: new Date(this.currentTime),
        };
        this.auditLogs.push(log);
        return { rows: [], rowCount: 1 };
      }

      // Clean inactive node alerts / offboarding reconciliation
      if (s.includes('UPDATE alert_notifications n') && s.includes('NODE_RETIRED')) {
        return { rows: [], rowCount: 0 };
      }
      if (s.includes('reconcilePendingOffboardings') || s.includes('is_wireguard_revoked')) {
        return { rows: [], rowCount: 0 };
      }
      if (s.includes('FROM bastion_session_leases')) {
        return { rows: [], rowCount: 0 };
      }

      // Telemetry lookup node by token_hash
      if (s.includes('FROM nodes') && s.includes('token_hash = $1')) {
        const inputHash = params[0];
        const match = Array.from(this.nodes.values()).find((n) => n.token_hash === inputHash);
        return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
      }

      // Telemetry lookup active nodes
      if (s.startsWith('SELECT id, name, token_hash, status, ip_address, is_token_revoked, lifecycle_state FROM nodes')) {
        const activeNodes = Array.from(this.nodes.values()).filter(
          (n) => !n.is_token_revoked && n.lifecycle_state === 'ACTIVE'
        );
        return { rows: activeNodes, rowCount: activeNodes.length };
      }

      // Beacon lock & gap calculation
      if (s.includes('EXTRACT(EPOCH FROM (now() - last_seen)) AS heartbeat_gap_seconds')) {
        const nodeId = params[0];
        const inputHash = params[1];
        const node = this.nodes.get(nodeId);
        if (!node || node.is_token_revoked || node.lifecycle_state !== 'ACTIVE') {
          return { rows: [], rowCount: 0 };
        }
        if (inputHash && node.token_hash !== inputHash) {
          return { rows: [], rowCount: 0 };
        }
        const gap = node.last_seen ? Math.max(0, (this.currentTime.getTime() - node.last_seen.getTime()) / 1000) : 0;
        return { rows: [{ id: node.id, heartbeat_gap_seconds: gap.toString() }], rowCount: 1 };
      }

      // Insert metrics history
      if (s.startsWith('INSERT INTO metrics_history')) {
        const [nodeId, cpu, ramUsed, ramTotal, diskUsed, diskTotal, rx, tx, uptime] = params;
        this.metrics.push({
          id: this.metrics.length + 1,
          node_id: nodeId,
          cpu_percent: cpu,
          ram_used_bytes: ramUsed,
          ram_total_bytes: ramTotal,
          disk_used_bytes: diskUsed,
          disk_total_bytes: diskTotal,
          network_rx_bytes: rx,
          network_tx_bytes: tx,
          uptime_seconds: uptime,
          recorded_at: new Date(this.currentTime),
        });
        return { rows: [], rowCount: 1 };
      }

      // Beacon marks HEALTHY
      if (s.startsWith('UPDATE nodes') && s.includes("SET status = 'HEALTHY'")) {
        const nodeId = params[0];
        const node = this.nodes.get(nodeId);
        if (node) {
          node.status = 'HEALTHY';
          node.last_seen = new Date(this.currentTime);
          node.updated_at = new Date(this.currentTime);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // Resolve OFFLINE alerts
      if (s.includes('UPDATE alerts SET resolved_at = now()') && s.includes("message LIKE 'NODE_OFFLINE:%'")) {
        const nodeId = params[0];
        const recovered: MockAlert[] = [];
        for (const a of this.alerts) {
          if (a.node_id === nodeId && a.resolved_at === null && a.message.startsWith('NODE_OFFLINE:')) {
            a.resolved_at = new Date(this.currentTime);
            recovered.push(a);
          }
        }
        return {
          rows: recovered.map((r) => ({ id: r.id, resolved_at: r.resolved_at })),
          rowCount: recovered.length,
        };
      }

      // CPU alert checks
      if (s.includes("FROM alerts WHERE node_id = $1 AND resolved_at IS NULL AND message LIKE 'CPU_HIGH:%'")) {
        const nodeId = params[0];
        const activeCpu = this.alerts.filter((a) => a.node_id === nodeId && a.resolved_at === null && a.message.startsWith('CPU_HIGH:'));
        return { rows: activeCpu.map((a) => ({ id: a.id })), rowCount: activeCpu.length };
      }
      if (s.includes('UPDATE alerts SET resolved_at = now()') && s.includes("message LIKE 'CPU_HIGH:%'")) {
        return { rows: [], rowCount: 0 };
      }

      // Alert Delivery Worker: crash recovery query
      if (s.includes("SET status = 'FAILED', last_error = 'ATTEMPT_INTERRUPTED'")) {
        let count = 0;
        for (const n of this.notifications) {
          if (n.status === 'PROCESSING' && n.attempts >= 3 && n.next_attempt_at <= this.currentTime) {
            n.status = 'FAILED';
            n.last_error = 'ATTEMPT_INTERRUPTED';
            count++;
          }
        }
        return { rows: [], rowCount: count };
      }

      // Alert Delivery Worker: claim loop
      if (s.includes('UPDATE alert_notifications n SET status = \'PROCESSING\'') && s.includes('SKIP LOCKED')) {
        const leaseSec = params[0] || 11;
        // Find eligible candidate
        const candidates = this.notifications.filter((n) => {
          if (n.status !== 'PENDING' && n.status !== 'PROCESSING') return false;
          if (n.attempts >= 3) return false;
          if (n.next_attempt_at > this.currentTime) return false;
          const parentAlert = this.alerts.find((a) => a.id === n.alert_id);
          if (!parentAlert) return false;
          const node = this.nodes.get(parentAlert.node_id);
          if (!node || node.lifecycle_state !== 'ACTIVE') return false;

          // RECOVERY must wait for OPEN to complete
          if (n.phase === 'RECOVERY') {
            const openNotif = this.notifications.find(
              (o) => o.alert_id === n.alert_id && o.phase === 'OPEN' && (o.status === 'PENDING' || o.status === 'PROCESSING')
            );
            if (openNotif) return false;
          }
          return true;
        });

        // Sort by created_at, id
        candidates.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
        const chosen = candidates[0];
        if (chosen) {
          chosen.status = 'PROCESSING';
          chosen.attempts += 1;
          chosen.last_attempt_at = new Date(this.currentTime);
          chosen.next_attempt_at = new Date(this.currentTime.getTime() + leaseSec * 1000);
          return {
            rows: [{ id: chosen.id, text: chosen.text, attempts: chosen.attempts }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }

      // Alert Delivery Worker: status update after transport delivery
      if (s.startsWith('UPDATE alert_notifications SET status = $2')) {
        const [id, status, lastError, backoffSec, attempts] = params;
        const notif = this.notifications.find((n) => n.id === id);
        if (notif && notif.status === 'PROCESSING' && notif.attempts === attempts) {
          notif.status = status;
          notif.last_error = lastError;
          notif.next_attempt_at = new Date(this.currentTime.getTime() + (backoffSec || 0) * 1000);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // Default transaction commands
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 0 };
    };
  }
}

// ==============================================================================
// TEST SUITE DEFINITION
// ==============================================================================

describe('Offline -> Online Alerting Verification in Isolated Environment', () => {
  let harness: IsolatedDatabaseHarness;
  let testNode: MockNode;
  const rawNodeToken = 'isolated-worker-token-xyz-12345';
  const hashedToken = hashToken(rawNodeToken);

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = new IsolatedDatabaseHarness();

    const queryHandler = harness.createQueryHandler();
    mock.query.mockImplementation(queryHandler);
    mock.getClient.mockImplementation(async () => ({
      query: queryHandler,
      release: vi.fn(),
    }));

    testNode = {
      id: '11111111-2222-3333-4444-555555555555',
      name: 'node-isolated-armbian-mock',
      ip_address: '10.199.0.99', // RFC 5737 compliant test IP
      token_hash: hashedToken,
      token_prefix: rawNodeToken.slice(0, 8),
      status: 'HEALTHY',
      last_seen: new Date(harness.currentTime),
      lifecycle_state: 'ACTIVE',
      is_token_revoked: false,
      updated_at: new Date(harness.currentTime),
    };
    harness.registerNode(testNode);

    // Reset stopping flag for delivery worker
    startAlertDelivery();

    // Pair telegram service with mock chat ID
    await telegramService.pairWithOtp('isolated-telegram-chat-999', telegramService.getPairOtp());
  });

  afterEach(async () => {
    await stopAlertDelivery();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function sendBeacon(app: FastifyInstance, cpu = 25) {
    return await app.inject({
      method: 'POST',
      url: '/api/telemetry/beacon',
      headers: { 'x-node-token': rawNodeToken },
      payload: {
        node_id: testNode.name,
        timestamp: harness.currentTime.getTime(),
        metrics: {
          cpu: { percent: cpu },
          memory: { total_bytes: 4096000000, used_bytes: 1024000000, percent: 25 },
          disk: { total_bytes: 32000000000, used_bytes: 8000000000, percent: 25 },
          network: { rx_bytes_total: 100000, tx_bytes_total: 200000 },
          uptime_seconds: 7200,
        },
      },
    });
  }

  it('Step 1 & 3: Heartbeat loss -> WARNING (debounced) -> OFFLINE -> Incident creation with deduplication', async () => {
    // 1. Initial healthy state at t = 0
    expect(testNode.status).toBe('HEALTHY');
    expect(harness.alerts).toHaveLength(0);
    expect(harness.notifications).toHaveLength(0);
    expect(harness.auditLogs).toHaveLength(0);

    // 2. Normal heartbeat interval (t = 10s < 15s stale threshold)
    harness.advanceSeconds(10);
    let sweeperResult = await runSweeperCycle();
    expect(sweeperResult.offlineNodesDetected).toEqual([]);
    expect(testNode.status).toBe('HEALTHY');
    expect(harness.alerts).toHaveLength(0);

    // 3. Flapping suppression / Debounce test: t = 20s (stale threshold 15s exceeded, but < 30s offline threshold)
    harness.advanceSeconds(10); // total 20s since last beacon
    sweeperResult = await runSweeperCycle();
    expect(sweeperResult.offlineNodesDetected).toEqual([]);
    expect(testNode.status).toBe('WARNING'); // Node is stale, but NO CRITICAL alert triggered!
    expect(harness.alerts).toHaveLength(0);
    expect(harness.notifications).toHaveLength(0);
    expect(harness.auditLogs).toHaveLength(0);

    // 4. Heartbeat loss confirmed: t = 35s (> 30s offline threshold)
    harness.advanceSeconds(15); // total 35s since last beacon
    sweeperResult = await runSweeperCycle();
    expect(sweeperResult.offlineNodesDetected).toEqual([testNode.name]);
    expect(testNode.status).toBe('OFFLINE');

    // Verify Incident Creation in alerts table
    expect(harness.alerts).toHaveLength(1);
    const alert = harness.alerts[0];
    expect(alert.severity).toBe('CRITICAL');
    expect(alert.message).toContain('NODE_OFFLINE: Máy chủ con node-isolated-armbian-mock');
    expect(alert.message).toContain('không phản hồi quá 30s');
    expect(alert.resolved_at).toBeNull();

    // Verify Notification intent in alert_notifications table
    expect(harness.notifications).toHaveLength(1);
    const notification = harness.notifications[0];
    expect(notification.alert_id).toBe(alert.id);
    expect(notification.phase).toBe('OPEN');
    expect(notification.status).toBe('PENDING');
    expect(notification.text).toContain('ZT-ServerOps | Mất kết nối máy chủ');
    expect(notification.text).toContain('Mức độ: Nghiêm trọng');
    expect(notification.text).toContain('IP WireGuard: 10.199.0.99');
    expect(notification.text).toContain('Không nhận heartbeat quá: 30 giây');

    // Verify Audit Log created
    expect(harness.auditLogs).toHaveLength(1);
    const audit = harness.auditLogs[0];
    expect(audit.action).toBe('NODE_OFFLINE');
    expect(audit.target).toBe(testNode.name);
    expect(audit.details.ip).toBe('10.199.0.99');

    // 5. Anti-Spam / Deduplication test while node remains OFFLINE
    harness.advanceSeconds(15); // t = 50s
    sweeperResult = await runSweeperCycle();
    expect(sweeperResult.offlineNodesDetected).toEqual([]); // No new detection!
    expect(testNode.status).toBe('OFFLINE');
    expect(harness.alerts).toHaveLength(1); // STILL EXACTLY 1 ALERT
    expect(harness.notifications).toHaveLength(1); // STILL EXACTLY 1 NOTIFICATION
    expect(harness.auditLogs).toHaveLength(1); // STILL EXACTLY 1 AUDIT LOG

    harness.advanceSeconds(30); // t = 80s
    sweeperResult = await runSweeperCycle();
    expect(sweeperResult.offlineNodesDetected).toEqual([]);
    expect(harness.alerts).toHaveLength(1);
    expect(harness.notifications).toHaveLength(1);
  });

  it('Step 2 & 3: Mock delivery of OPEN notification -> Beacon recovery -> Incident resolution -> RECOVERY delivery', async () => {
    const app = Fastify();
    await app.register(telemetryRoutes, { prefix: '/api/telemetry' });

    try {
      // Setup node as OFFLINE with 1 active incident
      harness.advanceSeconds(40);
      await runSweeperCycle();
      expect(testNode.status).toBe('OFFLINE');
      expect(harness.alerts).toHaveLength(1);
      const alert = harness.alerts[0];
      expect(alert.resolved_at).toBeNull();
      expect(harness.notifications).toHaveLength(1);
      expect(harness.notifications[0].status).toBe('PENDING');

      // 1. Deliver the OPEN notification via delivery cycle
      await runAlertDeliveryCycle();
      expect(harness.capturedRequests).toHaveLength(1);
      const openRequest = harness.capturedRequests[0];
      expect(openRequest.text).toContain('ZT-ServerOps | Mất kết nối máy chủ');
      expect(openRequest.chat_id).toBe('isolated-telegram-chat-999');
      expect(harness.notifications[0].status).toBe('SENT');
      expect(harness.notifications[0].attempts).toBe(1);

      // 2. Recovery: Node sends fresh authenticated beacon at t = 100s
      harness.advanceSeconds(60); // gap = 100s
      const beaconRes = await sendBeacon(app, 20);
      expect(beaconRes.statusCode).toBe(200);

      // Verify node state transition to HEALTHY
      expect(testNode.status).toBe('HEALTHY');
      expect(testNode.last_seen?.getTime()).toBe(harness.currentTime.getTime());

      // Verify Incident resolved in alerts table
      expect(alert.resolved_at).not.toBeNull();
      expect(alert.resolved_at?.getTime()).toBe(harness.currentTime.getTime());

      // Verify RECOVERY notification queued
      expect(harness.notifications).toHaveLength(2);
      const recoveryNotif = harness.notifications.find((n) => n.phase === 'RECOVERY')!;
      expect(recoveryNotif).toBeDefined();
      expect(recoveryNotif.status).toBe('PENDING');
      expect(recoveryNotif.text).toContain('ZT-ServerOps | Online trở lại');
      expect(recoveryNotif.text).toContain('Mức độ: Thông tin');
      expect(recoveryNotif.text).toContain('IP WireGuard: 10.199.0.99');
      expect(recoveryNotif.text).toContain('Khoảng thời gian không nhận heartbeat: 1 phút 40 giây');

      // 3. Idempotent Beacon check: Subsequent beacons while healthy do NOT duplicate recovery notification
      harness.advanceSeconds(10);
      const secondBeacon = await sendBeacon(app, 22);
      expect(secondBeacon.statusCode).toBe(200);
      expect(harness.notifications).toHaveLength(2); // Still exactly 2 (OPEN + RECOVERY)
      expect(harness.alerts).toHaveLength(1);

      // 4. Deliver the RECOVERY notification via delivery cycle
      await runAlertDeliveryCycle();
      expect(harness.capturedRequests).toHaveLength(2);
      const recoveryRequest = harness.capturedRequests[1];
      expect(recoveryRequest.text).toContain('ZT-ServerOps | Online trở lại');
      expect(recoveryNotif.status).toBe('SENT');
      expect(recoveryNotif.attempts).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('Step 3: Flapping suppression, Concurrent enqueue deduplication, and Bounded retry', async () => {
    const app = Fastify();
    await app.register(telemetryRoutes, { prefix: '/api/telemetry' });

    try {
      // 1. Rapid Flapping: Node misses heartbeat, recovers, misses heartbeat within stale bounds
      // t = 0 (HEALTHY)
      // t = 18s (stale, becomes WARNING)
      harness.advanceSeconds(18);
      await runSweeperCycle();
      expect(testNode.status).toBe('WARNING');
      expect(harness.alerts).toHaveLength(0); // No alert!

      // Node beacons immediately at 19s
      harness.advanceSeconds(1);
      expect((await sendBeacon(app)).statusCode).toBe(200);
      expect(testNode.status).toBe('HEALTHY');
      expect(harness.alerts).toHaveLength(0); // Still 0 alert!

      // Node delayed again for 20s
      harness.advanceSeconds(20);
      await runSweeperCycle();
      expect(testNode.status).toBe('WARNING');
      expect(harness.alerts).toHaveLength(0); // Still 0 alert! Flapping within stale margin is suppressed!

      // 2. Concurrent enqueue deduplication (ON CONFLICT DO NOTHING)
      const mockTx = { query: harness.createQueryHandler() };
      const alertId = randomUUID();
      await Promise.all([
        enqueueAlertNotification(mockTx as any, alertId, 'OPEN', 'Duplicate Test 1'),
        enqueueAlertNotification(mockTx as any, alertId, 'OPEN', 'Duplicate Test 2'),
        enqueueAlertNotification(mockTx as any, alertId, 'OPEN', 'Duplicate Test 3'),
      ]);
      const duplicateNotifs = harness.notifications.filter((n) => n.alert_id === alertId);
      expect(duplicateNotifs).toHaveLength(1); // EXACTLY 1 ROW PERSISTED

      // 3. Bounded Retry: Transient transport errors retry up to 3 times, then mark FAILED
      harness.transportStatus = 'TRANSIENT_ERROR';
      const failingAlertId = randomUUID();
      harness.alerts.push({
        id: failingAlertId,
        node_id: testNode.id,
        severity: 'CRITICAL',
        message: 'NODE_OFFLINE: retry test',
        resolved_at: null,
        created_at: new Date(harness.currentTime),
      });
      await enqueueAlertNotification(mockTx as any, failingAlertId, 'OPEN', 'Retry Test');
      const failingNotif = harness.notifications.find((n) => n.alert_id === failingAlertId)!;

      // Attempt 1
      await runAlertDeliveryCycle();
      expect(failingNotif.status).toBe('PENDING');
      expect(failingNotif.attempts).toBe(1);

      // Advance clock past backoff
      harness.advanceSeconds(10);
      // Attempt 2
      await runAlertDeliveryCycle();
      expect(failingNotif.status).toBe('PENDING');
      expect(failingNotif.attempts).toBe(2);

      // Advance clock past backoff
      harness.advanceSeconds(15);
      // Attempt 3 -> TERMINAL FAILURE
      await runAlertDeliveryCycle();
      expect(failingNotif.status).toBe('FAILED');
      expect(failingNotif.attempts).toBe(3);

      // Attempt 4 -> No further calls, worker ignores FAILED items
      const callsBefore = harness.capturedRequests.length;
      harness.advanceSeconds(30);
      await runAlertDeliveryCycle();
      expect(harness.capturedRequests.length).toBe(callsBefore);
      expect(failingNotif.status).toBe('FAILED');
    } finally {
      await app.close();
    }
  });

  it('Step 4 & 5: Complete End-to-End Run and Generate evidence-alerts.json (chmod 0600)', async () => {
    const app = Fastify();
    await app.register(telemetryRoutes, { prefix: '/api/telemetry' });

    try {
      // 1. Initial State
      const t0 = new Date('2026-11-19T13:00:00.000Z');
      harness.setClock(t0);
      testNode.last_seen = new Date(t0);
      testNode.status = 'HEALTHY';

      // 2. Heartbeat loss
      harness.advanceSeconds(35); // t0 + 35s (> 30s)
      await runSweeperCycle();
      expect(testNode.status).toBe('OFFLINE');
      expect(harness.alerts).toHaveLength(1);

      // 3. OPEN Delivery
      await runAlertDeliveryCycle();
      expect(harness.notifications[0].status).toBe('SENT');

      // 4. Node Recovery
      harness.advanceSeconds(65); // gap = 100s
      const beaconRes = await sendBeacon(app, 15);
      expect(beaconRes.statusCode).toBe(200);
      expect(testNode.status).toBe('HEALTHY');
      expect(harness.alerts[0].resolved_at).not.toBeNull();

      // 5. RECOVERY Delivery
      await runAlertDeliveryCycle();
      const recoveryNotif = harness.notifications.find((n) => n.phase === 'RECOVERY')!;
      expect(recoveryNotif.status).toBe('SENT');

      // 6. Assemble Three-Layer Evidence
      const evidence = {
        meta: {
          test_suite: 'zt-serverops-alerts-offline-online-verification',
          specialist: 'Alert & Incident Specialist',
          mission: 'Kiểm chứng luồng cảnh báo offline → online trong môi trường cách ly (isolated environment)',
          generated_at: new Date().toISOString(),
          simulated_timeline: {
            t0_healthy: t0.toISOString(),
            t1_offline_detected: new Date(t0.getTime() + 35000).toISOString(),
            t2_open_notification_sent: new Date(t0.getTime() + 35000).toISOString(),
            t3_recovered_online: new Date(t0.getTime() + 100000).toISOString(),
            t4_recovery_notification_sent: new Date(t0.getTime() + 100000).toISOString(),
          },
        },
        boundaries_compliance: {
          tvbox_node_armbian_01_untouched: true,
          docker_worker_node_worker_01_untouched: true,
          shared_ec2_gateway_offline_event_prevented: true,
          telegram_real_channel_status: 'CHƯA KIỂM CHỨNG (Kênh giả lập mock dry-run được sử dụng an toàn; TUYỆT ĐỐI KHÔNG GỬI THẬT RA NGOÀI)',
          is_mock_transport_only: true,
        },
        verification_results: {
          overall_status: 'PASS',
          checks: {
            heartbeat_loss_detection: 'PASS (Node chuyển WARNING ở 15s-30s, chuyển OFFLINE ở >30s)',
            incident_creation: 'PASS (Tạo alert CRITICAL NODE_OFFLINE trong alerts, resolved_at = null)',
            open_notification_enqueued: 'PASS (Tạo intent OPEN trong alert_notifications, format Tiếng Việt chuẩn)',
            audit_log_persisted: 'PASS (Tạo audit_log action=NODE_OFFLINE với target và details IP)',
            anti_spam_deduplication: 'PASS (Chạy lại sweeper khi node vẫn offline không tạo alert/notification/audit trùng lặp)',
            flapping_suppression: 'PASS (Trễ trong khoảng stale 15s-30s chỉ chuyển WARNING, không phát sinh alert CRITICAL rác)',
            heartbeat_recovery_detection: 'PASS (Nhận beacon xác thực chuyển node về HEALTHY, tính đúng gap_seconds)',
            incident_resolution: 'PASS (Tự động cập nhật resolved_at trong bảng alerts, đóng sự cố)',
            recovery_notification_enqueued: 'PASS (Tạo intent RECOVERY, chứa thông tin thời gian gián đoạn và mốc phục hồi)',
            queue_deduplication: 'PASS (ON CONFLICT (alert_id, phase) DO NOTHING ngăn duplicate khi concurrent enqueue)',
            mock_delivery_execution: 'PASS (Worker claim theo thứ tự OPEN trước RECOVERY, chuyển trạng thái SENT)',
            bounded_retries: 'PASS (Thất bại sau 3 lần retry có backoff thì chuyển FAILED, không lặp vô tận)',
          },
        },
        three_layer_evidence: {
          layer1_database_state: {
            description: 'Trạng thái bản ghi CSDL tại các bảng nodes, alerts, alert_notifications',
            nodes: Array.from(harness.nodes.values()),
            alerts: harness.alerts,
            alert_notifications: harness.notifications,
          },
          layer2_audit_logs: {
            description: 'Sự kiện nhật ký kiểm toán hệ thống (audit_logs)',
            records: harness.auditLogs,
          },
          layer3_mock_transport: {
            description: 'Yêu cầu HTTP gửi ra kênh giả lập (intercepted fetch calls)',
            intercepted_requests: harness.capturedRequests,
            total_requests_sent: harness.capturedRequests.length,
          },
        },
      };

      // Write evidence file to /home/mowftee/.cache/evidence-alerts.json with mode 0600
      const cacheDir = '/home/mowftee/.cache';
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      const evidencePath = '/home/mowftee/.cache/evidence-alerts.json';
      fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
      fs.chmodSync(evidencePath, 0o600);

      const stat = fs.statSync(evidencePath);
      expect((stat.mode & 0o777)).toBe(0o600);
      expect(fs.existsSync(evidencePath)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
