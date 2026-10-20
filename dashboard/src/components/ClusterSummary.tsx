import React from "react";
import { AlertTriangle, CheckCircle2, Layers, XCircle } from "lucide-react";
import { NodeItem } from "../types/index.js";

export function getClusterCounts(nodes: NodeItem[]) {
  return [
    {
      label: "Tổng máy chủ",
      status: "ALL",
      value: nodes.length,
      hint: "Máy chủ trong cụm",
      icon: Layers,
      color: "neutral",
    },
    {
      label: "Online",
      status: "HEALTHY",
      value: nodes.filter((n) => n.status === "HEALTHY").length,
      hint: "Đang nhận heartbeat",
      icon: CheckCircle2,
      color: "success",
    },
    {
      label: "Stale",
      status: "WARNING",
      value: nodes.filter((n) => n.status === "WARNING").length,
      hint: "Heartbeat bị trễ",
      icon: AlertTriangle,
      color: "warning",
    },
    {
      label: "Offline",
      status: "OFFLINE",
      value: nodes.filter((n) => n.status === "OFFLINE").length,
      hint: "Mất tín hiệu",
      icon: XCircle,
      color: "danger",
    },
  ];
}

interface ClusterSummaryProps {
  counts: ReturnType<typeof getClusterCounts>;
  total: number;
  statusFilter: string;
  onFilterChange: (status: string) => void;
}

export const ClusterSummary: React.FC<ClusterSummaryProps> = ({
  counts,
  total,
  statusFilter,
  onFilterChange,
}) => (
  <section className="summary-grid" aria-label="Trạng thái cụm máy chủ">
    {counts.map(({ label, status, value, hint, icon: Icon, color }) => (
      <button
        className={`summary-card ${color} ${statusFilter === status ? "is-active" : ""}`}
        key={label}
        aria-label={`Lọc ${label}: ${value} máy chủ`}
        aria-pressed={statusFilter === status}
        onClick={() => onFilterChange(status)}
      >
        <div className="summary-top">
          <span>{label}</span>
          <span className="summary-icon">
            <Icon size={18} />
          </span>
        </div>
        <div className="summary-value">
          {value.toString().padStart(2, "0")}
          <span>máy chủ</span>
        </div>
        <div className="summary-bottom">
          <span>{hint}</span>
          <div className="summary-meter">
            <i
              style={{
                width: `${total ? (value / total) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      </button>
    ))}
  </section>
);
