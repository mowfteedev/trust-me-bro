/**
 * ==============================================================================
 * HỢP ĐỒNG DỮ LIỆU GIAO DIỆN NGƯỜI DÙNG (types/index.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: frontend (chủ trì), backend
 * ==============================================================================
 */

export type NodeStatus = 'HEALTHY' | 'WARNING' | 'OFFLINE';
export type NodeType = 'DOCKER' | 'VM' | 'BARE_METAL';
export type UserRole = 'ADMIN' | 'VIEWER';

export interface UserSession {
  id: string;
  username: string;
  role: UserRole;
}

export interface NodeItem {
  id: string;
  name: string;
  ip_address: string;
  node_type: NodeType;
  status: NodeStatus;
  last_seen: string | null;
  created_at: string;
}

export interface MetricSnapshot {
  id: string;
  cpu_percent: number;
  memory_used_bytes: number;
  memory_total_bytes: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  recorded_at: string;
}

export interface ClusterSummary {
  total: number;
  healthy: number;
  warning: number;
  offline: number;
  avgCpu: number;
  avgMemory: number;
}
