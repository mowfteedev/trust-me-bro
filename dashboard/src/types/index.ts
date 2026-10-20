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
  latest_metric?: MetricSnapshot;
}

export interface MetricSnapshot {
  id?: string;
  cpu_percent: number;
  memory_used_bytes: number;
  memory_total_bytes: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  network_rx_bytes?: number;
  network_tx_bytes?: number;
  uptime_seconds?: number;
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

export interface AuditLogItem {
  id: string;
  created_at: string;
  action: string;
  user_id: string | null;
  username: string | null;
  node_id: string | null;
  node_name: string | null;
  ip_address: string | null;
  target: string | null;
  details: {
    attempted_username?: string;
    session_id?: string;
    reason?: string;
    target_ip?: string;
    message?: string;
    cpu_percent?: number;
    threshold?: number;
    ip?: string;
    last_seen?: string | null;
  };
}

export interface AuditLogPage {
  success: boolean;
  data: AuditLogItem[];
  page: number;
  page_size: number;
  has_more: boolean;
}
