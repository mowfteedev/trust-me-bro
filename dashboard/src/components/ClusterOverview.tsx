import React, { useState, useEffect } from 'react';
import { NodeItem, MetricSnapshot, ClusterSummary, UserSession } from '../types/index.js';
import { NodeCard } from './NodeCard.js';
import { MetricsChart } from './MetricsChart.js';
import { api } from '../services/api.js';
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
} from 'lucide-react';

interface ClusterOverviewProps {
  currentUser?: UserSession | null;
  onOpenTerminal: (node: NodeItem) => void;
}

/**
 * ==============================================================================
 * MÀN HÌNH TỔNG QUAN CỤM MÁY CHỦ CLUSTER OVERVIEW (components/ClusterOverview.tsx)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: frontend (chủ trì), designer
 * ==============================================================================
 *
 * TIÊU CHUẨN FRONTEND SKILL BẮT BUỘC:
 * Phải bao bọc trọn vẹn đầy đủ 4 trạng thái dữ liệu (State Resilience):
 * 1. Loading State: Skeleton khung xương nhấp nháy, không để màn hình trắng xóa.
 * 2. Empty State: Chưa có máy chủ nào + hướng dẫn cài đặt Agent (Empty State CTA).
 * 3. Error State: Mất kết nối Gateway + Nút "Thử lại" (Retry).
 * 4. Success State: Lưới thẻ NodeCard + Biểu đồ MetricsChart phản hồi < 150ms.
 */

