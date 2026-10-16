import React, { useId } from "react";
import { Activity } from "lucide-react";
import { MetricSnapshot } from "../types/index.js";
import { formatTime } from "../utils/format.js";

interface MetricsChartProps {
  metrics: MetricSnapshot[];
  title?: string;
}

// SVG keeps the chart small; every point represents a metric received from the API.
export const MetricsChart: React.FC<MetricsChartProps> = ({
  metrics,
  title,
}) => {
  const gradientId = useId().replace(/:/g, "");
  if (!metrics.length)
    return (
      <div className="chart-empty">
        <Activity size={26} />
        <span>Chưa có số liệu để hiển thị biểu đồ.</span>
      </div>
    );

  const points = [...metrics].slice(0, 30).reverse();
  const width = 600;
  const height = 180;
  const padding = 6;
  const position = (value: number, index: number) => ({
    x:
      padding +
      (index / Math.max(1, points.length - 1)) * (width - padding * 2),
    y:
      padding +
      (1 - Math.min(100, Math.max(0, value)) / 100) * (height - padding * 2),
  });
  const cpu = points.map((point, index) => position(point.cpu_percent, index));
  const ramPercent = (point: MetricSnapshot) =>
    point.memory_total_bytes > 0
      ? (point.memory_used_bytes / point.memory_total_bytes) * 100
      : 0;
  const ram = points.map((point, index) => position(ramPercent(point), index));
  const path = (values: { x: number; y: number }[]) =>
    values
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x},${point.y}`)
      .join(" ");
  const latest = points[points.length - 1];
  const latestCpu = latest.cpu_percent.toFixed(1);
  const latestRam = ramPercent(latest).toFixed(1);
  const cpuEnd = cpu[cpu.length - 1];
  const ramEnd = ram[ram.length - 1];

  return (
    <div className="metrics-chart">
      {title && <h4>{title}</h4>}
      <div className="chart-legend">
        <span>
          <i className="cpu" />
          CPU <b>{latestCpu}%</b>
        </span>
        <span>
          <i className="memory" />
          RAM <b>{latestRam}%</b>
        </span>
        <small>{points.length} mẫu đo</small>
      </div>
      <div className="chart-plot">
        <div className="chart-scale" aria-hidden="true">
          {[100, 75, 50, 25, 0].map((level) => (
            <span key={level}>{level}%</span>
          ))}
        </div>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Biểu đồ CPU và RAM, ${points.length} mẫu đo. Mẫu cuối: CPU ${latestCpu}%, RAM ${latestRam}%.`}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--chart-cpu)"
                stopOpacity="0.18"
              />
              <stop
                offset="100%"
                stopColor="var(--chart-cpu)"
                stopOpacity="0.01"
              />
            </linearGradient>
          </defs>
          {[0, 25, 50, 75, 100].map((level) => (
            <line
              key={level}
              x1={padding}
              x2={width - padding}
              y1={position(level, 0).y}
              y2={position(level, 0).y}
              stroke="var(--chart-grid)"
              strokeDasharray="3 5"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path
            d={`${path(cpu)} L ${cpuEnd.x},${height - padding} L ${cpu[0].x},${height - padding} Z`}
            fill={`url(#${gradientId})`}
          />
          <path
            d={path(ram)}
            fill="none"
            stroke="var(--chart-ram)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={path(cpu)}
            fill="none"
            stroke="var(--chart-cpu)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={cpuEnd.x} cy={cpuEnd.y} r="3.5" fill="var(--chart-cpu)" />
          <circle cx={ramEnd.x} cy={ramEnd.y} r="3" fill="var(--chart-ram)" />
        </svg>
      </div>
      <div className="chart-time">
        <span>{formatTime(points[0].recorded_at)}</span>
        <span>
          {formatTime(points[Math.floor((points.length - 1) / 2)].recorded_at)}
        </span>
        <span>{formatTime(latest.recorded_at)}</span>
      </div>
    </div>
  );
};
