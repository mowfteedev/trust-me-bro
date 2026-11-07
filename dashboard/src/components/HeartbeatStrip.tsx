import React from "react";
import type { MetricSnapshot, NodeItem } from "../types/index.js";
import { buildHeartbeatBuckets } from "../utils/heartbeat.js";
import { formatAge, formatTime } from "../utils/format.js";
import { StatusBadge } from "./StatusBadge.js";

interface HeartbeatStripProps {
  node: NodeItem;
  metrics: MetricSnapshot[];
  now: number;
  loading?: boolean;
  error?: string | null;
  sourceStale?: boolean;
}

export const HeartbeatStrip: React.FC<HeartbeatStripProps> = ({
  node, metrics, now, loading = false, error = null, sourceStale = false,
}) => {
  const buckets = buildHeartbeatBuckets(metrics, now);
  const received = buckets.filter(bucket => bucket.count > 0).length;
  const notice = error ? "Không tải được lịch sử."
    : sourceStale ? "Dữ liệu cũ."
      : loading && metrics.length === 0 ? "Đang tải…" : "";

  return (
    <div className="heartbeat-widget" data-node-id={node.id} data-now={now}
      data-stale={sourceStale || Boolean(error)}>
      <div className="heartbeat-heading">
        <div><h3>Heartbeat</h3><span>90 giây</span></div>
        <StatusBadge status={node.status} />
      </div>
      <div className="heartbeat-bars" role="img"
        aria-label={`Heartbeat ${node.name}: ${received} khoảng có mẫu, ${buckets.length - received} khoảng chưa có mẫu trong 90 giây.`}
        aria-busy={loading}
        data-window-start={buckets[0]?.start} data-window-end={buckets.at(-1)?.end}>
        {buckets.map((bucket, index) => (
          <span key={index} className="heartbeat-bucket" aria-hidden="true"
            data-heartbeat-bucket={index} data-state={bucket.count ? "received" : "missing"}
            data-count={bucket.count} data-start={bucket.start} data-end={bucket.end}
            title={`${formatTime(new Date(bucket.start).toISOString())}–${formatTime(new Date(bucket.end).toISOString())}: ${bucket.count ? `${bucket.count} mẫu` : "Chưa có mẫu"}`} />
        ))}
      </div>
      <div className="heartbeat-axis" aria-hidden="true">
        <span>{buckets.length ? formatTime(new Date(buckets[0].start).toISOString()) : "—"}</span>
        <span>{buckets.length ? formatTime(new Date(buckets[buckets.length - 1].end).toISOString()) : "—"}</span>
      </div>
      <div className="heartbeat-legend">
        <span><i className="received" />Có mẫu</span>
        <span><i />Chưa có mẫu</span>
      </div>
      <div className="heartbeat-last-seen">
        <span>Heartbeat gần nhất</span>
        <time dateTime={node.last_seen || undefined}>{formatAge(node.last_seen, now)}</time>
      </div>
      {notice && <p className="heartbeat-notice" role={error ? "alert" : "status"}>{notice}</p>}
    </div>
  );
};
