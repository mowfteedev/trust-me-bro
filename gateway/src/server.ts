import { startGateway } from './runtime.js';

export { buildServer } from './app.js';

const isDirectExecution = process.argv[1] && (
  process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js')
);

if (isDirectExecution) {
  startGateway().catch((err: unknown) => {
    console.error('❌ [FATAL] Không thể khởi động Gateway Server:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
