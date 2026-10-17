import fs from 'node:fs';
import { Client } from 'pg';
import { registerNode } from '../services/node-registration.js';

// Run as a one-shot migrator; this CLI does not add grants to the runtime role.
// No global app config import: this operation needs only DATABASE_URL from Compose.
async function main() {
  const bytes = fs.readFileSync(0);
  if (bytes.length > 4096) throw new Error('Registration input too large');
  const input: unknown = JSON.parse(bytes.toString('utf8'));
  const databaseURL = process.env.DATABASE_URL;
  if (!databaseURL) throw new Error('DATABASE_URL required');
  const client = new Client({ connectionString: databaseURL, connectionTimeoutMillis: 3000,
    query_timeout: 5000, statement_timeout: 5000 });
  try {
    await client.connect();
    const result = await registerNode(client, input);
    console.log(JSON.stringify({ node_id: result.id, created: result.created }));
  } finally {
    await client.end();
  }
}

main().catch(() => {
  // Never echo stdin, DB URLs, private tokens or raw validation/driver errors.
  console.error('Node registration failed. Existing identities were preserved; check input, trusted host fingerprint and name/IP/token conflicts.');
  process.exitCode = 1;
});
