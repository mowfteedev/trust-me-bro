import React from "react";
import { NodeStatus } from "../types/index.js";

export const StatusBadge: React.FC<{ status: NodeStatus }> = ({ status }) => (
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
