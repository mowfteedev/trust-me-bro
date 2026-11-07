import type { NodeItem, NodeStatus } from "../types/index.js";

export type FleetSort = "name" | "status" | "cpu" | "ram";

const STATUS_PRIORITY: Record<NodeStatus, number> = {
  OFFLINE: 0,
  WARNING: 1,
  HEALTHY: 2,
};

export function getNodeCpuPercent(node: NodeItem): number | undefined {
  const value = node.latest_metric?.cpu_percent;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value : undefined;
}

function usagePercent(used: number | undefined, total: number | undefined): number | undefined {
  if (used === undefined || total === undefined || !Number.isFinite(used)
      || !Number.isFinite(total) || used < 0 || total <= 0 || used > total) return undefined;
  return used / total * 100;
}

export function getNodeRamPercent(node: NodeItem): number | undefined {
  return usagePercent(node.latest_metric?.memory_used_bytes, node.latest_metric?.memory_total_bytes);
}

export function getNodeDiskPercent(node: NodeItem): number | undefined {
  return usagePercent(node.latest_metric?.disk_used_bytes, node.latest_metric?.disk_total_bytes);
}

function compareName(a: NodeItem, b: NodeItem): number {
  return a.name.localeCompare(b.name, "vi", { numeric: true, sensitivity: "base" });
}

function descendingKnown(a: number | undefined, b: number | undefined): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return b - a;
}

// Keep API objects and statuses intact so filtering/sorting cannot change selection or liveness.
export function filterAndSortNodes(
  nodes: NodeItem[], search: string, statusFilter: string, sort: FleetSort,
): NodeItem[] {
  const query = search.trim().toLowerCase();
  return nodes.filter((node) =>
    (statusFilter === "ALL" || node.status === statusFilter)
    && (node.name.toLowerCase().includes(query) || node.ip_address.toLowerCase().includes(query)),
  ).sort((a, b) => {
    let order = 0;
    if (sort === "status") order = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (sort === "cpu") order = descendingKnown(getNodeCpuPercent(a), getNodeCpuPercent(b));
    if (sort === "ram") order = descendingKnown(getNodeRamPercent(a), getNodeRamPercent(b));
    return order || compareName(a, b);
  });
}
