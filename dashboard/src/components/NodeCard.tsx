import React from 'react';
import { NodeItem, MetricSnapshot } from '../types/index.js';
import { Server, Terminal, Activity, HardDrive, Cpu, Radio } from 'lucide-react';

interface NodeCardProps {
  node: NodeItem;
  latestMetric?: MetricSnapshot;
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
      className={`group relative flex flex-col justify-between rounded-2xl border p-5 transition-all duration-200 cursor-pointer ${
        isSelected
          ? 'border-cyan-500 bg-neutral-900 shadow-lg shadow-cyan-500/10'
          : 'border-neutral-800 bg-neutral-900/60 hover:border-neutral-700 hover:bg-neutral-900'
      }`}
    >
      {/* 1. Phần tiêu đề và định danh Node */}
      <div>
        <div className="flex items-start justify-between">
          <div className="flex items-center space-x-3">
            <div className={`rounded-xl p-2.5 ${
              isHealthy ? 'bg-emerald-500/10 text-emerald-400' :
              isWarning ? 'bg-amber-500/10 text-amber-400' :
              'bg-red-500/10 text-red-400'
            }`}>
              <Server className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-neutral-100 group-hover:text-cyan-400 transition-colors">
                {node.name}
              </h3>
              <p className="font-mono text-xs text-neutral-400 flex items-center mt-0.5">
                <Radio className="h-3 w-3 mr-1 text-neutral-500" />
                {node.ip_address}
              </p>
            </div>
          </div>

          {/* Huy hiệu trạng thái Liveness */}
          <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium font-mono border ${
            isHealthy
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
              : isWarning
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
              : 'border-red-500/30 bg-red-500/10 text-red-400'
          }`}>
            <span className={`mr-1.5 h-1.5 w-1.5 rounded-full ${
              isHealthy ? 'bg-emerald-400 animate-pulse' :
              isWarning ? 'bg-amber-400' : 'bg-red-400'
            }`} />
            {node.status}
          </span>
        </div>

        {/* 2. Chỉ số phần cứng thu nhỏ (Mini Progress Bars) */}
        <div className="mt-5 space-y-3">
          {/* CPU */}
          <div>
            <div className="flex justify-between text-xs font-mono text-neutral-400 mb-1">
              <span className="flex items-center">
                <Cpu className="h-3.5 w-3.5 mr-1 text-neutral-500" /> CPU
              </span>
              <span className="text-neutral-200 font-semibold">{cpuPercent}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-neutral-800 overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  Number(cpuPercent) > 85 ? 'bg-red-500' :
                  Number(cpuPercent) > 60 ? 'bg-amber-500' : 'bg-cyan-500'
                }`}
                style={{ width: `${Math.min(100, Math.max(0, Number(cpuPercent) || 0))}%` }}
              />
            </div>
          </div>

          {/* RAM */}
          <div>
            <div className="flex justify-between text-xs font-mono text-neutral-400 mb-1">
              <span className="flex items-center">
                <Activity className="h-3.5 w-3.5 mr-1 text-neutral-500" /> RAM
              </span>
              <span className="text-neutral-200 font-semibold">{memPercent}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-neutral-800 overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  Number(memPercent) > 85 ? 'bg-red-500' :
                  Number(memPercent) > 70 ? 'bg-amber-500' : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.min(100, Math.max(0, Number(memPercent) || 0))}%` }}
              />
            </div>
          </div>

          {/* Disk */}
          <div>
            <div className="flex justify-between text-xs font-mono text-neutral-400 mb-1">
              <span className="flex items-center">
                <HardDrive className="h-3.5 w-3.5 mr-1 text-neutral-500" /> Disk
              </span>
              <span className="text-neutral-200 font-semibold">{diskPercent}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-neutral-800 overflow-hidden">
              <div
                className="h-full bg-purple-500 transition-all duration-500"
                style={{ width: `${Math.min(100, Math.max(0, Number(diskPercent) || 0))}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 3. Nút mở Web SSH Terminal (Chuẩn Touch Target >= 44x44px) */}
      <div className="mt-5 pt-4 border-t border-neutral-800/80 flex items-center justify-between">
        <span className="text-[11px] font-mono text-neutral-500">
          Loại: {node.node_type}
        </span>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenTerminal(node);
          }}
          disabled={isOffline}
          className="min-h-[44px] px-3.5 inline-flex items-center justify-center space-x-1.5 rounded-xl border border-neutral-700 bg-neutral-800/80 text-xs font-medium text-neutral-200 hover:border-cyan-500 hover:bg-cyan-500/10 hover:text-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          <Terminal className="h-4 w-4" />
          <span>Web SSH</span>
        </button>
      </div>
    </div>
  );
};