export const ClusterOverview: React.FC<ClusterOverviewProps> = ({ currentUser, onOpenTerminal }) => {
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [selectedNode, setSelectedNode] = useState<NodeItem | null>(null);
  const [metricsHistory, setMetricsHistory] = useState<MetricSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Tải danh sách Nodes từ Gateway
  const fetchClusterData = async (isManual = false) => {
    if (isManual) setIsRefreshing(true);

    try {
      const data = await api.getNodes();
      setNodes(data);
      setErrorMessage(null);

      setSelectedNode((prev) => data.find((n) => n.id === prev?.id) ?? data[0] ?? null);
    } catch (err: any) {
      setErrorMessage(err.message || 'Không thể kết nối tới Control Plane Gateway');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  // Tự động tải số liệu chuỗi thời gian khi chọn một Node
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
            setHistoryError(err.message || 'Không tải được lịch sử tài nguyên.');
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

  // Vòng lặp cập nhật danh sách mỗi 5 giây
  useEffect(() => {
    fetchClusterData();
    const timer = setInterval(() => {
      fetchClusterData();
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  // Tính toán tóm tắt số liệu cụm
  const nodesWithMetrics = nodes.filter((n) => n.latest_metric);
  const avgCpu = nodesWithMetrics.length > 0
    ? nodesWithMetrics.reduce((acc, n) => acc + (n.latest_metric?.cpu_percent || 0), 0) / nodesWithMetrics.length
    : 0;
  const avgMemory = nodesWithMetrics.length > 0
    ? nodesWithMetrics.reduce((acc, n) => {
        const m = n.latest_metric;
        const pct = (m && m.memory_total_bytes > 0) ? (m.memory_used_bytes / m.memory_total_bytes) * 100 : 0;
        return acc + pct;
      }, 0) / nodesWithMetrics.length
    : 0;

  const summary: ClusterSummary = {
    total: nodes.length,
    healthy: nodes.filter((n) => n.status === 'HEALTHY').length,
    warning: nodes.filter((n) => n.status === 'WARNING').length,
    offline: nodes.filter((n) => n.status === 'OFFLINE').length,
    avgCpu,
    avgMemory,
  };

  const filteredNodes = nodes.filter(
    (n) =>
      n.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      n.ip_address.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // --------------------------------------------------------------------------
  // 1. LOADING STATE: SKELETON KHUNG XƯƠNG
  // --------------------------------------------------------------------------
  if (isLoading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Đang tải dữ liệu cụm">
        {/* Skeleton Thống kê */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="animate-pulse rounded-2xl border border-slate-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/40 p-4">
              <div className="h-4 w-1/2 rounded bg-slate-200 dark:bg-neutral-800" />
              <div className="mt-3 h-8 w-1/3 rounded bg-slate-300 dark:bg-neutral-700" />
            </div>
          ))}
        </div>

        {/* Skeleton Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse rounded-2xl border border-slate-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/40 p-5 space-y-4">
              <div className="flex items-center space-x-3">
                <div className="h-10 w-10 rounded-xl bg-slate-200 dark:bg-neutral-800" />
                <div className="space-y-2 flex-1">
                  <div className="h-4 w-1/2 rounded bg-slate-200 dark:bg-neutral-800" />
                  <div className="h-3 w-1/3 rounded bg-slate-200 dark:bg-neutral-850" />
                </div>
              </div>
              <div className="space-y-2">
                <div className="h-2 w-full rounded bg-slate-200 dark:bg-neutral-800" />
                <div className="h-2 w-full rounded bg-slate-200 dark:bg-neutral-800" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // 2. ERROR STATE: THÔNG BÁO THÂN THIỆN + NÚT THỬ LẠI
  // --------------------------------------------------------------------------
  if (errorMessage && nodes.length === 0) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-red-200 dark:border-red-500/20 bg-red-50/60 dark:bg-red-950/20 p-8 text-center backdrop-blur-sm shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-red-100 dark:bg-red-500/10 text-red-600 dark:text-red-400">
          <AlertCircle className="h-7 w-7" />
        </div>
        <h3 className="mt-4 text-lg font-semibold text-slate-900 dark:text-neutral-100">Không thể kết nối với Gateway Engine</h3>
        <p className="mt-2 text-sm text-slate-600 dark:text-neutral-400 font-mono leading-relaxed">{errorMessage}</p>
        <div className="mt-6 flex justify-center space-x-3">
          <button
            onClick={() => fetchClusterData(true)}
            className="min-h-[44px] px-5 inline-flex items-center space-x-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-sm font-semibold text-white transition-colors shadow-sm"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            <span>Thử lại ngay</span>
          </button>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // 3. EMPTY STATE: TRỐNG DỮ LIỆU + HƯỚNG DẪN KẾT NỐI MÁY CON
  // --------------------------------------------------------------------------
  if (nodes.length === 0) {
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-slate-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/40 p-8 text-center shadow-sm">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-sky-50 dark:bg-cyan-500/10 text-sky-600 dark:text-cyan-400">
          <Server className="h-8 w-8" />
        </div>
        <h3 className="mt-4 text-xl font-bold text-slate-900 dark:text-neutral-100">Chưa có máy chủ nào được kết nối</h3>
        <p className="mt-2 text-sm text-slate-600 dark:text-neutral-400 leading-relaxed">
          Cụm máy chủ của bạn đang hoàn toàn trống. Hãy cài đặt Worker Daemon lên các máy ảo hoặc container để bắt đầu
          giám sát thời gian thực.
        </p>

        {/* Hướng dẫn cài đặt nhanh */}
        <div className="mt-6 rounded-xl border border-slate-200 dark:border-neutral-800 bg-slate-50 dark:bg-neutral-950 p-4 text-left">
          <p className="text-sm text-slate-600 dark:text-neutral-400">
            Làm theo README của dự án: cấu hình WireGuard, đăng ký node/token, sau đó khởi chạy Mini-Agent trên máy con.
            Dashboard tự hiển thị máy khi nhận được heartbeat hợp lệ.
          </p>
        </div>

        <button
          onClick={() => fetchClusterData(true)}
          className="mt-6 min-h-[44px] px-5 inline-flex items-center space-x-2 rounded-xl border border-slate-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-sm font-medium text-slate-700 dark:text-neutral-200 hover:bg-slate-50 dark:hover:bg-neutral-700 transition-colors shadow-xs"
        >
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          <span>Làm mới danh sách</span>
        </button>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // 4. SUCCESS STATE: HIỂN THỊ DỮ LIỆU ĐẦY ĐỦ + LƯỚI THẺ & BIỂU ĐỒ
  // --------------------------------------------------------------------------
  return (
    <div className="space-y-6">
      {errorMessage && (
        <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm text-amber-800 dark:text-amber-300">
          Không cập nhật được dữ liệu: {errorMessage} Số liệu bên dưới là lần tải thành công gần nhất.
          <button onClick={() => fetchClusterData(true)} disabled={isRefreshing} className="ml-2 underline">Thử lại</button>
        </div>
      )}
      <p className="text-xs text-slate-500 dark:text-slate-400">Trạng thái theo heartbeat của Gateway. Mặc định: Online dưới 15s, Stale từ 15s, Offline từ 30s; có độ trễ theo chu kỳ quét. Mức tải CPU hiển thị riêng.</p>

      {/* 4.2 Thanh tóm tắt trạng thái cụm (KPI Cards) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {/* Tổng số Node */}
        <div className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-4 shadow-xs">
          <div className="flex items-center justify-between text-slate-500 dark:text-neutral-400 text-xs font-mono">
            <span>TỔNG MÁY CHỦ</span>
            <Layers className="h-4 w-4 text-sky-600 dark:text-cyan-400" />
          </div>
          <p className="mt-2 font-mono text-2xl font-bold text-slate-900 dark:text-neutral-100">{summary.total}</p>
        </div>

        {/* Healthy */}
        <div className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-4 shadow-xs">
          <div className="flex items-center justify-between text-slate-500 dark:text-neutral-400 text-xs font-mono">
            <span>ONLINE</span>
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <p className="mt-2 font-mono text-2xl font-bold text-emerald-600 dark:text-emerald-400">{summary.healthy}</p>
        </div>

        {/* Warning */}
        <div className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-4 shadow-xs">
          <div className="flex items-center justify-between text-slate-500 dark:text-neutral-400 text-xs font-mono">
            <span>STALE</span>
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          </div>
          <p className="mt-2 font-mono text-2xl font-bold text-amber-600 dark:text-amber-400">{summary.warning}</p>
        </div>

        {/* Offline */}
        <div className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-4 shadow-xs">
          <div className="flex items-center justify-between text-slate-500 dark:text-neutral-400 text-xs font-mono">
            <span>OFFLINE</span>
            <XCircle className="h-4 w-4 text-rose-600 dark:text-red-400" />
          </div>
          <p className="mt-2 font-mono text-2xl font-bold text-rose-600 dark:text-red-400">{summary.offline}</p>
        </div>
      </div>

      {/* 4.3 Thanh công cụ tìm kiếm và lọc kiểu DirectAdmin */}
      <div id="server-fleet" className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2 scroll-mt-20">
        <div className="flex items-center space-x-2 w-full sm:w-auto">
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center">
            <Server className="h-4 w-4 mr-2 text-sky-600" />
            Danh Sách Máy Chủ (Server Fleet)
          </h2>
          <span className="px-2 py-0.5 text-xs font-mono rounded-full bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
            {filteredNodes.length} Nodes
          </span>
        </div>

        <div className="flex items-center space-x-2 w-full sm:w-auto justify-end">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="text"
              placeholder="Tìm theo tên máy hoặc IP WireGuard..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-full border border-slate-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/80 pl-10 pr-4 py-2 text-xs text-slate-800 dark:text-neutral-200 placeholder-slate-400 focus:border-sky-500 focus:outline-none transition-colors shadow-xs"
            />
          </div>

          <button
            onClick={() => fetchClusterData(true)}
            className="min-h-[44px] px-3.5 inline-flex items-center space-x-2 rounded-full border border-slate-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-xs font-semibold text-slate-700 dark:text-neutral-300 hover:border-sky-500 hover:text-sky-600 transition-colors shadow-xs shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin text-sky-600' : ''}`} />
            <span className="hidden sm:inline">Làm mới</span>
          </button>
        </div>
      </div>

      {filteredNodes.length === 0 && <p className="text-sm text-slate-500">Không tìm thấy máy chủ phù hợp.</p>}
      {/* 4.4 Lưới thẻ máy chủ con */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {filteredNodes.map((node) => {
          const metric = node.latest_metric || (selectedNode?.id === node.id ? metricsHistory[0] : undefined);
          return (
            <NodeCard
              key={node.id}
              node={node}
              latestMetric={metric}
              currentUser={currentUser}
              isSelected={selectedNode?.id === node.id}
              onSelectNode={(n) => setSelectedNode(n)}
              onOpenTerminal={onOpenTerminal}
            />
          );
        })}
      </div>

      {/* 4.5 Biểu đồ tài nguyên thời gian thực của máy chủ đang được chọn */}
      {selectedNode && (
        <div className="mt-8 space-y-3 rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-5 shadow-xs">
          <div className="flex flex-wrap gap-2 items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
            <h3 className="min-w-0 flex flex-wrap gap-1 text-sm font-semibold text-slate-800 dark:text-neutral-300 items-center">
              <Activity className="h-4 w-4 mr-2 text-sky-600 dark:text-cyan-400" />
              Chuỗi thời gian tài nguyên máy chủ: <span className="break-all text-sky-600 dark:text-cyan-400 ml-1.5 font-mono">{selectedNode.name}</span>
            </h3>
            {currentUser?.role === 'ADMIN' && (
              <button
                onClick={() => onOpenTerminal(selectedNode)}
                disabled={selectedNode.status === 'OFFLINE'}
                className="text-xs font-mono text-sky-600 dark:text-cyan-400 hover:underline flex items-center font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Terminal className="h-3.5 w-3.5 mr-1" /> Mở Web SSH
              </button>
            )}
          </div>
          {historyError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">Không tải được biểu đồ: {historyError} Hệ thống sẽ tự thử lại.</p>}
          {historyLoading ? <p aria-busy="true" className="py-12 text-center text-sm text-slate-500">Đang tải lịch sử tài nguyên...</p> : (!historyError || metricsHistory.length > 0) && <MetricsChart metrics={metricsHistory} />}
        </div>
      )}
    </div>
  );
};
