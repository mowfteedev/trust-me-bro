import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middlewares/auth.middleware.js';

const PATH = '/run/zt-host-monitor/host.json';
const MAX_BYTES = 262144;
const counter = z.number().int().safe().nonnegative();
const timestamp = z.string().datetime();
const state = z.enum(['healthy', 'running', 'unhealthy', 'stopped', 'unknown']);
const ids = ['gateway', 'proxy', 'postgres', 'wireguard_gateway'] as const;
const names = { gateway: 'Gateway', proxy: 'Caddy', postgres: 'PostgreSQL', wireguard_gateway: 'WireGuard' };
const snapshotSchema = z.object({
  sampled_at: timestamp,
  host: z.object({
    hostname: z.string().min(1).max(253),
    cpu_percent: z.number().finite().min(0).max(100).nullable(),
    memory_used_bytes: counter, memory_total_bytes: counter.positive(),
    disk_used_bytes: counter, disk_total_bytes: counter.positive(),
    uptime_seconds: counter, network_rx_bytes: counter, network_tx_bytes: counter,
    network_interface: z.string().regex(/^[A-Za-z0-9_.:-]{1,32}$/),
  }).refine(h => h.memory_used_bytes <= h.memory_total_bytes && h.disk_used_bytes <= h.disk_total_bytes),
  services: z.array(z.object({
    id: z.enum(ids), state, started_at: timestamp.nullable(), restarts: counter,
    observations: z.array(z.object({ at: timestamp, state })).max(30),
  })).length(4).refine(items => new Set(items.map(item => item.id)).size === 4),
});

async function readSnapshot() {
  // The fixed read-only bind contains sanitized observations, never Docker's socket.
  const file = await fs.open(PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Invalid snapshot');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error('Invalid snapshot');
    const data = snapshotSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
    const age = Date.now() - Date.parse(data.sampled_at);
    if (age < -10000) throw new Error('Future snapshot');
    return { ...data, services: data.services.map(service => ({ ...service, name: names[service.id] })), stale: age > 15000 };
  } finally {
    await file.close();
  }
}

export const hostRoutes: FastifyPluginAsync = async fastify => {
  fastify.get('/host', { preHandler: [authenticate] }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await readSnapshot();
    } catch {
      return reply.status(503).send({ status: 503, code: 'HOST_MONITOR_UNAVAILABLE',
        detail: 'Chưa nhận được số liệu máy Gateway.' });
    }
  });
};
