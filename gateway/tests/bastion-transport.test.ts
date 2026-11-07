/** Real SSH over a delayed loopback, run only in an explicitly isolated test namespace. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Server, utils } from 'ssh2';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  query: vi.fn(), config: {
    BASTION_SSH_KEY_PATH: '', BASTION_DEFAULT_USER: 'fixture', BASTION_CONNECT_TIMEOUT_MS: 10000,
  },
}));
vi.mock('../src/config/env.js', () => ({ config: fixture.config }));
vi.mock('../src/services/db.js', () => ({ query: fixture.query }));

import { attachBastionSession } from '../src/services/bastion/session.js';
import { createBastionTicket, stopTicketCleaner } from '../src/services/bastion/tickets.js';
import { activeSessions, shutdownAllBastionSessions, stopSessionMaintenance } from '../src/services/bastion/registry.js';

class TestSocket extends EventEmitter {
  readyState = 1;
  frames: any[] = [];
  closeCode?: number;
  closeReason?: string;
  send(text: string) { const frame = JSON.parse(text); this.frames.push(frame); this.emit('frame', frame); }
  close(code = 1000, reason = '') { if (this.readyState === 3) return; this.closeCode = code; this.closeReason = reason; this.readyState = 3; this.emit('close'); }
}

// Binding port 22 and the external tc helper are confined to the disposable container.
describe.skipIf(process.env.ZT_TEST_DELAYED_TRANSPORT !== 'isolated')('delayed real SSH transport', () => {
  let directory: string;
  let server: net.Server | Server | undefined;
  let pin: string;
  const connections = new Set<any>();
  const admin = { id: 'fixture-admin', role: 'ADMIN', is_active: true, session_version: 1 };
  const node = { id: 'fixture-node', name: 'delayed-worker', ip_address: '127.0.0.1', ssh_username: 'fixture' };
  const endAudits = () => fixture.query.mock.calls.filter(([sql]) => sql.includes("'BASTION_SESSION_END'"));
  const attach = (socket: TestSocket) => attachBastionSession(socket as unknown as WebSocket, node.id,
    createBastionTicket(node.id, admin.id, 1));
  const frame = (socket: TestSocket, type: string) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ${type} frame within fixture deadline`)), 15000);
    socket.on('frame', (value) => {
      if (value.type === type) { clearTimeout(timer); resolve(value); }
      else if (value.type === 'ERROR' && type !== 'ERROR') {
        clearTimeout(timer); reject(new Error(`Unexpected ERROR: ${value.message}`));
      }
    });
    socket.once('close', () => { clearTimeout(timer); reject(new Error(`Socket closed before ${type}: ${socket.closeCode} ${socket.closeReason}`)); });
  });

  beforeEach(() => {
    fixture.query.mockReset();
    fixture.config.BASTION_CONNECT_TIMEOUT_MS = 10000;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-delayed-ssh-'));
    const clientKey = utils.generateKeyPairSync('ed25519');
    const hostKey = utils.generateKeyPairSync('ed25519');
    fixture.config.BASTION_SSH_KEY_PATH = path.join(directory, 'client-key');
    fs.writeFileSync(fixture.config.BASTION_SSH_KEY_PATH, clientKey.private, { mode: 0o400 });
    pin = crypto.createHash('sha256').update(Buffer.from(hostKey.public.split(' ')[1], 'base64')).digest('hex');
    fixture.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('FROM users') ? [admin]
      : sql.includes('FROM nodes') ? [{ ...node, host_key_fingerprint: pin }] : [], rowCount: 1 }));
    const parsed = utils.parseKey(clientKey.public);
    if (parsed instanceof Error) throw parsed;
    server = new Server({ hostKeys: [hostKey.private] }, (client) => {
      connections.add(client);
      client.on('close', () => connections.delete(client));
      client.on('error', () => {});
      client.on('authentication', (ctx: any) => {
        const validKey = ctx.method === 'publickey' && ctx.username === 'fixture'
          && ctx.key.data.equals(parsed.getPublicSSH());
        if (validKey && (!ctx.signature || parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) ctx.accept();
        else ctx.reject();
      });
      client.on('ready', () => client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => acceptPty?.());
        session.on('shell', (acceptShell) => { const stream = acceptShell(); stream.write('delayed SSH fixture\r\n'); });
      }));
    });
  });

  afterEach(async () => {
    shutdownAllBastionSessions();
    stopTicketCleaner();
    stopSessionMaintenance();
    for (const client of connections) {
      if (typeof client.destroy === 'function') client.destroy();
      else client.end();
    }
    connections.clear();
    if (server?.address()) await new Promise<void>((resolve) => server!.close(() => resolve()));
    fs.rmSync(directory, { force: true, recursive: true });
  });

  it('authenticates one pinned SSH connection when TCP startup takes over 400 ms', async () => {
    await new Promise<void>((resolve) => server!.listen(22, '127.0.0.1', resolve));
    // The fixture runner applies 225 ms egress delay on lo: TCP startup takes about 450 ms.
    const tcpStart = performance.now();
    await new Promise<void>((resolve, reject) => {
      const control = net.createConnection({ host: '127.0.0.1', port: 22 });
      control.on('connect', () => { control.destroy(); resolve(); });
      control.on('error', reject);
    });
    expect(performance.now() - tcpStart).toBeGreaterThanOrEqual(425);
    const socket = new TestSocket();
    const ready = frame(socket, 'READY');
    await attach(socket);
    await ready;
    expect(socket.frames.some(value => value.type === 'ERROR')).toBe(false);
    expect(activeSessions.size).toBe(1);
    socket.close();
    expect(activeSessions.size).toBe(0);
    expect(endAudits()).toHaveLength(1);
  }, 20000);

  it('still rejects a mismatched host pin and closes its lease/audit once', async () => {
    pin = '0'.repeat(64);
    await new Promise<void>((resolve) => server!.listen(22, '127.0.0.1', resolve));
    const socket = new TestSocket();
    const error = frame(socket, 'ERROR');
    await attach(socket);
    await error;
    expect(socket.closeCode).toBe(4502);
    expect(activeSessions.size).toBe(0);
    expect(endAudits()).toHaveLength(1);
  }, 20000);

  it('applies the configured timeout when a connected TCP peer never speaks SSH', async () => {
    fixture.config.BASTION_CONNECT_TIMEOUT_MS = 1000;
    server = net.createServer((peer) => {
      connections.add(peer); peer.on('close', () => connections.delete(peer)); peer.on('error', () => {});
    });
    await new Promise<void>((resolve) => server!.listen(22, '127.0.0.1', resolve));
    const socket = new TestSocket();
    const error = frame(socket, 'ERROR');
    const started = performance.now();
    await attach(socket);
    await error;
    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
    expect(socket.closeCode).toBe(4502);
    expect(activeSessions.size).toBe(0);
    expect(endAudits()).toHaveLength(1);
  }, 10000);
});
