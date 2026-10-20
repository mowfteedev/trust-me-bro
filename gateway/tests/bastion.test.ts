/** Session behavior with mocked PostgreSQL, TCP probe and SSH streams; no network connection. */
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), probes: [] as any[], clients: [] as any[], stream: null as any }));
vi.mock('../src/config/env.js', () => ({ config: {
  BASTION_SSH_KEY_PATH: '/isolated-test/key', BASTION_DEFAULT_USER: 'test-worker',
} }));
vi.mock('../src/services/db.js', () => ({ query: mock.query }));
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  const { EventEmitter } = await import('node:events');
  class Probe extends EventEmitter {
    setTimeout = vi.fn();
    connect = vi.fn();
    destroy = vi.fn();
    constructor() { super(); mock.probes.push(this); }
  }
  return { ...actual, default: { ...actual.default, Socket: Probe } };
});
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events');
  class Client extends EventEmitter {
    connect = vi.fn((options) => mock.connect(options));
    end = vi.fn();
    destroy = vi.fn();
    shell = vi.fn((_options, callback) => callback(null, mock.stream));
    constructor() { super(); mock.clients.push(this); }
  }
  return { Client };
});

import { attachBastionSession } from '../src/services/bastion/session.js';
import { createBastionTicket } from '../src/services/bastion/tickets.js';
import { activeSessions, shutdownAllBastionSessions } from '../src/services/bastion/registry.js';

const { Client: ActualSshClient } = await vi.importActual<typeof import('ssh2')>('ssh2');

class TestSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  pause = vi.fn();
  resume = vi.fn();
  terminate = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.emit('close'); });
}
class TestStream extends EventEmitter {
  write = vi.fn(() => true);
  pause = vi.fn();
  resume = vi.fn();
  end = vi.fn();
  destroy = vi.fn();
  setWindow = vi.fn();
}

const user = { id: 'test-admin', role: 'ADMIN', is_active: true, session_version: 1 };
const node = { id: 'test-node', name: 'worker-test', ip_address: '10.100.0.2', host_key_fingerprint: 'pinned-fingerprint' };
const attach = (socket: TestSocket, userId = user.id) => attachBastionSession(
  socket as unknown as WebSocket, node.id, createBastionTicket(node.id, userId, 1), '198.51.100.7'
);
const endAudits = () => mock.query.mock.calls.filter(([sql]) => sql.includes("'BASTION_SESSION_END'"));
const closedLeases = () => mock.query.mock.calls.filter(([sql]) => sql.includes("SET status = 'CLOSED'"));
const outputFrames = (socket: TestSocket) => socket.send.mock.calls
  .map(([data]) => JSON.parse(data)).filter(frame => frame.type === 'DATA');

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mock.connect.mockReset();
  mock.probes.length = 0;
  mock.clients.length = 0;
  mock.stream = new TestStream();
  vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('isolated-test-key'));
  mock.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes('FROM users') ? [user] : sql.includes('FROM nodes') ? [node] : [], rowCount: 1,
  }));
});
afterEach(() => {
  shutdownAllBastionSessions();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('session slots are reserved before awaiting database authentication', () => {
  it('allows only five pending sessions for the same user', async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => { release = resolve; });
    mock.query.mockImplementation((sql: string) => sql.includes('FROM users')
      ? pending : Promise.resolve({ rows: [], rowCount: 1 }));
    const sockets = Array.from({ length: 6 }, () => new TestSocket());
    const requests = sockets.map((socket) => attach(socket));
    expect(mock.query.mock.calls.filter(([sql]) => sql.includes('FROM users'))).toHaveLength(5);
    expect(sockets[5].close).toHaveBeenCalledWith(4429, 'User Quota Exceeded');
    expect(sockets.slice(0, 5).every((socket) => !socket.close.mock.calls.length)).toBe(true);
    release({ rows: [], rowCount: 0 });
    await Promise.all(requests);
  });

  it('caps all users together at fifty pending sessions', async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => { release = resolve; });
    mock.query.mockImplementation((sql: string) => sql.includes('FROM users')
      ? pending : Promise.resolve({ rows: [], rowCount: 1 }));
    const sockets = Array.from({ length: 51 }, () => new TestSocket());
    const requests = sockets.map((socket, index) => attach(socket, `admin-${index}`));
    expect(mock.query.mock.calls.filter(([sql]) => sql.includes('FROM users'))).toHaveLength(50);
    expect(sockets[50].close).toHaveBeenCalledWith(4429, 'Session Quota Exceeded');
    release({ rows: [], rowCount: 0 });
    await Promise.all(requests);
  });

  it('keeps at most ten sessions after concurrent node lookups resolve', async () => {
    let release!: (value: unknown) => void;
    let allLookingUp!: () => void;
    let lookups = 0;
    const pending = new Promise((resolve) => { release = resolve; });
    const lookingUp = new Promise<void>((resolve) => { allLookingUp = resolve; });
    mock.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM nodes')) {
        if (++lookups === 11) allLookingUp();
        return pending;
      }
      return { rows: sql.includes('FROM users') ? [{ ...user, id: params[0] }] : [], rowCount: 1 };
    });
    const sockets = Array.from({ length: 11 }, () => new TestSocket());
    const requests = sockets.map((socket, index) => attach(socket, `admin-${index}`));
    await lookingUp;
    release({ rows: [node], rowCount: 1 });
    await Promise.all(requests);
    expect(sockets.filter((socket) => socket.close.mock.calls.some(([code]) => code === 4429))).toHaveLength(1);
    expect(mock.query.mock.calls.filter(([sql]) => sql.includes("'BASTION_SESSION_START'"))).toHaveLength(10);
    expect(mock.probes).toHaveLength(10);
  });
});

