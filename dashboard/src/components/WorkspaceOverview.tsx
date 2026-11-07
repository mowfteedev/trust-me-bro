import React from "react";
import { Activity, ArrowRight, AlertTriangle, Clock3, Server } from "lucide-react";
import { MetricSnapshot, NodeItem } from "../types/index.js";
import { formatAge, formatDateTime, formatUptime, nodeTypeLabel } from "../utils/format.js";
import { StatusBadge } from "./StatusBadge.js";
import { ResourceGauges } from "./ResourceGauges.js";
import { HeartbeatStrip } from "./HeartbeatStrip.js";
import { MetricsChart } from "./MetricsChart.js";

interface WorkspaceOverviewProps {
  nodes: NodeItem[];
  selectedNode: NodeItem | null;
  metricsHistory: MetricSnapshot[];
  historyLoading: boolean;
  historyError: string | null;
  now: number;
  sourceStale: boolean;
  onOpenNode: (node: NodeItem) => void;
  onViewFleet: () => void;
}

export const WorkspaceOverview: React.FC<WorkspaceOverviewProps> = ({
  nodes, selectedNode, metricsHistory, historyLoading, historyError,
  now, sourceStale, onOpenNode, onViewFleet,
}) => {
  const attention = nodes.filter(node => node.status !== "HEALTHY")
    .sort((a, b) => Number(b.status === "OFFLINE") - Number(a.status === "OFFLINE")
      || a.name.localeCompare(b.name));
  const metric = selectedNode?.latest_metric;
  const scope = selectedNode?.node_type === "DOCKER" ? "Host Docker" : "Hệ điều hành Worker";

  return (
    <div className="workspace-overview">
      {attention.length > 0 && (
        <section className="panel overview-attention" aria-labelledby="attention-title">
          <div className="workspace-panel-heading">
            <h2 id="attention-title"><AlertTriangle size={18} /> Máy cần chú ý <span className="count-badge">{attention.length}</span></h2>
          </div>
          <ul className="overview-attention-list">
            {attention.slice(0, 5).map(node => (
              <li key={node.id}>
                <button onClick={() => onOpenNode(node)} aria-label={`Xem tình trạng ${node.name}`}>
                  <span><strong>{node.name}</strong><small>{node.ip_address} · {formatAge(node.last_seen, now)}</small></span>
                  <StatusBadge status={node.status} /><ArrowRight size={16} />
                </button>
              </li>
            ))}
          </ul>
          {attention.length > 5 && <button className="overview-fleet-link" onClick={onViewFleet}>Xem danh sách <ArrowRight size={15} /></button>}
        </section>
      )}

      {selectedNode && <>
        <section className="panel overview-resource-panel" aria-labelledby="resource-title">
          <div className="workspace-panel-heading">
            <div className="overview-resource-heading">
              <h2 id="resource-title">{selectedNode.name}</h2>
              <span className="overview-resource-scope">CPU / RAM · {scope}</span>
            </div>
            <button className="overview-fleet-link" onClick={() => onOpenNode(selectedNode)}>Chi tiết <ArrowRight size={16} /></button>
          </div>
          <ResourceGauges node={selectedNode} stale={sourceStale || selectedNode.status !== "HEALTHY"} />
          <time className="overview-sample-time" dateTime={metric?.recorded_at}>Mẫu đo {formatDateTime(metric?.recorded_at)}</time>
        </section>
        <section className="panel overview-heartbeat" aria-label={`Heartbeat ${selectedNode.name}`}>
          <HeartbeatStrip node={selectedNode} metrics={metricsHistory} now={Date.now()}
            loading={historyLoading} error={historyError} sourceStale={sourceStale} />
          <div className="overview-uptime" title={selectedNode.node_type === "DOCKER" ? "Thời gian chạy của host Docker" : "Thời gian chạy của hệ điều hành Worker"}>
            <span><Clock3 size={14} /> Thời gian chạy</span><strong>{formatUptime(metric?.uptime_seconds)}</strong>
          </div>
        </section>
      </>}

      <section className="panel overview-machines" aria-labelledby="overview-machines-title">
        <div className="workspace-panel-heading">
          <h2 id="overview-machines-title">Máy chủ</h2>
          <button className="overview-fleet-link" onClick={onViewFleet}>Xem tất cả máy chủ <ArrowRight size={16} /></button>
        </div>
        <div className="overview-worker-grid">
          {nodes.slice(0, 6).map(node => (
            <button key={node.id} className="overview-worker-node" onClick={() => onOpenNode(node)}
              aria-label={`Xem tài nguyên ${node.name}`}>
              <Server size={18} aria-hidden="true" />
              <span className="overview-worker-identity"><strong>{node.name}</strong><small>{node.ip_address} · {nodeTypeLabel(node.node_type)}</small></span>
              <StatusBadge status={node.status} />
            </button>
          ))}
        </div>
      </section>
      {selectedNode && (
        <section className="panel overview-trend" aria-labelledby="overview-trend-title">
          <div className="workspace-panel-heading"><h2 id="overview-trend-title"><Activity size={18} /> CPU và RAM</h2></div>
          {historyError && <p className="overview-history-error" role="alert">{historyError}</p>}
          {historyLoading ? <div className="chart-loading skeleton" aria-busy="true">Đang tải biểu đồ…</div>
            : <MetricsChart metrics={metricsHistory} />}
        </section>
      )}
    </div>
  );
};
