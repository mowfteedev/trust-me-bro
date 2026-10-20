import type { FastifyInstance } from 'fastify';
import { buildServer } from './app.js';
import { config } from './config/env.js';
import { closeDatabasePool, ensureSeedData } from './services/db.js';
import {
  shutdownAllBastionSessions, startSessionMaintenance, stopSessionMaintenance,
} from './services/bastion/registry.js';
import { startTicketCleaner, stopTicketCleaner } from './services/bastion/tickets.js';
import { startSweeper, stopSweeper } from './services/sweeper.js';
import { telegramService } from './services/telegram.js';

let server: FastifyInstance | undefined;
let startup: Promise<void> | undefined;
let shutdown: Promise<void> | undefined;

function onUncaughtException(err: unknown): void {
  const code = (err as { code?: string } | null | undefined)?.code;
  if (code === 'EPIPE' || code === 'ECONNRESET') {
    console.warn(`⚠️ [PROCESS RESILIENCE] Bỏ qua lỗi stream đứt đột ngột (${code})`);
    return;
  }
  console.error('❌ [FATAL UNCAUGHT EXCEPTION]', err);
  process.exit(1);
}

function onUnhandledRejection(reason: unknown): void {
  console.error('❌ [FATAL UNHANDLED REJECTION]', reason);
}

function onSignal(signal: NodeJS.Signals): void {
  console.log(`\n🛑 [SHUTDOWN] Nhận tín hiệu ${signal}. Đang tiến hành ngắt êm đẹp...`);
  stopGateway().then(() => {
    console.log('✔ [SHUTDOWN] Hệ thống đã tắt an toàn. Tạm biệt!');
    process.exit(0);
  }).catch((err: unknown) => {
    console.error('❌ [SHUTDOWN] Không thể tắt Gateway an toàn:', err);
    process.exit(1);
  });
}

const onSigterm = () => onSignal('SIGTERM');
const onSigint = () => onSignal('SIGINT');

async function start(): Promise<void> {
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);

  server = await buildServer();
  await telegramService.init();
  await ensureSeedData();
  startTicketCleaner();
  startSessionMaintenance();
  startSweeper();

  const address = await server.listen({ port: config.GATEWAY_PORT, host: config.GATEWAY_HOST });
  console.log(`🚀 [GATEWAY ENGINE] Control Plane đang hoạt động tại: ${address}`);
  console.log(`🛡️ [SECURITY ACTIVE] Trusted proxy: ${config.TRUSTED_PROXY_IP || 'none'} | Port: ${config.GATEWAY_PORT}`);
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
}

export function startGateway(): Promise<void> {
  startup ??= start().catch(async (err: unknown) => {
    try {
      await stopGateway();
    } catch (cleanupError: unknown) {
      console.error('❌ [STARTUP CLEANUP] Không thể dọn dẹp Gateway:', cleanupError);
    }
    throw err;
  });
  return startup;
}

async function stop(): Promise<void> {
  stopTicketCleaner();
  stopSessionMaintenance();
  shutdownAllBastionSessions();
  stopSweeper();
  telegramService.stop();
  try {
    await server?.close();
  } finally {
    try {
      await closeDatabasePool();
    } finally {
      process.off('SIGTERM', onSigterm);
      process.off('SIGINT', onSigint);
      process.off('uncaughtException', onUncaughtException);
      process.off('unhandledRejection', onUnhandledRejection);
    }
  }
}

export function stopGateway(): Promise<void> {
  shutdown ??= stop();
  return shutdown;
}