async function readySession() {
  const socket = new TestSocket();
  const probeIndex = mock.probes.length;
  const clientIndex = mock.clients.length;
  await attach(socket);
  mock.probes[probeIndex].emit('connect');
  mock.clients[clientIndex].emit('ready');
  expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"READY"'));
  return { socket, stream: mock.stream as TestStream, client: mock.clients[clientIndex] };
}

describe('SSH account belongs to the target node', () => {
  it('uses the node account instead of the Gateway default and reports it after SSH opens', async () => {
    mock.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM users') ? [user] : sql.includes('FROM nodes') ? [{ ...node, ssh_username: 'linux' }] : [], rowCount: 1,
    }));
    const { socket, client } = await readySession();
    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({ username: 'linux' }));
    const frame = socket.send.mock.calls.map(([data]) => JSON.parse(data)).find(data => data.type === 'READY');
    expect(frame.ssh_username).toBe('linux');
    const start = mock.query.mock.calls.find(([sql]) => sql.includes("'BASTION_SESSION_START'"));
    expect(JSON.parse(start![1][1]).ssh_username).toBe('linux');
  });

  it('preserves the configured default for an older node with no account override', async () => {
    mock.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM users') ? [user] : sql.includes('FROM nodes') ? [{ ...node, ssh_username: null }] : [], rowCount: 1,
    }));
    const { socket, client } = await readySession();
    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({ username: 'test-worker' }));
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('"ssh_username":"test-worker"'));
  });
});

