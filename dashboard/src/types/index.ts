export type NodeStatus = 'HEALTHY' | 'WARNING' | 'OFFLINE';
export type NodeType = 'DOCKER' | 'VM' | 'BARE_METAL';
export type UserRole = 'ADMIN' | 'VIEWER';

export interface UserSession {
  id: string;
  username: string;
  role: UserRole;
}

export interface ManagedUser extends UserSession {
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DeliveryStatus {
  status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'DRY_RUN' | 'DISABLED';
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
}

export interface Incident {
  id: string;
  node_id: string;
  node_name: string | null;
  ip_address: string | null;
  type: 'NODE_OFFLINE' | 'CPU_HIGH' | 'OTHER';
  severity: string;
  message: string;
  created_at: string;
  resolved_at: string | null;
  duration_seconds: number;
  opening_delivery: DeliveryStatus | null;
  recovery_delivery: DeliveryStatus | null;
}

export interface IncidentPage {
  success: boolean;
  data: Incident[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
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
  lifecycle_state?: 'ACTIVE' | 'RETIRING' | 'REVOKED' | 'REMOVED';
  is_token_revoked?: boolean;
  is_enrolled?: boolean;
}

export type NodeLifecycleFilter = 'active' | 'removing' | 'removed' | 'all';
export type NodeLifecycleState = 'ACTIVE' | 'RETIRING' | 'REVOKED' | 'REMOVED';
export type OffboardingState = 'PENDING_PEER_REMOVAL' | 'PENDING_LOCAL_CLEANUP' | 'NEEDS_REVIEW' | 'COMPLETED';

export interface OffboardingOperation {
  operation_id: string;
  node_id: string;
  node_name: string;
  node_ip: string;
  node_type?: NodeType;
  worker_os?: string;
  wireguard_public_key?: string;
  state: OffboardingState;
  lifecycle_state?: NodeLifecycleState;
  created_at: string;
  peer_removed_at?: string | null;
  completed_at?: string | null;
  last_error?: string | null;
  has_cleanup_token?: boolean;
}

export interface OffboardingStatusResponse {
  success: boolean;
  status?: string;
  offboarding?: OffboardingOperation | null;
  operation?: OffboardingOperation | null;
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


export type HostServiceState = 'healthy' | 'running' | 'unhealthy' | 'stopped' | 'unknown';
export interface HostServiceObservation {
  at: string;
  state: HostServiceState;
}
export interface HostService {
  id: 'gateway' | 'proxy' | 'postgres' | 'wireguard_gateway';
  name: string;
  state: HostServiceState;
  started_at: string | null;
  restarts: number;
  observations: HostServiceObservation[];
}
export interface HostSnapshot {
  sampled_at: string;
  stale: boolean;
  host: {
    hostname: string;
    cpu_percent: number | null;
    memory_used_bytes: number;
    memory_total_bytes: number;
    disk_used_bytes: number;
    disk_total_bytes: number;
    uptime_seconds: number;
    network_rx_bytes: number;
    network_tx_bytes: number;
    network_interface: string;
  };
  services: HostService[];
}
