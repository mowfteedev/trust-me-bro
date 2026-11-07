import React from "react";
import { Cpu, HardDrive, MemoryStick } from "lucide-react";
import type { NodeItem } from "../types/index.js";
import { getNodeCpuPercent, getNodeDiskPercent, getNodeRamPercent } from "../utils/fleet.js";
import { formatBytes } from "../utils/format.js";

interface ResourceGaugesProps {
  node: NodeItem;
  stale?: boolean;
}

export const ResourceGauges: React.FC<ResourceGaugesProps> = ({ node, stale = false }) => {
  const metric = node.latest_metric;
  const ram = getNodeRamPercent(node);
  const disk = getNodeDiskPercent(node);
  const oldData = stale || node.status !== "HEALTHY";
  const resources = [
    { key: "cpu", label: "CPU", icon: Cpu, value: getNodeCpuPercent(node), hint: null },
    {
      key: "ram", label: "RAM", icon: MemoryStick, value: ram,
      hint: ram === undefined ? "—" : `${formatBytes(metric?.memory_used_bytes)} / ${formatBytes(metric?.memory_total_bytes)}`,
    },
    {
      key: "disk", label: "Ổ đĩa", icon: HardDrive, value: disk,
      hint: disk === undefined ? "—" : `${formatBytes(metric?.disk_used_bytes)} / ${formatBytes(metric?.disk_total_bytes)}`,
    },
  ];

  return (
    <div className="resource-gauges" data-stale={oldData} data-node-id={node.id}
      data-sample-at={metric?.recorded_at}>
      {resources.map(({ key, label, icon: Icon, value, hint }) => {
        const text = value === undefined ? "Chưa có số liệu" : `${value.toFixed(1)}%`;
        const description = `${label}: ${text}${oldData ? ", số liệu gần nhất" : ""}`;
        return (
          <article className={`resource-gauge resource-gauge--${key}`} key={key}>
            <div className="resource-gauge-label"><Icon size={15} aria-hidden="true" /><span>{label}</span></div>
            <svg viewBox="0 0 160 112" role="img" aria-label={description} data-resource={key}>
              <title>{description}</title>
              <g aria-hidden="true">
                <path className="resource-gauge-track" d="M 16 84 A 64 64 0 0 1 144 84" pathLength="100" />
                {value !== undefined && value > 0 && (
                  <path className="resource-gauge-fill" d="M 16 84 A 64 64 0 0 1 144 84" pathLength="100"
                    strokeDasharray={`${value} 100`} />
                )}
                <text className="resource-gauge-value" x="80" y="80" textAnchor="middle">
                  {value === undefined ? "—" : value.toFixed(1)}
                  {value !== undefined && <tspan className="resource-gauge-unit">%</tspan>}
                </text>
                <text className="resource-gauge-scale" x="16" y="108" textAnchor="middle">0</text>
                <text className="resource-gauge-scale" x="144" y="108" textAnchor="middle">100</text>
              </g>
            </svg>
            <span className="resource-gauge-hint" aria-hidden={hint === null}>{hint ?? "\u00a0"}</span>
          </article>
        );
      })}
    </div>
  );
};
