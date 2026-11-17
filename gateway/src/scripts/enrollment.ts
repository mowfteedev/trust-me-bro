import fs from 'node:fs';
import { Client } from 'pg';
import { enrollmentPublicConfig } from '../services/enrollment-contract.js';
import { issueEnrollment, revokeEnrollment, enrollmentStatus } from '../services/enrollment-invitations.js';

async function main() {
  if (process.argv.length !== 3 || !['issue', 'revoke', 'status'].includes(process.argv[2])) throw new Error('Invalid action');
  if (process.argv[2] === 'issue' && process.stdout.isTTY) throw new Error('Capture the invitation into a protected file');
  const input = fs.readFileSync(0);
  if (input.length > 4096) throw new Error('Input too large');
  const parsed: unknown = JSON.parse(input.toString('utf8'));
  const databaseURL = process.env.DATABASE_URL;
  if (!databaseURL) throw new Error('Database configuration required');
  const client = new Client({ connectionString: databaseURL, connectionTimeoutMillis: 3000,
    query_timeout: 10000, statement_timeout: 10000 });
  try {
    await client.connect();
    const action = process.argv[2];
    const output = action === 'issue' ? await issueEnrollment(client, parsed, enrollmentPublicConfig(process.env))
      : action === 'revoke' ? await revokeEnrollment(client, parsed) : await enrollmentStatus(client, parsed);
    // The administrative installer captures this stdout into a private file.
    process.stdout.write(JSON.stringify(output) + '\n');
  } finally { await client.end(); }
}

main().catch(() => {
  console.error('Enrollment administration failed; check permissions, input, conflicts and Gateway configuration. No secrets were printed.');
  process.exitCode = 1;
});
