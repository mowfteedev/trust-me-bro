import type { PoolClient } from 'pg';
import { query } from './db.js';
import { telegramService } from './telegram.js';
import { config } from '../config/env.js';

let timer: NodeJS.Timeout | null = null;
let active: Promise<void> | null = null;
let stopping = false;

/** Use the incident's transaction, so rollback also cancels notification intent. */
export async function enqueueAlertNotification(
  client: Pick<PoolClient, 'query'>, alertId: string, phase: 'OPEN' | 'RECOVERY', text: string,
): Promise<void> {
  await client.query(
    `INSERT INTO alert_notifications (alert_id, phase, text)
     VALUES ($1, $2, $3) ON CONFLICT (alert_id, phase) DO NOTHING;`,
    [alertId, phase, text],
  );
}

/** One in-process worker, persistent claims; the lease also survives Gateway restarts. */
export async function runAlertDeliveryCycle(): Promise<void> {
  if (active) return active;
  active = (async () => {
    // A crash during the third attempt must not leave PROCESSING forever.
    await query(`UPDATE alert_notifications SET status = 'FAILED', last_error = 'ATTEMPT_INTERRUPTED'
      WHERE status = 'PROCESSING' AND attempts >= 3 AND next_attempt_at <= now();`);
    for (let i = 0; i < 5 && !stopping; i++) {
      const claimed = await query(
        `UPDATE alert_notifications n SET status = 'PROCESSING', attempts = n.attempts + 1,
           last_attempt_at = now(), next_attempt_at = now() + make_interval(secs => $1)
         FROM (SELECT pending.id FROM alert_notifications pending
           JOIN alerts a ON a.id = pending.alert_id
           JOIN nodes nd ON nd.id = a.node_id
           WHERE pending.status IN ('PENDING', 'PROCESSING') AND pending.attempts < 3 AND pending.next_attempt_at <= now()
             AND nd.lifecycle_state = 'ACTIVE'
             AND (pending.phase = 'OPEN' OR NOT EXISTS (
               SELECT 1 FROM alert_notifications opening
               WHERE opening.alert_id = pending.alert_id AND opening.phase = 'OPEN'
                 AND opening.status IN ('PENDING', 'PROCESSING')
             ))
           ORDER BY pending.created_at, pending.id FOR UPDATE OF pending SKIP LOCKED LIMIT 1) candidate
         WHERE n.id = candidate.id RETURNING n.id, n.text, n.attempts;`,
        [Math.ceil(config.TELEGRAM_REQUEST_TIMEOUT_MS / 1000) + 10],
      );
      const row = claimed.rows[0];
      if (!row) break;
      const result = await telegramService.deliverQueued(row.text);
      const retry = result.status === 'RETRY' && row.attempts < 3;
      const status = retry ? 'PENDING' : result.status === 'RETRY' ? 'FAILED' : result.status;
      await query(
        `UPDATE alert_notifications SET status = $2, last_error = $3,
           next_attempt_at = now() + make_interval(secs => $4)
         WHERE id = $1 AND status = 'PROCESSING' AND attempts = $5;`,
        [row.id, status, result.error ?? null, row.attempts * 5, row.attempts],
      );
    }
  })().finally(() => { active = null; });
  return active;
}

export function startAlertDelivery(): void {
  if (timer) return;
  stopping = false;
  const run = () => { void runAlertDeliveryCycle().catch(() => {
    console.warn('[ALERT DELIVERY] Không thể cập nhật hàng đợi; sẽ thử lại ở chu kỳ sau.');
  }); };
  timer = setInterval(run, 3000);
  timer.unref();
  run();
}

export async function stopAlertDelivery(): Promise<void> {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  try { await active; }
  catch { console.warn('[ALERT DELIVERY] Dừng hàng đợi sau lỗi DB; ý định gửi còn trong PostgreSQL.'); }
}
