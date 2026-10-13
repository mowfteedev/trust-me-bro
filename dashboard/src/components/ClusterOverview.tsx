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
  const [searchQuery, setSearchQuery] = useState('');

  // Tải danh sách Nodes từ Gateway
  const fetchClusterData = async (isManual = false) => {
    if (isManual) setIsRefreshing(true);
    setErrorMessage(null);

    try {
      const data = await api.getNodes();
      setNodes(data);

      // Cập nhật selectedNode an toàn chống Stale Closure (Functional State Updater)
      if (data.length > 0) {
        setSelectedNode((prev) => (prev && data.some((n) => n.id === prev.id) ? prev : data[0]));
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Không thể kết nối tới Control Plane Gateway');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  // Tự động tải số liệu chuỗi thời gian khi chọn một Node
  useEffect(() => {
    if (!selectedNode) return;

    let isCurrent = true;
    const fetchHistory = () => {
      api
        .getNodeHistory(selectedNode.id)
        .then((data) => {
          if (isCurrent) setMetricsHistory(data);
        })
        .catch(() => {
          if (isCurrent) setMetricsHistory([]);
        });
    };

    fetchHistory();
    const historyTimer = setInterval(fetchHistory, 3000);

    return () => {
      isCurrent = false;
      clearInterval(historyTimer);
    };
  }, [selectedNode]);

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
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-neutral-400 mb-2">Lệnh cài đặt máy con:</p>
          <code className="block font-mono text-xs text-sky-600 dark:text-cyan-400 bg-white dark:bg-neutral-900/80 p-2.5 rounded-lg border border-slate-200 dark:border-neutral-800 overflow-x-auto select-all">
            curl -sSL https://gateway/install.sh | sudo bash -s -- --token &lt;YOUR_NODE_TOKEN&gt;
          </code>
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
      {/* 4.1 Khối DirectAdmin: Monitoring Tools & What's New Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Cột trái: Monitoring Tools */}
        <div className="lg:col-span-5 rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-5 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center">
                <Activity className="h-4 w-4 mr-2 text-sky-600" />
                Monitoring Tools
              </h3>
              <button
                onClick={() => fetchClusterData(true)}
                className="text-slate-400 hover:text-sky-600 transition-colors p-1"
                title="Làm mới sự kiện"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="mt-3 space-y-2.5 text-xs font-mono">
              <div className="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/40">
                <div className="flex items-center space-x-2 truncate">
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400">
                    PROBE
                  </span>
                  <span className="text-slate-700 dark:text-slate-200 truncate">fast_probe_port22 (300ms)</span>
                </div>
                <span className="text-slate-400 text-[11px] shrink-0 ml-2">Active</span>
              </div>

              <div className="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/40">
                <div className="flex items-center space-x-2 truncate">
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-400">
                    TUNNEL
                  </span>
                  <span className="text-slate-700 dark:text-slate-200 truncate">wireguard_overlay (UDP 51820)</span>
                </div>
                <span className="text-slate-400 text-[11px] shrink-0 ml-2">Encrypted</span>
              </div>

              <div className="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-800/40">
                <div className="flex items-center space-x-2 truncate">
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-400">
                    SHELL
                  </span>
                  <span className="text-slate-700 dark:text-slate-200 truncate">pty_spawn_streaming</span>
                </div>
                <span className="text-slate-400 text-[11px] shrink-0 ml-2">0ms Delay</span>
              </div>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 text-center">
            <span className="text-xs font-semibold text-sky-600 dark:text-sky-400 hover:underline cursor-pointer inline-flex items-center">
              + Zero-Trust Inbound Policy Active
            </span>
          </div>
        </div>

        {/* Cột phải: What's New in ZT-ServerOps (4 Cards màu pastel chuẩn DirectAdmin) */}
        <div className="lg:col-span-7 rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-5 shadow-xs">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800 mb-3">
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">Zero-Trust Architecture Highlights</h3>
            <span className="text-xs text-slate-400 font-mono">Do-an-co-so-nganh</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Card 1: Real-time Streaming */}
            <div className="p-3.5 rounded-xl border border-sky-200/80 bg-gradient-to-br from-sky-50 to-sky-100/60 dark:from-sky-950/30 dark:to-sky-900/20 dark:border-sky-800/50">
              <span className="text-xs font-bold text-sky-800 dark:text-sky-300 block">Real-Time PTY</span>
              <p className="mt-1 text-[11px] text-sky-700/80 dark:text-sky-400/80 leading-snug">
                Stream ký tự qua spawn() tức thì, hỗ trợ ngắt Ctrl+C linh hoạt.
              </p>
            </div>

            {/* Card 2: Fast Probe */}
            <div className="p-3.5 rounded-xl border border-emerald-200/80 bg-gradient-to-br from-emerald-50 to-emerald-100/60 dark:from-emerald-950/30 dark:to-emerald-900/20 dark:border-emerald-800/50">
              <span className="text-xs font-bold text-emerald-800 dark:text-emerald-300 block">Fast Probe 300ms</span>
              <p className="mt-1 text-[11px] text-emerald-700/80 dark:text-emerald-400/80 leading-snug">
                Thăm dò cổng 22 chỉ 0.3s, triệt tiêu 10 giây chờ timeout.
              </p>
            </div>

            {/* Card 3: Zero Inbound */}
            <div className="p-3.5 rounded-xl border border-amber-200/80 bg-gradient-to-br from-amber-50 to-amber-100/60 dark:from-amber-950/30 dark:to-amber-900/20 dark:border-amber-800/50">
              <span className="text-xs font-bold text-amber-800 dark:text-amber-300 block">Zero Inbound Ports</span>
              <p className="mt-1 text-[11px] text-amber-700/80 dark:text-amber-400/80 leading-snug">
                Máy con không mở bất kỳ cổng nào ra Internet, an toàn tuyệt đối.
              </p>
            </div>

            {/* Card 4: Ed25519 Bastion */}
            <div className="p-3.5 rounded-xl border border-purple-200/80 bg-gradient-to-br from-purple-50 to-purple-100/60 dark:from-purple-950/30 dark:to-purple-900/20 dark:border-purple-800/50">
              <span className="text-xs font-bold text-purple-800 dark:text-purple-300 block">Ed25519 Bastion</span>
              <p className="mt-1 text-[11px] text-purple-700/80 dark:text-purple-400/80 leading-snug">
                Cầu nối WebSocket-to-SSH mã hóa khóa Ed25519 theo chuẩn RFC 8709.
              </p>
            </div>
          </div>
        </div>
      </div>

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
            <span>HOẠT ĐỘNG (HEALTHY)</span>
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <p className="mt-2 font-mono text-2xl font-bold text-emerald-600 dark:text-emerald-400">{summary.healthy}</p>
        </div>

        {/* Warning */}
        <div className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-4 shadow-xs">
          <div className="flex items-center justify-between text-slate-500 dark:text-neutral-400 text-xs font-mono">
            <span>CẢNH BÁO (WARNING)</span>
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          </div>
          <p className="mt-2 font-mono text-2xl font-bold text-amber-600 dark:text-amber-400">{summary.warning}</p>
        </div>

        {/* Offline */}
        <div className="rounded-2xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-4 shadow-xs">
          <div className="flex items-center justify-between text-slate-500 dark:text-neutral-400 text-xs font-mono">
            <span>MẤT KẾT NỐI (OFFLINE)</span>
            <XCircle className="h-4 w-4 text-rose-600 dark:text-red-400" />
          </div>
          <p className="mt-2 font-mono text-2xl font-bold text-rose-600 dark:text-red-400">{summary.offline}</p>
        </div>
      </div>

      {/* 4.3 Thanh công cụ tìm kiếm và lọc kiểu DirectAdmin */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
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
          <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-neutral-300 flex items-center">
              <Activity className="h-4 w-4 mr-2 text-sky-600 dark:text-cyan-400" />
              Chuỗi thời gian tài nguyên máy chủ: <span className="text-sky-600 dark:text-cyan-400 ml-1.5 font-mono">{selectedNode.name}</span>
            </h3>
            {currentUser?.role === 'ADMIN' && (
              <button
                onClick={() => onOpenTerminal(selectedNode)}
                className="text-xs font-mono text-sky-600 dark:text-cyan-400 hover:underline flex items-center font-medium"
              >
                <Terminal className="h-3.5 w-3.5 mr-1" /> Mở Web SSH
              </button>
            )}
          </div>
          <MetricsChart metrics={metricsHistory} />
        </div>
      )}
    </div>
  );
};
