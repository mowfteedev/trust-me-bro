import React from 'react';
import { NodeItem, MetricSnapshot, UserSession } from '../types/index.js';
import { Server, Terminal, Activity, HardDrive, Cpu, Radio } from 'lucide-react';

interface NodeCardProps {
  node: NodeItem;
  latestMetric?: MetricSnapshot;
  currentUser?: UserSession | null;
  onOpenTerminal: (node: NodeItem) => void;
  onSelectNode: (node: NodeItem) => void;
  isSelected?: boolean;
}

/**
 * ==============================================================================
 * THẺ HIỂN THỊ TRẠNG THÁI MÁY CHỦ CON (components/NodeCard.tsx)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: frontend (chủ trì), designer
 * ==============================================================================
 */

export const NodeCard: React.FC<NodeCardProps> = ({
  node,
  latestMetric,
  currentUser,
  onOpenTerminal,
  onSelectNode,
  isSelected = false,
}) => {
  const isHealthy = node.status === 'HEALTHY';
  const isWarning = node.status === 'WARNING';
  const isOffline = node.status === 'OFFLINE';

  const cpuPercent = latestMetric ? latestMetric.cpu_percent.toFixed(1) : '--';
  const memPercent = latestMetric && latestMetric.memory_total_bytes > 0
    ? ((latestMetric.memory_used_bytes / latestMetric.memory_total_bytes) * 100).toFixed(1)
    : '--';
  const diskPercent = latestMetric && latestMetric.disk_total_bytes > 0
    ? ((latestMetric.disk_used_bytes / latestMetric.disk_total_bytes) * 100).toFixed(1)
    : '--';

  return (
    <div
      onClick={() => onSelectNode(node)}
      className={`group relative flex flex-col justify-between rounded-2xl border p-5 transition-all duration-200 cursor-pointer shadow-xs ${
        isSelected
          ? 'border-sky-500 bg-sky-50/40 dark:bg-slate-900/90 dark:border-sky-500 ring-2 ring-sky-500/20 shadow-md'
          : 'border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/70 hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-md'
      }`}
    >
      {/* 1. Phần tiêu đề và định danh Node */}
      <div>
        <div className="flex items-start justify-between">
          <div className="flex items-center space-x-3">
            <div className={`rounded-xl p-2.5 transition-colors ${
              isHealthy ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400' :
              isWarning ? 'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400' :
              'bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400'
            }`}>
              <Server className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-slate-900 dark:text-slate-100 group-hover:text-sky-600 dark:group-hover:text-sky-400 transition-colors">
                {node.name}
              </h3>
              <p className="font-mono text-xs text-slate-500 dark:text-slate-400 flex items-center mt-0.5">
                <Radio className="h-3 w-3 mr-1 text-slate-400 dark:text-slate-500" />
                {node.ip_address}
              </p>
            </div>
          </div>

          {/* Huy hiệu trạng thái Liveness */}
          <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium font-mono border ${
            isHealthy
              ? 'border-emerald-200 dark:border-emerald-800/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400'
              : isWarning
              ? 'border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400'
              : 'border-rose-200 dark:border-rose-800/60 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400'
          }`}>
            <span className={`mr-1.5 h-1.5 w-1.5 rounded-full ${
              isHealthy ? 'bg-emerald-500 animate-pulse' :
              isWarning ? 'bg-amber-500' : 'bg-rose-500'
            }`} />
            {node.status}
          </span>
        </div>

        {/* 2. Chỉ số phần cứng thu nhỏ (Mini Resource Bars - Phong cách DirectAdmin mỏng & thanh lịch) */}
        <div className="mt-5 space-y-3">
          {/* CPU */}
          <div>
            <div className="flex justify-between text-xs font-mono text-slate-500 dark:text-slate-400 mb-1">
              <span className="flex items-center font-medium">
                <Cpu className="h-3.5 w-3.5 mr-1 text-slate-400 dark:text-slate-500" /> CPU
              </span>
              <span className="text-slate-700 dark:text-slate-200 font-semibold">{cpuPercent}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  Number(cpuPercent) > 85 ? 'bg-rose-500' :
                  Number(cpuPercent) > 60 ? 'bg-amber-500' : 'bg-sky-500'
                }`}
                style={{ width: `${Math.min(100, Math.max(0, Number(cpuPercent) || 0))}%` }}
              />
            </div>
          </div>

          {/* RAM */}
          <div>
            <div className="flex justify-between text-xs font-mono text-slate-500 dark:text-slate-400 mb-1">
              <span className="flex items-center font-medium">
                <Activity className="h-3.5 w-3.5 mr-1 text-slate-400 dark:text-slate-500" /> RAM
              </span>
              <span className="text-slate-700 dark:text-slate-200 font-semibold">{memPercent}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  Number(memPercent) > 85 ? 'bg-rose-500' :
                  Number(memPercent) > 70 ? 'bg-amber-500' : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(100, Math.max(0, Number(memPercent) || 0))}%` }}
              />
            </div>
          </div>

          {/* Disk */}
          <div>
            <div className="flex justify-between text-xs font-mono text-slate-500 dark:text-slate-400 mb-1">
              <span className="flex items-center font-medium">
                <HardDrive className="h-3.5 w-3.5 mr-1 text-slate-400 dark:text-slate-500" /> Disk
              </span>
              <span className="text-slate-700 dark:text-slate-200 font-semibold">{diskPercent}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-indigo-500 dark:bg-indigo-400 transition-all duration-500"
                style={{ width: `${Math.min(100, Math.max(0, Number(diskPercent) || 0))}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 3. Nút mở Web SSH Terminal (Chuẩn Touch Target >= 44x44px) */}
      <div className="mt-5 pt-4 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between">
        <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500">
          Loại: {node.node_type}
        </span>

        {currentUser?.role === 'ADMIN' ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpenTerminal(node);
            }}
            disabled={isOffline}
            className="min-h-[44px] px-4 inline-flex items-center justify-center space-x-1.5 rounded-xl border border-sky-200 dark:border-sky-800/60 bg-sky-50 dark:bg-sky-950/40 text-xs font-semibold text-sky-700 dark:text-sky-300 hover:bg-sky-600 hover:text-white dark:hover:bg-sky-500 dark:hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-xs"
            title={isOffline ? 'Máy chủ đang Offline' : 'Mở phiên dòng lệnh an toàn Web SSH'}
          >
            <Terminal className="h-4 w-4" />
            <span>Web SSH</span>
          </button>
        ) : (
          <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500 py-2">
            Chỉ đọc (Viewer)
          </span>
        )}
      </div>
    </div>
  );
};
