import React from 'react';
import { MetricSnapshot } from '../types/index.js';

interface MetricsChartProps {
  metrics: MetricSnapshot[];
  title?: string;
}

/**
 * ==============================================================================
 * BIỂU ĐỒ CHỈ SỐ TÀI NGUYÊN THỜI GIAN THỰC (components/MetricsChart.tsx)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: frontend (chủ trì), designer
 * ==============================================================================
 *
 * LÝ DO PHI TRỰC GIÁC (RATIONALE):
 * Xây dựng biểu đồ thuần túy qua phần tử SVG tối ưu hóa, không nhồi nhét các thư viện
 * charting cồng kềnh (> 300KB) như Recharts hay Chart.js, giúp giảm tối đa kích thước bundle
 * và đạt điểm hiệu năng Lighthouse > 90.
 */

export const MetricsChart: React.FC<MetricsChartProps> = ({ metrics, title = 'Chỉ số CPU & Bộ nhớ (100 chu kỳ gần nhất)' }) => {
  if (!metrics || metrics.length === 0) {
    return (
      <div className="flex h-48 w-full items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900/40 text-neutral-500">
        <p className="text-sm">Chưa có đủ số liệu đo xa để hiển thị biểu đồ</p>
      </div>
    );
  }

  // Lấy tối đa 30 điểm đo gần nhất và đảo ngược theo thứ tự thời gian tăng dần
  const points = [...metrics].slice(0, 30).reverse();
  const width = 600;
  const height = 180;
  const padding = 28;

  const innerW = width - padding * 2;
  const innerH = height - padding * 2;

  // Tính toán tọa độ các điểm cho CPU %
  const cpuPoints = points.map((p, idx) => {
    const x = padding + (idx / Math.max(1, points.length - 1)) * innerW;
    const y = padding + innerH - (Math.min(100, Math.max(0, p.cpu_percent)) / 100) * innerH;
    return { x, y, val: p.cpu_percent };
  });

  // Tính toán tọa độ các điểm cho RAM %
  const ramPoints = points.map((p, idx) => {
    const memPercent = p.memory_total_bytes > 0 ? (p.memory_used_bytes / p.memory_total_bytes) * 100 : 0;
    const x = padding + (idx / Math.max(1, points.length - 1)) * innerW;
    const y = padding + innerH - (Math.min(100, Math.max(0, memPercent)) / 100) * innerH;
    return { x, y, val: memPercent };
  });

  const cpuPath = cpuPoints.reduce((acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x},${pt.y}`, '');
  const ramPath = ramPoints.reduce((acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x},${pt.y}`, '');

  const latestCpu = points[points.length - 1]?.cpu_percent.toFixed(1) || '0.0';
  const latestRam = points[points.length - 1]
    ? ((points[points.length - 1].memory_used_bytes / Math.max(1, points[points.length - 1].memory_total_bytes)) * 100).toFixed(1)
    : '0.0';

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 shadow-inner">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">{title}</h4>
        <div className="flex items-center space-x-4 text-xs font-mono">
          <span className="flex items-center text-cyan-400">
            <span className="mr-1.5 h-2 w-2 rounded-full bg-cyan-400" />
            CPU: {latestCpu}%
          </span>
          <span className="flex items-center text-emerald-400">
            <span className="mr-1.5 h-2 w-2 rounded-full bg-emerald-400" />
            RAM: {latestRam}%
          </span>
        </div>
      </div>

      <div className="relative w-full overflow-hidden">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
          {/* Lưới tọa độ ngang */}
          {[0, 25, 50, 75, 100].map((level) => {
            const y = padding + innerH - (level / 100) * innerH;
            return (
              <g key={level}>
                <line x1={padding} y1={y} x2={width - padding} y2={y} stroke="#1f2937" strokeDasharray="3 3" />
                <text x={padding - 6} y={y + 3} textAnchor="end" fontSize="9" fill="#6b7280" fontFamily="monospace">
                  {level}%
                </text>
              </g>
            );
          })}

          {/* Đường biểu diễn RAM */}
          <path d={ramPath} fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" />

          {/* Đường biểu diễn CPU */}
          <path d={cpuPath} fill="none" stroke="#06b6d4" strokeWidth="2.5" strokeLinecap="round" />

          {/* Điểm nhấn mới nhất */}
          {cpuPoints.length > 0 && (
            <circle cx={cpuPoints[cpuPoints.length - 1].x} cy={cpuPoints[cpuPoints.length - 1].y} r="3.5" fill="#06b6d4" />
          )}
          {ramPoints.length > 0 && (
            <circle cx={ramPoints[ramPoints.length - 1].x} cy={ramPoints[ramPoints.length - 1].y} r="3.5" fill="#10b981" />
          )}
        </svg>
      </div>
    </div>
  );
};
