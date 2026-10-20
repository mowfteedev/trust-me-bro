import React from "react";
import { NodeItem, MetricSnapshot, UserSession } from "../types/index.js";
import { Server, Terminal, ChevronRight } from "lucide-react";
import { StatusBadge } from "./StatusBadge.js";
import { formatAge, formatDateTime, nodeTypeLabel } from "../utils/format.js";

interface NodeCardProps {
  node: NodeItem;
  latestMetric?: MetricSnapshot;
  currentUser?: UserSession | null;
  onOpenTerminal: (node: NodeItem) => void;
  onSelectNode: (node: NodeItem) => void;
  isSelected?: boolean;
  now: number;
  sourceStale?: boolean;
}

export const NodeCard: React.FC<NodeCardProps> = ({
  node,
  latestMetric,
  currentUser,
  onOpenTerminal,
  onSelectNode,
  isSelected = false,
  now,
  sourceStale = false,
}) => {
  const cpu = latestMetric?.cpu_percent;
  const memory =
    latestMetric && latestMetric.memory_total_bytes > 0
      ? (latestMetric.memory_used_bytes / latestMetric.memory_total_bytes) * 100
      : undefined;
  return (
    <article className={`node-card ${isSelected ? "selected" : ""}`} data-stale={sourceStale || node.status !== "HEALTHY"}>
      <button
        className="node-select"
        onClick={() => onSelectNode(node)}
        aria-pressed={isSelected}
        aria-label={`Xem tài nguyên ${node.name}`}
      >
        <div className="node-card-top">
          <span className="node-icon">
            <Server size={19} />
          </span>
          <StatusBadge status={node.status} />
        </div>
        <div className="node-name">
          <strong>{node.name}</strong>
          <ChevronRight size={16} />
        </div>
        <span className="node-address">{node.ip_address}</span>
        <span className="node-freshness" title={`Heartbeat: ${formatDateTime(node.last_seen)}`}>
          {formatAge(node.last_seen, now)}
          {(sourceStale || node.status !== "HEALTHY") && " · số liệu cũ"}
        </span>
        <div className="node-mini-metrics">
          {[
            { label: "CPU", value: cpu, color: "cpu" },
            { label: "RAM", value: memory, color: "memory" },
          ].map(({ label, value, color }) => (
            <div key={label}>
              <span>
                {label}
                <b>{value === undefined ? "—" : `${value.toFixed(1)}%`}</b>
              </span>
              <div className="meter">
                <i
                  className={color}
                  style={{
                    width: `${Math.min(100, Math.max(0, value ?? 0))}%`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </button>
      <div className="node-card-footer">
        <span>
          {nodeTypeLabel(node.node_type)}
        </span>
        {currentUser?.role === "ADMIN" ? (
          <button
            className="node-ssh"
            onClick={() => onOpenTerminal(node)}
            disabled={node.status === "OFFLINE"}
            title={
              node.status === "OFFLINE" ? "Máy chủ đang Offline" : "Mở Web SSH"
            }
          >
            <Terminal size={14} />
            Web SSH
          </button>
        ) : (
          <span className="viewer-label">Chỉ đọc (Viewer)</span>
        )}
      </div>
    </article>
  );
};
