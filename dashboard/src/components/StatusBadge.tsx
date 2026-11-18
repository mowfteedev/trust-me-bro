import React from "react";
import { NodeLifecycleState, NodeStatus } from "../types/index.js";

export const StatusBadge: React.FC<{
  status: NodeStatus;
  lifecycleState?: NodeLifecycleState;
}> = ({ status, lifecycleState }) => {
  if (lifecycleState === "REMOVED") {
    return (
      <span className="status-badge neutral" data-lifecycle="REMOVED">
        <i />
        Đã gỡ
      </span>
    );
  }
  if (lifecycleState === "RETIRING" || lifecycleState === "REVOKED") {
    return (
      <span className="status-badge warning" data-lifecycle={lifecycleState}>
        <i />
        Đang gỡ
      </span>
    );
  }
  return (
    <span
      className={`status-badge ${status === "HEALTHY" ? "success" : status === "WARNING" ? "warning" : "danger"}`}
    >
      <i />
      {status === "HEALTHY"
        ? "Online"
        : status === "WARNING"
          ? "Stale"
          : "Offline"}
    </span>
  );
};
