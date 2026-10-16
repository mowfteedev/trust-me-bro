import React, { useState, useEffect } from "react";
import { NodeItem, MetricSnapshot, UserSession } from "../types/index.js";
import { NodeCard } from "./NodeCard.js";
import { MetricsChart } from "./MetricsChart.js";
import { StatusBadge } from "./StatusBadge.js";
import { api } from "../services/api.js";
import { formatBytes, formatUptime, formatTime } from "../utils/format.js";
import {
  Server,
  Activity,
  AlertCircle,
  RefreshCw,
  Search,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Layers,
  Terminal,
  Cpu,
  MemoryStick,
  HardDrive,
  ArrowDownLeft,
  ArrowUpRight,
  Clock3,
  Info,
  Radio,
  LockKeyhole,
} from "lucide-react";

interface ClusterOverviewProps {
  currentUser?: UserSession | null;
  onOpenTerminal: (node: NodeItem) => void;
  focusSection?: "dashboard" | "fleet";
}

export const ClusterOverview: React.FC<ClusterOverviewProps> = ({
  currentUser,
  onOpenTerminal,
  focusSection = "dashboard",
}) => {
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [selectedNode, setSelectedNode] = useState<NodeItem | null>(null);
  const [metricsHistory, setMetricsHistory] = useState<MetricSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (isLoading) return;
    document
      .getElementById(
        focusSection === "fleet" ? "server-fleet" : "cluster-overview",
      )
      ?.scrollIntoView({ behavior: "smooth" });
  }, [focusSection, isLoading]);

  const fetchClusterData = async (isManual = false) => {
    if (isManual) setIsRefreshing(true);
    try {
      const data = await api.getNodes();
      setNodes(data);
      setErrorMessage(null);
      setSelectedNode(
        (prev) => data.find((n) => n.id === prev?.id) ?? data[0] ?? null,
      );
    } catch (err: any) {
      setErrorMessage(
        err.message || "Không thể kết nối tới Control Plane Gateway",
      );
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    setMetricsHistory([]);
    setHistoryError(null);
    if (!selectedNode) return;
    setHistoryLoading(true);
    let isCurrent = true;
    const fetchHistory = () => {
      api
        .getNodeHistory(selectedNode.id)
        .then((data) => {
          if (isCurrent) {
            setMetricsHistory(data);
            setHistoryError(null);
            setHistoryLoading(false);
          }
        })
        .catch((err: Error) => {
          if (isCurrent) {
            setHistoryError(
              err.message || "Không tải được lịch sử tài nguyên.",
            );
            setHistoryLoading(false);
          }
        });
    };
    fetchHistory();
    const historyTimer = setInterval(fetchHistory, 3000);
    return () => {
      isCurrent = false;
      clearInterval(historyTimer);
    };
  }, [selectedNode?.id]);

  useEffect(() => {
    fetchClusterData();
    const timer = setInterval(() => fetchClusterData(), 5000);
    return () => clearInterval(timer);
  }, []);

  const filteredNodes = nodes.filter(
    (n) =>
      n.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      n.ip_address.toLowerCase().includes(searchQuery.toLowerCase()),
  );
  const counts = [
    {
      label: "Tổng máy chủ",
      value: nodes.length,
      hint: "Máy chủ trong cụm",
      icon: Layers,
      color: "neutral",
    },
    {
      label: "Online",
      value: nodes.filter((n) => n.status === "HEALTHY").length,
      hint: "Đang nhận heartbeat",
      icon: CheckCircle2,
      color: "success",
    },
    {
      label: "Stale",
      value: nodes.filter((n) => n.status === "WARNING").length,
      hint: "Heartbeat bị trễ",
      icon: AlertTriangle,
      color: "warning",
    },
    {
      label: "Offline",
      value: nodes.filter((n) => n.status === "OFFLINE").length,
      hint: "Mất tín hiệu",
      icon: XCircle,
      color: "danger",
    },
  ];
  const metric = selectedNode?.latest_metric;
  const resources = [
    {
      label: "CPU",
      icon: Cpu,
      value: metric?.cpu_percent,
      hint: "Mức sử dụng bộ xử lý",
      color: "cpu",
    },
    {
      label: "Bộ nhớ RAM",
      icon: MemoryStick,
      value:
        metric && metric.memory_total_bytes > 0
          ? (metric.memory_used_bytes / metric.memory_total_bytes) * 100
          : undefined,
      hint: metric
        ? `${formatBytes(metric.memory_used_bytes)} / ${formatBytes(metric.memory_total_bytes)}`
        : "Chưa nhận số liệu",
      color: "memory",
    },
    {
      label: "Ổ đĩa",
      icon: HardDrive,
      value:
        metric && metric.disk_total_bytes > 0
          ? (metric.disk_used_bytes / metric.disk_total_bytes) * 100
          : undefined,
      hint: metric
        ? `${formatBytes(metric.disk_used_bytes)} / ${formatBytes(metric.disk_total_bytes)}`
        : "Chưa nhận số liệu",
      color: "disk",
    },
  ];
  const pageHeading = (
    <div className="page-heading">
      <div>
        <span className="eyebrow">
          <span className="accent-dash" /> CONTROL CENTER
        </span>
        <h1>
          Giám sát hạ tầng<span className="heading-dot">.</span>
        </h1>
        <p>Trạng thái kết nối và tài nguyên, trong một góc nhìn.</p>
      </div>
      <button
        className="button secondary"
        aria-label="Làm mới"
        title="Làm mới dữ liệu"
        onClick={() => fetchClusterData(true)}
        disabled={isRefreshing || isLoading}
      >
        <RefreshCw size={15} className={isRefreshing ? "animate-spin" : ""} />
        <span>Làm mới</span>
      </button>
    </div>
  );

  if (isLoading)
    return (
      <div
        className="overview"
        aria-busy="true"
        aria-label="Đang tải dữ liệu cụm"
      >
        {pageHeading}
        <div className="summary-grid">
          {[1, 2, 3, 4].map((i) => (
            <div className="skeleton summary-skeleton" key={i} />
          ))}
        </div>
        <div className="monitor-layout">
          <div className="skeleton fleet-skeleton" />
          <div className="skeleton detail-skeleton" />
        </div>
      </div>
    );

  if (errorMessage && nodes.length === 0)
    return (
      <div className="overview">
        {pageHeading}
        <section className="state-panel">
          <span className="state-icon danger">
            <AlertCircle size={30} />
          </span>
          <span className="eyebrow">CONNECTION ERROR</span>
          <h2>Không thể kết nối với Gateway</h2>
          <p>{errorMessage}</p>
          <button
            className="button primary"
            onClick={() => fetchClusterData(true)}
            disabled={isRefreshing}
          >
            <RefreshCw
              size={16}
              className={isRefreshing ? "animate-spin" : ""}
            />
            Thử lại ngay
          </button>
        </section>
      </div>
    );

  if (nodes.length === 0)
    return (
      <div className="overview">
        {pageHeading}
        <section className="state-panel">
          <span className="state-icon">
            <Server size={30} />
          </span>
          <span className="eyebrow">SERVER INVENTORY</span>
          <h2>Sẵn sàng cho máy chủ đầu tiên</h2>
          <p>
            Cấu hình WireGuard và Mini-Agent theo README của dự án. Máy chủ sẽ
            xuất hiện khi Gateway nhận được heartbeat hợp lệ.
          </p>
          <button
            className="button secondary"
            onClick={() => fetchClusterData(true)}
            disabled={isRefreshing}
          >
            <RefreshCw
              size={16}
              className={isRefreshing ? "animate-spin" : ""}
            />
            Làm mới danh sách
          </button>
        </section>
      </div>
    );

  return (
    <div className="overview">
      {pageHeading}
      {errorMessage && (
        <div role="alert" className="notice warning">
          <AlertTriangle size={17} />
          <span>
            Không cập nhật được dữ liệu: {errorMessage} Số liệu bên dưới là lần
            tải thành công gần nhất.
          </span>
          <button
            onClick={() => fetchClusterData(true)}
            disabled={isRefreshing}
          >
            Thử lại
          </button>
        </div>
      )}
      <section className="summary-grid" aria-label="Trạng thái cụm máy chủ">
        {counts.map(({ label, value, hint, icon: Icon, color }) => (
          <div className={`summary-card ${color}`} key={label}>
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
                    width: `${nodes.length ? (value / nodes.length) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          </div>
        ))}
      </section>
      <div className="monitor-layout">
        <section
          id="server-fleet"
          className="fleet-panel panel"
          aria-labelledby="fleet-title"
        >
          <div className="panel-heading">
            <div>
              <span className="eyebrow">SERVER INVENTORY</span>
              <h2 id="fleet-title">
                Máy chủ <span className="count-badge">{nodes.length}</span>
              </h2>
            </div>
            <Server size={19} className="muted" />
          </div>
          <div className="fleet-search">
            <Search size={16} />
            <input
              aria-label="Tìm máy chủ"
              placeholder="Tìm tên hoặc IP máy chủ..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="node-list">
            {filteredNodes.length === 0 ? (
              <div className="search-empty">
                <Search size={25} />
                <strong>Không tìm thấy máy chủ</strong>
                <span>Thử tên hoặc địa chỉ IP khác.</span>
                <button onClick={() => setSearchQuery("")}>Xóa tìm kiếm</button>
              </div>
            ) : (
              filteredNodes.map((node) => (
                <NodeCard
                  key={node.id}
                  node={node}
                  latestMetric={node.latest_metric}
                  currentUser={currentUser}
                  isSelected={selectedNode?.id === node.id}
                  onSelectNode={setSelectedNode}
                  onOpenTerminal={onOpenTerminal}
                />
              ))
            )}
          </div>
          <div className="fleet-help">
            <Info size={15} />
            <span>
              Chọn máy chủ để xem tài nguyên. <br />
              Trạng thái kết nối được xác định theo heartbeat.
            </span>
          </div>
        </section>
        {selectedNode && (
          <section
            className="detail-panel panel"
            aria-label={`Tài nguyên ${selectedNode.name}`}
          >
            <div className="detail-heading">
              <div>
                <span className="eyebrow">NODE OBSERVABILITY</span>
                <div className="detail-title">
                  <h2>{selectedNode.name}</h2>
                  <StatusBadge status={selectedNode.status} />
                </div>
                <span className="detail-address">
                  <Radio size={13} />
                  {selectedNode.ip_address}
                  <i />
                  {selectedNode.node_type}
                </span>
              </div>
              {currentUser?.role === "ADMIN" ? (
                <button
                  className="button primary"
                  onClick={() => onOpenTerminal(selectedNode)}
                  disabled={selectedNode.status === "OFFLINE"}
                >
                  <Terminal size={16} />
                  Mở Web SSH
                  <ArrowUpRight size={14} />
                </button>
              ) : (
                <span className="read-only-label">
                  <LockKeyhole size={14} />
                  Chế độ chỉ đọc
                </span>
              )}
            </div>
            {selectedNode.status !== "HEALTHY" && metric && (
              <div className="notice warning">
                <AlertTriangle size={16} />
                <span>Số liệu lần cuối; máy chủ chưa có heartbeat mới.</span>
              </div>
            )}
            <div className="resource-grid">
              {resources.map(({ label, icon: Icon, value, hint, color }) => (
                <div className="resource-tile" key={label}>
                  <div className="resource-label">
                    <Icon size={15} />
                    <span>{label}</span>
                  </div>
                  <div className="resource-value">
                    {value === undefined ? "—" : value.toFixed(1)}
                    {value !== undefined && <small>%</small>}
                  </div>
                  <div className="meter">
                    <i
                      className={
                        value !== undefined && value >= 85 ? "high" : color
                      }
                      style={{
                        width: `${Math.min(100, Math.max(0, value ?? 0))}%`,
                      }}
                    />
                  </div>
                  <span className="resource-hint">{hint}</span>
                </div>
              ))}
            </div>
            <div className="chart-section">
              <div className="section-heading">
                <h3>
                  <Activity size={16} />
                  Lịch sử tài nguyên
                </h3>
                <span>30 mẫu gần nhất</span>
              </div>
              {historyError && (
                <div role="alert" className="notice danger">
                  <AlertCircle size={16} />
                  <span>
                    Không tải được biểu đồ: {historyError} Hệ thống sẽ tự thử
                    lại.
                  </span>
                </div>
              )}
              {historyLoading ? (
                <div className="chart-loading skeleton" aria-busy="true">
                  <span>Đang tải lịch sử tài nguyên...</span>
                </div>
              ) : (
                (!historyError || metricsHistory.length > 0) && (
                  <MetricsChart metrics={metricsHistory} />
                )
              )}
            </div>
            <div className="network-metrics">
              <div>
                <span>
                  <ArrowDownLeft size={16} />
                  Network RX
                </span>
                <strong>{formatBytes(metric?.network_rx_bytes)}</strong>
              </div>
              <div>
                <span>
                  <ArrowUpRight size={16} />
                  Network TX
                </span>
                <strong>{formatBytes(metric?.network_tx_bytes)}</strong>
              </div>
              <div>
                <span>
                  <Clock3 size={16} />
                  Uptime
                </span>
                <strong>{formatUptime(metric?.uptime_seconds)}</strong>
              </div>
            </div>
            <div className="detail-footnote">
              <span>RX/TX: byte tích lũy trên giao diện Agent chọn, không phải byte/s.</span>
              <span>
                Heartbeat: <b>{formatTime(selectedNode.last_seen)}</b>
              </span>
            </div>
          </section>
        )}
      </div>
      <div className="overview-note">
        <Info size={14} />
        <span>
          Online / Stale / Offline phản ánh heartbeat của máy chủ. Mức tải CPU
          được theo dõi riêng. CPU, RAM và uptime đo Linux host; trong Docker
          dùng host chung. Ổ đĩa đo filesystem tại mount của Agent.
        </span>
        <span className="polling-label">Tự cập nhật mỗi 5 giây</span>
      </div>
    </div>
  );
};
