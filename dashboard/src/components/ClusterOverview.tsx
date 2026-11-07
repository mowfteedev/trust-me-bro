import React, { useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, RefreshCw, Search } from "lucide-react";
import { NodeItem, UserSession } from "../types/index.js";
import { useClusterData } from "../hooks/useClusterData.js";
import { useNodeHistory } from "../hooks/useNodeHistory.js";
import { formatDateTime, formatTime } from "../utils/format.js";
import { FleetSort, filterAndSortNodes } from "../utils/fleet.js";
import { ClusterSummary, getClusterCounts } from "./ClusterSummary.js";
import { ServerTable } from "./ServerTable.js";
import { NodeDetails } from "./NodeDetails.js";
import { WorkspaceOverview } from "./WorkspaceOverview.js";

interface ClusterOverviewProps {
  currentUser?: UserSession | null;
  onOpenTerminal: (node: NodeItem) => void;
  focusSection?: "dashboard" | "fleet";
  onNavigateFleet: () => void;
}

export const ClusterOverview: React.FC<ClusterOverviewProps> = ({ currentUser, onOpenTerminal, focusSection = "dashboard", onNavigateFleet }) => {
  const { nodes, selectedNode: preferredNode, setSelectedNode, isLoading, isRefreshing, errorMessage, lastUpdated, now, fetchClusterData } = useClusterData();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [sort, setSort] = useState<FleetSort>("name");
  const [detailsRequested, setDetailsRequested] = useState(false);
  const isFleet = focusSection === "fleet";
  const filteredNodes = filterAndSortNodes(nodes, searchQuery, statusFilter, sort);
  const selectableNodes = isFleet ? filteredNodes : nodes;
  const selectedNode = selectableNodes.find(node => node.id === preferredNode?.id) ?? selectableNodes[0] ?? null;
  const { metricsHistory, historyError, historyLoading } = useNodeHistory(selectedNode?.id);
  const counts = getClusterCounts(nodes);

  useEffect(() => {
    document.getElementById("cluster-overview")?.scrollIntoView({ block: "start" });
  }, [isFleet]);

  useEffect(() => {
    if (!isFleet || !detailsRequested || isLoading || !selectedNode) return;
    const detail = document.getElementById("worker-details");
    detail?.focus({ preventScroll: true });
    detail?.scrollIntoView({ block: "start" });
    setDetailsRequested(false);
  }, [isFleet, detailsRequested, isLoading, selectedNode?.id]);

  const openNode = (node: NodeItem) => {
    setSelectedNode(node);
    setDetailsRequested(true);
    if (!isFleet) {
      setSearchQuery(""); setStatusFilter("ALL");
      onNavigateFleet();
    }
  };
  const resetFilters = () => { setSearchQuery(""); setStatusFilter("ALL"); };
  const pageHeading = (
    <div className="page-heading">
      <h1>{isFleet ? "Máy chủ" : "Tổng quan"}</h1>
      <button className="button secondary" aria-label="Làm mới" title="Làm mới dữ liệu" onClick={() => fetchClusterData(true)} disabled={isRefreshing || isLoading}>
        <RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} /><span>Làm mới</span>
      </button>
    </div>
  );

  if (isLoading) return <div className="overview workspace-page" aria-busy="true" aria-label="Đang tải dữ liệu cụm">{pageHeading}<div className="summary-grid">{[1,2,3,4].map(i => <div className="skeleton summary-skeleton" key={i} />)}</div><div className="skeleton workspace-loading" /></div>;
  if (errorMessage && nodes.length === 0) return <div className="overview workspace-page">{pageHeading}<section className="state-panel" role="alert"><span className="state-icon danger"><AlertCircle size={30} /></span><h2>Không thể kết nối với Gateway</h2><p>{errorMessage}</p><button className="button primary" onClick={() => fetchClusterData(true)} disabled={isRefreshing}><RefreshCw size={16} />Thử lại ngay</button></section></div>;

  return <div className="overview workspace-page">
    {pageHeading}
    {errorMessage && <div role="alert" className="notice warning"><AlertTriangle size={18} /><span>{errorMessage} Đang hiển thị dữ liệu cũ.</span><button onClick={() => fetchClusterData(true)} disabled={isRefreshing}>Thử lại</button></div>}
    <div className={`sync-strip ${errorMessage ? "warning" : ""}`}>
      <span className="sync-state"><i />{errorMessage ? "Dữ liệu cũ ·" : "Cập nhật"} <time dateTime={lastUpdated ?? undefined} title={formatDateTime(lastUpdated)}>{formatTime(lastUpdated)}</time></span>
    </div>
    <ClusterSummary counts={counts} statusFilter={isFleet ? statusFilter : ""} onFilterChange={status => {setStatusFilter(status); setSearchQuery(""); onNavigateFleet();}} />
    {!nodes.length ? <section className="state-panel"><h2>Chưa có máy chủ</h2><p>Đăng ký máy chủ tại Gateway để bắt đầu.</p></section> : isFleet ? <>
      <section id="server-fleet" className="panel workspace-fleet" aria-labelledby="fleet-title">
        <div className="workspace-panel-heading"><h2 id="fleet-title">Danh sách máy chủ <span className="count-badge">{filteredNodes.length} / {nodes.length}</span></h2></div>
        <div className="workspace-fleet-toolbar">
          <label className="fleet-search"><Search size={17} /><input aria-label="Tìm máy chủ" placeholder="Tìm theo tên hoặc IP…" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} /></label>
          <label className="workspace-select"><span>Trạng thái</span><select aria-label="Lọc trạng thái" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="ALL">Tất cả trạng thái</option><option value="HEALTHY">Online</option><option value="WARNING">Stale · Trễ heartbeat</option><option value="OFFLINE">Offline</option></select></label>
          <label className="workspace-select"><span>Sắp xếp</span><select aria-label="Sắp xếp máy chủ" value={sort} onChange={event => setSort(event.target.value as FleetSort)}><option value="name">Tên máy A–Z</option><option value="status">Cần chú ý trước</option><option value="cpu">CPU cao trước</option><option value="ram">RAM cao trước</option></select></label>
        </div>
        {filteredNodes.length ? <ServerTable nodes={filteredNodes} selectedNodeId={selectedNode?.id ?? null} currentUser={currentUser} now={now} sourceStale={!!errorMessage} onSelectNode={openNode} onOpenTerminal={onOpenTerminal} /> : <div className="search-empty"><Search size={25} /><strong>Không tìm thấy máy chủ</strong><span>Thử tên, địa chỉ IP hoặc trạng thái khác.</span><button onClick={resetFilters}>Xóa bộ lọc</button></div>}
      </section>
      {selectedNode && <NodeDetails node={selectedNode} currentUser={currentUser} onOpenTerminal={onOpenTerminal} now={now} sourceStale={!!errorMessage} metricsHistory={metricsHistory} historyError={historyError} historyLoading={historyLoading} />}
    </> : <WorkspaceOverview nodes={nodes} selectedNode={selectedNode} metricsHistory={metricsHistory} historyLoading={historyLoading} historyError={historyError} now={now} sourceStale={!!errorMessage} onOpenNode={openNode} onViewFleet={() => {resetFilters(); onNavigateFleet();}} />}
  </div>;
};
