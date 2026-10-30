import React, { useEffect, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Info,
  RefreshCw,
  Search,
  Server,
} from "lucide-react";
import { NodeItem, UserSession } from "../types/index.js";
import { useClusterData } from "../hooks/useClusterData.js";
import { useNodeHistory } from "../hooks/useNodeHistory.js";
import { formatDateTime, formatTime } from "../utils/format.js";
import { ClusterSummary, getClusterCounts } from "./ClusterSummary.js";
import { NodeCard } from "./NodeCard.js";
import { NodeDetails } from "./NodeDetails.js";

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
  const {
    nodes,
    selectedNode: preferredNode,
    setSelectedNode,
    isLoading,
    isRefreshing,
    errorMessage,
    lastUpdated,
    now,
    fetchClusterData,
  } = useClusterData();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");

  useEffect(() => {
    if (isLoading) return;
    document
      .getElementById(
        focusSection === "fleet" ? "server-fleet" : "cluster-overview",
      )
      ?.scrollIntoView({ behavior: "smooth" });
  }, [focusSection, isLoading]);

  const filteredNodes = nodes.filter(
    (n) =>
      (n.name.toLowerCase().includes(searchQuery.trim().toLowerCase()) ||
        n.ip_address.toLowerCase().includes(searchQuery.trim().toLowerCase())) &&
      (statusFilter === "ALL" || n.status === statusFilter),
  );
  const selectedNode = filteredNodes.find((node) => node.id === preferredNode?.id)
    ?? filteredNodes[0] ?? null;
  const { metricsHistory, historyError, historyLoading } = useNodeHistory(
    selectedNode?.id,
  );
  const counts = getClusterCounts(nodes);
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
            Đăng ký máy chủ tại Gateway, sau đó cấu hình WireGuard và Mini-Agent
            theo hướng dẫn triển khai để bắt đầu nhận số liệu.
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
      <div className={`sync-strip ${errorMessage ? "warning" : ""}`}>
        <span className="sync-state">
          <i /> {errorMessage ? "Dữ liệu chưa đồng bộ" : "Đã đồng bộ với Gateway"}
        </span>
        <span>
          Lần tải thành công:{" "}
          <time
            dateTime={lastUpdated ?? undefined}
            title={formatDateTime(lastUpdated)}
          >
            {formatTime(lastUpdated)}
          </time>
        </span>
        <span className="sync-interval">Danh sách 5 giây · Biểu đồ 3 giây</span>
      </div>
      <ClusterSummary
        counts={counts}
        total={nodes.length}
        statusFilter={statusFilter}
        onFilterChange={setStatusFilter}
      />
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
          {statusFilter !== "ALL" && (
            <div className="fleet-filter-state">
              <span>
                Đang lọc: {counts.find((item) => item.status === statusFilter)?.label}
              </span>
              <button onClick={() => setStatusFilter("ALL")}>Xóa bộ lọc</button>
            </div>
          )}
          <div className="node-list">
            {filteredNodes.length === 0 ? (
              <div className="search-empty">
                <Search size={25} />
                <strong>Không tìm thấy máy chủ</strong>
                <span>Thử tên, địa chỉ IP hoặc trạng thái khác.</span>
                <button
                  onClick={() => {
                    setSearchQuery("");
                    setStatusFilter("ALL");
                  }}
                >
                  Xóa bộ lọc
                </button>
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
                  now={now}
                  sourceStale={!!errorMessage}
                />
              ))
            )}
          </div>
          <div className="fleet-help">
            <Info size={15} />
            <span>
              Chọn máy chủ để xem tài nguyên. <br />
              Bấm thẻ trạng thái phía trên để lọc danh sách.
            </span>
          </div>
        </section>
        {selectedNode && (
          <NodeDetails
            node={selectedNode}
            currentUser={currentUser}
            onOpenTerminal={onOpenTerminal}
            now={now}
            sourceStale={!!errorMessage}
            metricsHistory={metricsHistory}
            historyError={historyError}
            historyLoading={historyLoading}
          />
        )}
      </div>
      <div className="overview-note">
        <Info size={14} />
        <span>
          Online / Stale / Offline phản ánh heartbeat của máy chủ. Mức tải CPU
          được theo dõi riêng. CPU, RAM và uptime đo hệ điều hành chạy Agent;
          trong Docker có thể dùng host chung. Ổ đĩa đo filesystem/volume được
          cấu hình tại Agent.
        </span>
      </div>
    </div>
  );
};
