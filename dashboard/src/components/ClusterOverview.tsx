import React, { useState, useEffect } from 'react';
import { NodeItem, MetricSnapshot, ClusterSummary } from '../types/index.js';
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

export const ClusterOverview: React.FC<ClusterOverviewProps> = ({ onOpenTerminal }) => {
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

      // Nếu chưa chọn node nào hoặc node đã chọn không còn tồn tại, tự động chọn node đầu tiên
      if (data.length > 0 && (!selectedNode || !data.some((n) => n.id === selectedNode.id))) {
        setSelectedNode(data[0]);
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
    api
      .getNodeHistory(selectedNode.id)
      .then((data) => {
        if (isCurrent) setMetricsHistory(data);
      })
      .catch(() => {
        if (isCurrent) setMetricsHistory([]);
      });

    return () => {
      isCurrent = false;
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
  const summary: ClusterSummary = {
    total: nodes.length,
    healthy: nodes.filter((n) => n.status === 'HEALTHY').length,
    warning: nodes.filter((n) => n.status === 'WARNING').length,
    offline: nodes.filter((n) => n.status === 'OFFLINE').length,
    avgCpu: 0,
    avgMemory: 0,
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
            <div key={i} className="animate-pulse rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
              <div className="h-4 w-1/2 rounded bg-neutral-800" />
              <div className="mt-3 h-8 w-1/3 rounded bg-neutral-700" />
            </div>
          ))}
        </div>

        {/* Skeleton Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5 space-y-4">
              <div className="flex items-center space-x-3">
                <div className="h-10 w-10 rounded-xl bg-neutral-800" />
                <div className="space-y-2 flex-1">
                  <div className="h-4 w-1/2 rounded bg-neutral-800" />
                  <div className="h-3 w-1/3 rounded bg-neutral-850" />
                </div>
              </div>
              <div className="space-y-2">
                <div className="h-2 w-full rounded bg-neutral-800" />
                <div className="h-2 w-full rounded bg-neutral-800" />
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
      <div className="mx-auto max-w-lg rounded-2xl border border-red-500/20 bg-red-950/20 p-8 text-center backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10 text-red-400">
          <AlertCircle className="h-7 w-7" />
        </div>
        <h3 className="mt-4 text-lg font-semibold text-neutral-100">Không thể kết nối với Gateway Engine</h3>
        <p className="mt-2 text-sm text-neutral-400 font-mono leading-relaxed">{errorMessage}</p>
        <div className="mt-6 flex justify-center space-x-3">
          <button
            onClick={() => fetchClusterData(true)}
            className="min-h-[44px] px-5 inline-flex items-center space-x-2 rounded-xl bg-cyan-500 text-sm font-medium text-neutral-950 hover:bg-cyan-400 transition-colors"
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
      <div className="mx-auto max-w-xl rounded-2xl border border-neutral-800 bg-neutral-900/40 p-8 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-cyan-500/10 text-cyan-400">
          <Server className="h-8 w-8" />
        </div>
        <h3 className="mt-4 text-xl font-bold text-neutral-100">Chưa có máy chủ nào được kết nối</h3>
        <p className="mt-2 text-sm text-neutral-400 leading-relaxed">
          Cụm máy chủ của bạn đang hoàn toàn trống. Hãy cài đặt Worker Daemon lên các máy ảo hoặc container để bắt đầu
          giám sát thời gian thực.
        </p>

        {/* Hướng dẫn cài đặt nhanh */}
        <div className="mt-6 rounded-xl border border-neutral-800 bg-neutral-950 p-4 text-left">
          <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400 mb-2">Lệnh cài đặt máy con:</p>
          <code className="block font-mono text-xs text-cyan-400 bg-neutral-900/80 p-2.5 rounded-lg overflow-x-auto select-all">
            curl -sSL https://gateway/install.sh | sudo bash -s -- --token &lt;YOUR_NODE_TOKEN&gt;
          </code>
        </div>

        <button
          onClick={() => fetchClusterData(true)}
          className="mt-6 min-h-[44px] px-5 inline-flex items-center space-x-2 rounded-xl border border-neutral-700 bg-neutral-800 text-sm font-medium text-neutral-200 hover:bg-neutral-700 transition-colors"
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
      {/* 4.1 Thanh tóm tắt trạng thái cụm (KPI Cards) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {/* Tổng số Node */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="flex items-center justify-between text-neutral-400 text-xs font-mono">
            <span>TỔNG MÁY CHỦ</span>
            <Layers className="h-4 w-4 text-cyan-400" />
          </div>
          <p className="mt-2 font-mono text-2xl font-bold text-neutral-100">{summary.total}</p>
        </div>

        {/* Healthy */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="flex items-center justify-between text-neutral-400 text-xs font-mono">
            <span>HOẠT ĐỘNG (HEALTHY)</span>
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          </div>
          <p className="mt-2 font-mono text-2xl font-bold text-emerald-400">{summary.healthy}</p>
        </div>

        {/* Warning */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="flex items-center justify-between text-neutral-400 text-xs font-mono">
            <span>CẢNH BÁO (WARNING)</span>
            <AlertTriangle className="h-4 w-4 text-amber-400" />
          </div>
          <p className="mt-2 font-mono text-2xl font-bold text-amber-400">{summary.warning}</p>
        </div>

        {/* Offline */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4">
          <div className="flex items-center justify-between text-neutral-400 text-xs font-mono">
            <span>MẤT KẾT NỐI (OFFLINE)</span>
            <XCircle className="h-4 w-4 text-red-400" />
          </div>
          <p className="mt-2 font-mono text-2xl font-bold text-red-400">{summary.offline}</p>
        </div>
      </div>

      {/* 4.2 Thanh công cụ tìm kiếm và lọc */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
          <input
            type="text"
            placeholder="Tìm theo tên máy hoặc IP WireGuard..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-neutral-800 bg-neutral-900/80 pl-10 pr-4 py-2 text-sm text-neutral-200 placeholder-neutral-500 focus:border-cyan-500 focus:outline-none transition-colors"
          />
        </div>

        <div className="flex items-center space-x-2 w-full sm:w-auto justify-end">
          <button
            onClick={() => fetchClusterData(true)}
            className="min-h-[44px] px-3.5 inline-flex items-center space-x-2 rounded-xl border border-neutral-800 bg-neutral-900 text-xs font-medium text-neutral-300 hover:border-neutral-700 hover:text-neutral-100 transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin text-cyan-400' : ''}`} />
            <span>Làm mới</span>
          </button>
        </div>
      </div>

      {/* 4.3 Lưới thẻ máy chủ con */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {filteredNodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            latestMetric={selectedNode?.id === node.id ? metricsHistory[0] : undefined}
            isSelected={selectedNode?.id === node.id}
            onSelectNode={(n) => setSelectedNode(n)}
            onOpenTerminal={onOpenTerminal}
          />
        ))}
      </div>

      {/* 4.4 Biểu đồ tài nguyên thời gian thực của máy chủ đang được chọn */}
      {selectedNode && (
        <div className="mt-8 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-neutral-300 flex items-center">
              <Activity className="h-4 w-4 mr-2 text-cyan-400" />
              Chuỗi thời gian tài nguyên máy chủ: <span className="text-cyan-400 ml-1.5 font-mono">{selectedNode.name}</span>
            </h3>
            <button
              onClick={() => onOpenTerminal(selectedNode)}
              className="text-xs font-mono text-cyan-400 hover:underline flex items-center"
            >
              <Terminal className="h-3.5 w-3.5 mr-1" /> Mở Web SSH
            </button>
          </div>
          <MetricsChart metrics={metricsHistory} />
        </div>
      )}
    </div>
  );
};
