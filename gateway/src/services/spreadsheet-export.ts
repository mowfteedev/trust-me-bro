import type { FastifyReply } from 'fastify';
import { createSpreadsheet, ExportLimitError, type SpreadsheetCell } from '../utils/xlsx.js';

const budgets = new Map<string, number>();
let busy = false;
const COOLDOWN_MS = 15000;

/** Shared CPU/memory guard; independent per-user budgets for Audit and Incidents. */
export async function sendSpreadsheet(reply: FastifyReply, userId: string, kind: 'audit-logs' | 'incidents',
  build: () => Promise<{ headers: string[]; rows: SpreadsheetCell[][]; name: string }>) {
  reply.header('Cache-Control', 'no-store');
  if (busy) return reply.header('Retry-After', '2').code(409).send({ code: 'EXPORT_IN_PROGRESS',
    detail: 'Hệ thống đang xuất một tệp Excel. Vui lòng thử lại sau ít giây.' });
  const now = Date.now();
  for (const [key, expires] of budgets) if (expires <= now) budgets.delete(key);
  const key = `${userId}:${kind}`;
  const remaining = (budgets.get(key) ?? 0) - now;
  if (remaining > 0 || budgets.size >= 2000) {
    const seconds = remaining > 0 ? Math.ceil(remaining / 1000) : 15;
    return reply.header('Retry-After', String(seconds)).code(429).send({ code: 'EXPORT_RATE_LIMITED',
      detail: `Vui lòng chờ ${seconds} giây trước khi xuất lại danh sách này.` });
  }
  busy = true; budgets.set(key, now + COOLDOWN_MS);
  try {
    const { headers, rows, name } = await build();
    const file = createSpreadsheet(headers, rows, name);
    return reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="zt-${kind}.xlsx"`)
      .header('X-Content-Type-Options', 'nosniff').send(file);
  } catch (error) {
    if (error instanceof ExportLimitError) return reply.code(422).send({ code: 'EXPORT_TOO_LARGE', detail: error.message });
    return reply.code(503).send({ code: 'EXPORT_UNAVAILABLE', detail: 'Không thể xuất Excel lúc này. Vui lòng thử lại.' });
  } finally { busy = false; }
}
