import type { MetricSnapshot } from "../types/index.js";

export const HEARTBEAT_BUCKET_MS = 3000;
export const HEARTBEAT_BUCKET_COUNT = 30;

export interface HeartbeatBucket {
  start: number;
  end: number;
  count: number;
}

// These buckets describe received samples, not historical Online/Offline status.
export function buildHeartbeatBuckets(
  metrics: ReadonlyArray<Pick<MetricSnapshot, "recorded_at">>,
  now: number,
): HeartbeatBucket[] {
  if (!Number.isFinite(now)) return [];
  const start = now - HEARTBEAT_BUCKET_MS * HEARTBEAT_BUCKET_COUNT;
  const buckets = Array.from({ length: HEARTBEAT_BUCKET_COUNT }, (_, index) => ({
    start: start + index * HEARTBEAT_BUCKET_MS,
    end: start + (index + 1) * HEARTBEAT_BUCKET_MS,
    count: 0,
  }));
  const seen = new Set<number>();
  for (const metric of metrics) {
    const stamp = Date.parse(metric.recorded_at);
    if (!Number.isFinite(stamp) || stamp < start || stamp > now || seen.has(stamp)) continue;
    seen.add(stamp);
    const index = Math.min(HEARTBEAT_BUCKET_COUNT - 1, Math.floor((stamp - start) / HEARTBEAT_BUCKET_MS));
    buckets[index].count++;
  }
  return buckets;
}
