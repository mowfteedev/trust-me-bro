import React from "react";
import { Eye, Server, Terminal } from "lucide-react";
import type { NodeItem, UserSession } from "../types/index.js";
import { formatAge, formatBytes, formatDateTime, nodeTypeLabel } from "../utils/format.js";
import { getNodeCpuPercent, getNodeDiskPercent, getNodeRamPercent } from "../utils/fleet.js";
import { StatusBadge } from "./StatusBadge.js";

export interface ServerTableProps {
  nodes: NodeItem[];
  selectedNodeId: string | null;
  currentUser?: UserSession | null;
  now: number;
  sourceStale: boolean;
  onSelectNode: (node: NodeItem) => void;
  onOpenTerminal: (node: NodeItem) => void;
}

function ResourceValue({ value, kind, title }: {
  value: number | undefined;
  kind: "cpu" | "ram" | "disk";
  title?: string;
}) {
  return (
    <div className={`fleet-table-metric fleet-table-metric--${kind}`} title={title}>
      <span className="fleet-table-percent">{value === undefined ? "—" : `${value.toFixed(1)}%`}</span>
      {value !== undefined && (
        <span className="fleet-table-meter" aria-hidden="true">
          <i style={{ width: `${value}%` }} />
        </span>
      )}
    </div>
  );
}

export const ServerTable: React.FC<ServerTableProps> = ({
  nodes, selectedNodeId, currentUser, now, sourceStale, onSelectNode, onOpenTerminal,
}) => (
  <div className="fleet-table-frame">
    <div className="fleet-table-scroll" tabIndex={0} role="region" aria-label="Bảng so sánh máy chủ">
      <table className="fleet-table">
        <thead>
          <tr>
            <th scope="col" className="fleet-table-name-cell">Máy chủ</th>
            <th scope="col">IP VPN</th>
            <th scope="col">Loại máy</th>
            <th scope="col">Trạng thái</th>
            <th scope="col">CPU</th>
            <th scope="col">RAM</th>
            <th scope="col">Ổ đĩa</th>
            <th scope="col">Heartbeat gần nhất</th>
            <th scope="col">Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => {
            const selected = node.id === selectedNodeId;
            const metric = node.latest_metric;
            const oldData = sourceStale || node.status !== "HEALTHY";
            const sshDisabled = node.status === "OFFLINE" || sourceStale;
            const sshHint = node.status === "OFFLINE" ? "Máy chủ đang Offline"
              : sourceStale ? "Chưa đồng bộ được với Gateway" : `Mở Web SSH ${node.name}`;
            return (
              <tr key={node.id} data-selected={selected} data-stale={oldData}>
                <th scope="row" className="fleet-table-name-cell">
                  <button
                    type="button"
                    className="fleet-table-select"
                    aria-label={`Xem tài nguyên ${node.name}`}
                    aria-pressed={selected}
                    onClick={() => onSelectNode(node)}
                  >
                    <Server size={17} aria-hidden="true" />
                    <span className="fleet-table-identity">
                      <strong>{node.name}</strong>
                      {selected && <span className="fleet-table-selected-label">Đang xem</span>}
                    </span>
                  </button>
                </th>
                <td><span className="fleet-table-ip">{node.ip_address}</span></td>
                <td><span className="fleet-table-type">{nodeTypeLabel(node.node_type)}</span></td>
                <td><StatusBadge status={node.status} /></td>
                <td><ResourceValue value={getNodeCpuPercent(node)} kind="cpu" title={`Mẫu: ${formatDateTime(metric?.recorded_at)}`} /></td>
                <td><ResourceValue value={getNodeRamPercent(node)} kind="ram" title={`${formatBytes(metric?.memory_used_bytes)} / ${formatBytes(metric?.memory_total_bytes)}`} /></td>
                <td><ResourceValue value={getNodeDiskPercent(node)} kind="disk" title={`${formatBytes(metric?.disk_used_bytes)} / ${formatBytes(metric?.disk_total_bytes)}`} /></td>
                <td className="fleet-table-heartbeat">
                  <span title={`Heartbeat: ${formatDateTime(node.last_seen)}`}>{formatAge(node.last_seen, now)}</span>
                  {oldData && <span className="fleet-table-stale-label">{sourceStale ? "Chưa đồng bộ" : "Số liệu gần nhất"}</span>}
                </td>
                <td>
                  {currentUser?.role === "ADMIN" ? (
                    <button
                      type="button"
                      className="fleet-table-ssh"
                      disabled={sshDisabled}
                      title={sshHint}
                      aria-label={`Mở Web SSH ${node.name}`}
                      onClick={() => onOpenTerminal(node)}
                    >
                      <Terminal size={15} aria-hidden="true" /> Web SSH
                    </button>
                  ) : (
                    <span className="fleet-table-viewer viewer-label"><Eye size={14} aria-hidden="true" /> Chỉ xem</span>
                  )}
                </td>
              </tr>
            );
          })}
          {nodes.length === 0 && (
            <tr><td colSpan={9} className="fleet-table-empty">Không có máy chủ phù hợp với bộ lọc.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  </div>
);
