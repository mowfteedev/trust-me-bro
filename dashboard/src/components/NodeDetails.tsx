import React from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Clock3,
  Cpu,
  HardDrive,
  LockKeyhole,
  MemoryStick,
  Radio,
  Terminal,
} from "lucide-react";
import { MetricSnapshot, NodeItem, UserSession } from "../types/index.js";
import {
  formatAge,
  formatBytes,
  formatDateTime,
  formatTime,
  formatUptime,
  nodeTypeLabel,
} from "../utils/format.js";
import { MetricsChart } from "./MetricsChart.js";
import { StatusBadge } from "./StatusBadge.js";

interface NodeDetailsProps {
  node: NodeItem;
  currentUser?: UserSession | null;
  onOpenTerminal: (node: NodeItem) => void;
  now: number;
  sourceStale: boolean;
  metricsHistory: MetricSnapshot[];
  historyError: string | null;
  historyLoading: boolean;
}

export const NodeDetails: React.FC<NodeDetailsProps> = ({
  node,
  currentUser,
  onOpenTerminal,
  now,
  sourceStale,
  metricsHistory,
  historyError,
  historyLoading,
}) => {
  const metric = node.latest_metric;
  const resources = [
    {
      label: "CPU",
      icon: Cpu,
      value: metric?.cpu_percent,
      hint: "Mức sử dụng bộ xử lý",
      color: "cpu",
    },
    {
      label: "Bộ nhớ RAM",
      icon: MemoryStick,
      value:
        metric && metric.memory_total_bytes > 0
          ? (metric.memory_used_bytes / metric.memory_total_bytes) * 100
          : undefined,
      hint: metric
        ? `${formatBytes(metric.memory_used_bytes)} / ${formatBytes(metric.memory_total_bytes)}`
        : "Chưa nhận số liệu",
      color: "memory",
    },
    {
      label: "Ổ đĩa",
      icon: HardDrive,
      value:
        metric && metric.disk_total_bytes > 0
          ? (metric.disk_used_bytes / metric.disk_total_bytes) * 100
          : undefined,
      hint: metric
        ? `${formatBytes(metric.disk_used_bytes)} / ${formatBytes(metric.disk_total_bytes)}`
        : "Chưa nhận số liệu",
      color: "disk",
    },
  ];
  return (
    <section
      className="detail-panel panel"
      aria-label={`Tài nguyên ${node.name}`}
      data-stale={sourceStale || node.status !== "HEALTHY"}
    >
      <div className="detail-heading">
        <div>
          <span className="eyebrow">NODE OBSERVABILITY</span>
          <div className="detail-title">
            <h2>{node.name}</h2>
            <StatusBadge status={node.status} />
          </div>
          <span className="detail-address">
            <Radio size={13} />
            {node.ip_address}
            <i />
            {nodeTypeLabel(node.node_type)}
          </span>
        </div>
        {currentUser?.role === "ADMIN" ? (
          <button
            className="button primary"
            onClick={() => onOpenTerminal(node)}
            disabled={node.status === "OFFLINE"}
          >
            <Terminal size={16} />
            Mở Web SSH
            <ArrowUpRight size={14} />
          </button>
        ) : (
          <span className="read-only-label">
            <LockKeyhole size={14} />
            Chế độ chỉ đọc
          </span>
        )}
      </div>
      {node.status !== "HEALTHY" && metric && (
        <div className="notice warning">
          <AlertTriangle size={16} />
          <span>
            Đang hiển thị mẫu cuối lúc {formatDateTime(metric.recorded_at)}.
            Gateway chưa nhận heartbeat mới; chưa thể kết luận máy đã tắt hay mất mạng.
          </span>
        </div>
      )}
      <div className="node-context">
        <span>
          <Clock3 size={14} /> Heartbeat:{" "}
          <b title={formatDateTime(node.last_seen)}>
            {formatAge(node.last_seen, now)}
          </b>
        </span>
        <span>
          Mẫu tài nguyên:{" "}
          <time
            dateTime={metric?.recorded_at}
            title={formatDateTime(metric?.recorded_at)}
          >
            {formatTime(metric?.recorded_at)}
          </time>
        </span>
      </div>
      <div className="resource-grid">
        {resources.map(({ label, icon: Icon, value, hint, color }) => (
          <div className="resource-tile" key={label}>
            <div className="resource-label">
              <Icon size={15} />
              <span>{label}</span>
            </div>
            <div className="resource-value">
              {value === undefined ? "—" : value.toFixed(1)}
              {value !== undefined && <small>%</small>}
            </div>
            <div className="meter">
              <i
                className={
                  value !== undefined && value >= 85 ? "high" : color
                }
                style={{
                  width: `${Math.min(100, Math.max(0, value ?? 0))}%`,
                }}
              />
            </div>
            <span className="resource-hint">{hint}</span>
          </div>
        ))}
      </div>
      <div className="chart-section">
        <div className="section-heading">
          <h3>
            <Activity size={16} />
            Lịch sử tài nguyên
          </h3>
          <span>30 mẫu gần nhất</span>
        </div>
        {historyError && (
          <div role="alert" className="notice danger">
            <AlertCircle size={16} />
            <span>
              Không tải được biểu đồ: {historyError} Hệ thống sẽ tự thử
              lại.
            </span>
          </div>
        )}
        {historyLoading ? (
          <div className="chart-loading skeleton" aria-busy="true">
            <span>Đang tải lịch sử tài nguyên...</span>
          </div>
        ) : (
          (!historyError || metricsHistory.length > 0) && (
            <MetricsChart metrics={metricsHistory} />
          )
        )}
      </div>
      <div className="network-metrics">
        <div>
          <span>
            <ArrowDownLeft size={16} />
            RX tích lũy
          </span>
          <strong>{formatBytes(metric?.network_rx_bytes)}</strong>
        </div>
        <div>
          <span>
            <ArrowUpRight size={16} />
            TX tích lũy
          </span>
          <strong>{formatBytes(metric?.network_tx_bytes)}</strong>
        </div>
        <div>
          <span>
            <Clock3 size={16} />
            Uptime
          </span>
          <strong>{formatUptime(metric?.uptime_seconds)}</strong>
        </div>
      </div>
      <div className="detail-footnote">
        <span>RX/TX: byte tích lũy trên giao diện Agent chọn, không phải byte/s.</span>
        <span>
          Uptime: thời gian chạy của hệ điều hành.
        </span>
      </div>
    </section>
  );
};