describe('SSH output preserves text and the Gateway control boundary', () => {
  it.each([1, 2, 5])('decodes Vietnamese and emoji across %i-byte stream chunks', async (width) => {
    const { socket, stream } = await readySession();
    const text = 'Tiếng Việt: máy chủ hoạt động 🛡️\r\n';
    const bytes = Buffer.from(text);
    for (let offset = 0; offset < bytes.length; offset += width) {
      stream.emit('data', bytes.subarray(offset, offset + width));
    }
    stream.emit('end');
    expect(outputFrames(socket).map(frame => frame.data).join('')).toBe(text);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it.each(['READY', 'ERROR', 'DATA'])('frames shell JSON of type %s as literal terminal output', async (type) => {
    const { socket, stream } = await readySession();
    socket.send.mockClear();
    const text = JSON.stringify({ type, message: 'untrusted shell text', data: 'literal' });
    stream.emit('data', Buffer.from(text));
    expect(socket.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'DATA', data: text }));
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('keeps decoder state separate for concurrently open shells', async () => {
    const first = await readySession();
    mock.stream = new TestStream();
    const second = await readySession();
    const text = Buffer.from('ệ');
    first.stream.emit('data', text.subarray(0, 1));
    second.stream.emit('data', Buffer.from('another shell'));
    first.stream.emit('data', text.subarray(1));
    expect(outputFrames(first.socket).map(frame => frame.data).join('')).toBe('ệ');
    expect(outputFrames(second.socket).map(frame => frame.data).join('')).toBe('another shell');
  });

  it.each(['end', 'close'])('flushes incomplete UTF-8 once on %s and ignores late output', async (event) => {
    const { socket, stream } = await readySession();
    stream.emit('data', Buffer.from([0xe1, 0xbb]));
    expect(outputFrames(socket)).toEqual([]);
    stream.emit(event);
    expect(outputFrames(socket)).toEqual([{ type: 'DATA', data: '\ufffd' }]);
    stream.emit('close');
    stream.emit('end');
    stream.emit('data', Buffer.from('late output'));
    expect(outputFrames(socket)).toEqual([{ type: 'DATA', data: '\ufffd' }]);
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(1000, 'Session Closed');
    expect(endAudits()).toHaveLength(1);
  });

  it('drops pending decoder bytes after client cleanup', async () => {
    const { socket, stream } = await readySession();
    stream.emit('data', Buffer.from([0xe1, 0xbb]));
    socket.emit('close');
    const sendsAfterCleanup = socket.send.mock.calls.length;
    stream.emit('end');
    stream.emit('close');
    stream.emit('data', Buffer.from('late output'));
    expect(outputFrames(socket)).toEqual([]);
    expect(socket.send).toHaveBeenCalledTimes(sendsAfterCleanup);
    expect(endAudits()).toHaveLength(1);
    expect(activeSessions.size).toBe(0);
  });

  it('cleans up once when the WebSocket cannot send output', async () => {
    const { socket, stream } = await readySession();
    socket.send.mockClear();
    socket.send.mockImplementationOnce(() => { throw new Error('isolated send failure'); });
    stream.emit('data', Buffer.from('first output'));
    stream.emit('data', Buffer.from('late output'));
    stream.emit('end');
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(1011, 'Send Error');
    expect(endAudits()).toHaveLength(1);
    expect(closedLeases()).toHaveLength(1);
    expect(activeSessions.size).toBe(0);
  });
});

describe('SSH setup failures release session ownership', () => {
  it('handles a synchronous ssh2 malformed-key error and releases the user slot', async () => {
    const realClient = new ActualSshClient();
    let parseFailure: unknown;
    // Real ssh2 key parsing rejects this fixture before attempting a network connection.
    mock.connect.mockImplementation((options) => {
      try { return realClient.connect(options); }
      catch (error) { parseFailure = error; throw error; }
    });
    const socket = new TestSocket();
    await attach(socket);
    expect(activeSessions.size).toBe(1);
    mock.probes[0].emit('connect');
    const client = mock.clients[0];
    expect(client.connect).toHaveBeenCalledOnce();
    expect(parseFailure).toBeInstanceOf(Error);
    expect((parseFailure as Error).message).toMatch(/^Cannot parse privateKey:/);
    expect(socket.close).toHaveBeenCalledExactlyOnceWith(4502, 'SSH Connection Interrupted');
    expect(client.end).toHaveBeenCalledOnce();
    expect(activeSessions.size).toBe(0);
    expect(endAudits()).toHaveLength(1);
    expect(closedLeases()).toHaveLength(1);
    expect(socket.send).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"type":"ERROR"'));
    expect(socket.send.mock.calls[0][0]).not.toContain('Cannot parse privateKey');

    client.emit('ready');
    client.emit('error', new Error('late transport failure'));
    mock.probes[0].emit('connect');
    expect(client.shell).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(endAudits()).toHaveLength(1);

    const replacementSockets = Array.from({ length: 5 }, () => new TestSocket());
    await Promise.all(replacementSockets.map((replacement) => attach(replacement)));
    expect(activeSessions.size).toBe(5);
    expect(replacementSockets.every((replacement) => replacement.close.mock.calls.length === 0)).toBe(true);
    const excessSocket = new TestSocket();
    await attach(excessSocket);
    expect(excessSocket.close).toHaveBeenCalledWith(4429, 'User Quota Exceeded');
  });
});

describe('idempotent cleanup and bounded stream backpressure', () => {
  it('rearms one drain listener without dropping or replaying queued input', async () => {
    const { socket, stream } = await readySession();
    const timersBefore = vi.getTimerCount();
    stream.write.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(true);
    socket.emit('message', Buffer.from('first'));
    socket.emit('message', Buffer.from('second'));
    socket.emit('message', Buffer.from('third'));
    expect(stream.write).toHaveBeenCalledTimes(1);
    expect(stream.listenerCount('drain')).toBe(1);
    expect(socket.pause).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(timersBefore + 1);
    stream.emit('drain');
    expect(stream.listenerCount('drain')).toBe(1);
    expect(stream.write).toHaveBeenCalledTimes(2);
    expect(socket.resume).not.toHaveBeenCalled();
    stream.emit('drain');
    expect(stream.write.mock.calls.map(([chunk]) => chunk.toString())).toEqual(['first', 'second', 'third']);
    expect(stream.listenerCount('drain')).toBe(0);
    expect(socket.resume).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it('enforces the total input queue limit while SSH is paused', async () => {
    const { socket, stream } = await readySession();
    stream.write.mockReturnValue(false);
    socket.emit('message', Buffer.from('first'));
    socket.emit('message', Buffer.alloc(65536));
    socket.emit('message', Buffer.from('overflow'));
    expect(stream.write).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledWith(4429, 'Buffer Overflow');
    stream.emit('drain');
    expect(stream.write).toHaveBeenCalledTimes(1);
    expect(endAudits()).toHaveLength(1);
  });

  it('uses one output drain timer and resumes only after the WebSocket buffer drains', async () => {
    const { socket, stream } = await readySession();
    const timersBefore = vi.getTimerCount();
    socket.bufferedAmount = 65537;
    stream.emit('data', Buffer.from('first output'));
    stream.emit('data', Buffer.from('second output'));
    expect(vi.getTimerCount()).toBe(timersBefore + 1);
    vi.advanceTimersByTime(40);
    expect(stream.resume).not.toHaveBeenCalled();
    socket.bufferedAmount = 16383;
    vi.advanceTimersByTime(40);
    expect(stream.resume).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it('closes resources and writes END once across repeated close/error events with pending drains', async () => {
    const { socket, stream, client } = await readySession();
    stream.write.mockReturnValue(false);
    socket.emit('message', Buffer.from('first'));
    socket.emit('message', Buffer.from('queued'));
    socket.bufferedAmount = 65537;
    stream.emit('data', Buffer.from('output'));
    socket.emit('error', new Error('isolated disconnect'));
    socket.emit('close');
    stream.emit('close');
    socket.emit('error', new Error('duplicate disconnect'));
    stream.emit('drain');
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(stream.destroy).toHaveBeenCalledTimes(1);
    expect(stream.write).toHaveBeenCalledTimes(1);
    expect(endAudits()).toHaveLength(1);
    expect(closedLeases()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1); // Only the existing forced-teardown deadline remains.
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(15000);
    expect(stream.resume).not.toHaveBeenCalled();
    expect(socket.resume).not.toHaveBeenCalled();
    expect(endAudits()).toHaveLength(1);
    expect(closedLeases()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
