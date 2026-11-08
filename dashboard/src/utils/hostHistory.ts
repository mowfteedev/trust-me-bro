import type { HostSnapshot } from '../types/index.js';

export type HostResource = 'cpu' | 'ram' | 'disk';
export interface HostHistoryPoint { at: string; cpu: number | null; ram: number | null; disk: number | null }
export interface HostTrendPoint { at: string; time: number; value: number }
const WINDOW_MS = 300_000;
const GAP_MS = 15_000;
function percent(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
function ratio(used: number, total: number): number | null {
  return Number.isFinite(used) && Number.isFinite(total) && total > 0 && used >= 0 && used <= total ? used / total * 100 : null;
}
export function appendHostHistory(history: HostHistoryPoint[], snapshot: HostSnapshot, now = Date.now()): HostHistoryPoint[] {
  const time = Date.parse(snapshot.sampled_at);
  if (snapshot.stale || !Number.isFinite(time) || time > now || now - time > GAP_MS
    || (history.length > 0 && time <= Date.parse(history[history.length - 1].at))) return history;
  const point = { at: snapshot.sampled_at, cpu: percent(snapshot.host.cpu_percent),
    ram: ratio(snapshot.host.memory_used_bytes, snapshot.host.memory_total_bytes),
    disk: ratio(snapshot.host.disk_used_bytes, snapshot.host.disk_total_bytes) };
  if (point.cpu === null && point.ram === null && point.disk === null) return history;
  return [...history.filter(item => time - Date.parse(item.at) <= WINDOW_MS), point].slice(-60);
}
// Unknown values and missing sampling intervals break the line; never bridge an outage.
export function hostTrendSegments(points: HostHistoryPoint[], resource: HostResource): HostTrendPoint[][] {
  const segments: HostTrendPoint[][] = [];
  let previous: number | null = null, needsSegment = true;
  for (const point of points) {
    const time = Date.parse(point.at), value = percent(point[resource]);
    if (!Number.isFinite(time) || value === null || (previous !== null && time <= previous)) { needsSegment = true; continue; }
    if (needsSegment || (previous !== null && time - previous > GAP_MS)) segments.push([]);
    segments[segments.length - 1].push({ at: point.at, time, value });
    previous = time; needsSegment = false;
  }
  return segments;
}
