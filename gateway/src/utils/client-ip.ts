import { isIP } from 'node:net';

// Use Fastify's resolved IP after its trusted-proxy check, never a raw header.
// A missing IP stays null in audit instead of fabricating a localhost address.
export function normalizeClientIp(address?: string): string | null {
  const normalized = address?.replace(/^::ffff:/i, '');
  return normalized && isIP(normalized) ? normalized : null;
}
