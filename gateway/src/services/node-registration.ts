import { z } from 'zod';
import type { Client, PoolClient } from 'pg';
import { hashToken } from '../utils/crypto.js';

// Provisioning is an explicit local CLI action, never a public enrolment API.
export const NodeRegistrationInput = z.object({
  node_name: z.string().regex(/^[a-zA-Z0-9_-]{3,64}$/),
  node_ip: z.string().ip({ version: 'v4' }),
  node_type: z.enum(['VM', 'DOCKER', 'BARE_METAL']).default('VM'),
  node_token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  host_key_fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
}).strict();

export async function registerNode(client: Client | PoolClient, raw: unknown) {
  const input = NodeRegistrationInput.parse(raw);
  const tokenHash = hashToken(input.node_token);
  await client.query('BEGIN');
  try {
    // Serialize this short administrative operation; unique DB constraints remain
    // the final guard against collisions with another provisioning tool.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('zt-node-registration'))");
    const existing = await client.query(
      `SELECT id, name, host(ip_address) AS ip_address, node_type, token_hash,
              host_key_fingerprint, is_token_revoked
         FROM nodes WHERE name = $1 OR ip_address = $2::inet OR token_hash = $3 FOR UPDATE`,
      [input.node_name, input.node_ip, tokenHash],
    );
    if (existing.rows.length) {
      const node = existing.rows[0];
      if (existing.rows.length !== 1 || node.name !== input.node_name
        || node.ip_address !== input.node_ip || node.node_type !== input.node_type
        || node.token_hash !== tokenHash || node.is_token_revoked
        || node.host_key_fingerprint !== input.host_key_fingerprint) {
        throw new Error('NODE_REGISTRATION_CONFLICT');
      }
      await client.query('COMMIT');
      return { id: node.id as string, created: false };
    }
    const inserted = await client.query(
      `INSERT INTO nodes (name, ip_address, node_type, token_hash, token_prefix, host_key_fingerprint)
       VALUES ($1, $2::inet, $3, $4, $5, $6) RETURNING id`,
      [input.node_name, input.node_ip, input.node_type, tokenHash, input.node_token.slice(0, 8), input.host_key_fingerprint],
    );
    await client.query('COMMIT');
    return { id: inserted.rows[0].id as string, created: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
