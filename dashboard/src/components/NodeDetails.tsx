import React from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Clock3,
  Cpu,
  MemoryStick,
  HardDrive,
  LockKeyhole,
  Radio,
  Terminal,
} from "lucide-react";
import { MetricSnapshot, NodeItem, UserSession } from "../types/index.js";
import {
  formatAge,
  formatBytes,
  formatDateTime,
  formatUptime,
  nodeTypeLabel,
} from "../utils/format.js";
import { MetricsChart } from "./MetricsChart.js";
import { getNodeCpuPercent, getNodeRamPercent, getNodeDiskPercent } from "../utils/fleet.js";
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
  const sampleTimeKnown = Boolean(
    metric && Number.isFinite(Date.parse(metric.recorded_at)),
  );
  const sampleState = !metric
    ? "empty"
    : sourceStale || node.status !== "HEALTHY"
      ? "stale"
      : sampleTimeKnown
        ? "current"
        : "unknown";
  const sampleMessage = !metric
    ? "Chưa có số liệu."
    : sourceStale
      ? "Dữ liệu chưa cập nhật từ Gateway."
      : node.status !== "HEALTHY"
        ? "Số liệu gần nhất; chưa nhận heartbeat mới."
        : !sampleTimeKnown
          ? "Không rõ thời điểm mẫu đo."
          : "";
  const SourceIcon = sampleState === "stale" ? AlertTriangle : Radio;
  const metricScope = node.node_type === "DOCKER"
    ? "Host Docker"
    : node.node_type === "VM"
      ? "Hệ điều hành máy ảo"
      : "Hệ điều hành Worker";
  return (
    <section
      id="worker-details"
      tabIndex={-1}
      className="detail-panel panel"
      aria-label={`Tài nguyên ${node.name}`}
      data-stale={sourceStale || node.status !== "HEALTHY"}
    >
      <header className="detail-heading">
        <div>
          <div className="detail-title">
            <h2>{node.name}</h2>
            <StatusBadge status={node.status} />
          </div>
          <span className="detail-address">
            <Radio size={14} aria-hidden="true" />
            <span>IP VPN: <b>{node.ip_address}</b></span>
            <i aria-hidden="true" />
            {nodeTypeLabel(node.node_type)}
          </span>
        </div>
        {currentUser?.role === "ADMIN" ? (
          <button
            type="button"
            className="button primary"
            onClick={() => onOpenTerminal(node)}
            disabled={node.status === "OFFLINE" || sourceStale}
            title={node.status === "OFFLINE" ? "Máy chủ đang Offline"
              : sourceStale ? "Chưa đồng bộ được với Gateway" : `Mở Web SSH ${node.name}`}
          >
            <Terminal size={16} aria-hidden="true" />
            Mở Web SSH
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        ) : (
          <span className="read-only-label">
            <LockKeyhole size={15} aria-hidden="true" />
            Chỉ xem
          </span>
        )}
      </header>
      <div id="worker-metric-scope" className="worker-metric-scope">
        <span>CPU / RAM / uptime</span>
        <strong>{metricScope}</strong>
      </div>
      {sampleMessage && (
        <div className="worker-source-state" data-state={sampleState} role="status">
          <SourceIcon size={16} aria-hidden="true" />
          <span>{sampleMessage}</span>
        </div>
      )}
      <dl className="worker-sample-meta">
        <div>
          <dt>Mẫu đo</dt>
          <dd>
            <time dateTime={sampleTimeKnown ? metric?.recorded_at : undefined}>
              {formatDateTime(metric?.recorded_at)}
            </time>
          </dd>
        </div>
        <div>
          <dt>Heartbeat gần nhất</dt>
          <dd>
            <time dateTime={node.last_seen || undefined} title={formatDateTime(node.last_seen)}>
              {formatAge(node.last_seen, now)}
            </time>
          </dd>
        </div>
      </dl>
      <div className="worker-resource-stats" role="group" aria-label="Tài nguyên Worker" aria-describedby="worker-metric-scope">
        {[
          { key: "cpu", label: "CPU", icon: Cpu, value: getNodeCpuPercent(node), hint: null },
          { key: "ram", label: "RAM", icon: MemoryStick, value: getNodeRamPercent(node), hint: metric ? `${formatBytes(metric.memory_used_bytes)} / ${formatBytes(metric.memory_total_bytes)}` : null },
          { key: "disk", label: "Ổ đĩa", icon: HardDrive, value: getNodeDiskPercent(node), hint: metric ? `${formatBytes(metric.disk_used_bytes)} / ${formatBytes(metric.disk_total_bytes)}` : null },
        ].map(({ key, label, icon: Icon, value, hint }) => (
          <div className={`worker-resource-stat worker-resource-stat--${key}`} key={key}>
            <span className="worker-resource-label"><Icon size={17} aria-hidden="true" />{label}</span>
            <strong className="worker-resource-value">{value === undefined ? "—" : `${value.toFixed(1)}%`}</strong>
            <span className="worker-resource-meter" aria-hidden="true"><i style={{ width: `${value ?? 0}%` }} /></span>
            <span className="worker-resource-capacity" aria-hidden={!hint}>{hint || "\u00a0"}</span>
          </div>
        ))}
      </div>
      <div className="chart-section">
        <div className="section-heading">
          <h3>
            <Activity size={17} aria-hidden="true" />
            Lịch sử CPU và RAM
          </h3>
        </div>
        {historyError && (
          <div role="alert" className="notice danger">
            <AlertCircle size={16} aria-hidden="true" />
            <span>Không tải được biểu đồ: {historyError}</span>
          </div>
        )}
        {historyLoading ? (
          <div className="chart-loading skeleton" aria-busy="true" aria-label="Đang tải lịch sử CPU và RAM">
            <span>Đang tải biểu đồ…</span>
          </div>
        ) : (
          (!historyError || metricsHistory.length > 0) && (
            <MetricsChart metrics={metricsHistory} />
          )
        )}
      </div>
      <div className="network-metrics" aria-label="Lưu lượng mạng và thời gian chạy của Worker">
        <div>
          <span title="Tổng dữ liệu nhận trên giao diện Agent theo dõi">
            <ArrowDownLeft size={16} aria-hidden="true" />
            RX tích lũy
          </span>
          <strong>{formatBytes(metric?.network_rx_bytes)}</strong>
        </div>
        <div>
          <span title="Tổng dữ liệu gửi trên giao diện Agent theo dõi">
            <ArrowUpRight size={16} aria-hidden="true" />
            TX tích lũy
          </span>
          <strong>{formatBytes(metric?.network_tx_bytes)}</strong>
        </div>
        <div>
          <span>
            <Clock3 size={16} aria-hidden="true" />
            Thời gian chạy
          </span>
          <strong>{formatUptime(metric?.uptime_seconds)}</strong>
        </div>
      </div>
    </section>
  );
};
