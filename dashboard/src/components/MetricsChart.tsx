import React, { useId } from "react";
import { Activity } from "lucide-react";
import { MetricSnapshot } from "../types/index.js";
import { formatTime } from "../utils/format.js";

interface MetricsChartProps {
  metrics: MetricSnapshot[];
  title?: string;
}

const GAP_MS = 15_000;

// Points use API timestamps. Gaps remain visible instead of implying continuous data.
export const MetricsChart: React.FC<MetricsChartProps> = ({ metrics, title }) => {
  const gradientId = useId().replace(/:/g, "");
  const points = [...metrics]
    .filter((point) => Number.isFinite(Date.parse(point.recorded_at)))
    .sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at))
    .slice(-30);

  if (!points.length) {
    return (
      <div className="chart-empty">
        <Activity size={26} />
        <span>Chưa có số liệu để hiển thị biểu đồ.</span>
      </div>
    );
  }

  const width = 600;
  const height = 180;
  const padding = 6;
  const start = Date.parse(points[0].recorded_at);
  const end = Date.parse(points[points.length - 1].recorded_at);
  const y = (value: number) => padding + (1 - Math.min(100, Math.max(0, value)) / 100) * (height - padding * 2);
  const x = (time: number) => end === start ? width / 2 : padding + ((time - start) / (end - start)) * (width - padding * 2);
  const ramPercent = (point: MetricSnapshot) => point.memory_total_bytes > 0
    ? (point.memory_used_bytes / point.memory_total_bytes) * 100
    : undefined;
  type Point = { x: number; y: number; time: number; value: number };
  const segments = (readValue: (point: MetricSnapshot) => number | undefined): Point[][] => {
    const result: Point[][] = [];
    let previousTime: number | null = null;
    let needsNewSegment = true;
    for (const point of points) {
      const time = Date.parse(point.recorded_at);
      const value = readValue(point);
      if (value === undefined || !Number.isFinite(value)) {
        needsNewSegment = true;
        continue;
      }
      if (needsNewSegment || (previousTime !== null && time - previousTime > GAP_MS)) result.push([]);
      result[result.length - 1].push({ x: x(time), y: y(value), time, value });
      previousTime = time;
      needsNewSegment = false;
    }
    return result;
  };
  const cpu = segments((point) => point.cpu_percent);
  const ram = segments(ramPercent);
  const path = (segment: Point[]) => segment.map((point, index) => `${index ? "L" : "M"} ${point.x},${point.y}`).join(" ");
  const latest = points[points.length - 1];
  const percentLabel = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
  const latestCpu = percentLabel(latest.cpu_percent);
  const latestRam = percentLabel(ramPercent(latest));
  const hasGaps = points.some((point, index) => index > 0 && Date.parse(point.recorded_at) - Date.parse(points[index - 1].recorded_at) > GAP_MS);

  return (
    <div className="metrics-chart">
      {title && <h4>{title}</h4>}
      <div className="chart-legend">
        <span><i className="cpu" />CPU <b>{latestCpu}</b></span>
        <span><i className="memory" />RAM <b>{latestRam}</b></span>
        <small>{points.length} mẫu đo</small>
      </div>
      <div className="chart-plot">
        <div className="chart-scale" aria-hidden="true">
          {[100, 75, 50, 25, 0].map((level) => <span key={level}>{level}%</span>)}
        </div>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img"
          aria-label={`Biểu đồ CPU và RAM theo thời gian, ${points.length} mẫu đo. Mẫu cuối: CPU ${latestCpu}, RAM ${latestRam}.${hasGaps ? " Có khoảng mất dữ liệu trên 15 giây." : ""}`}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-cpu)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="var(--chart-cpu)" stopOpacity="0.01" />
            </linearGradient>
          </defs>
          {[0, 25, 50, 75, 100].map((level) => (
            <line key={level} x1={padding} x2={width - padding} y1={y(level)} y2={y(level)}
              stroke="var(--chart-grid)" strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
          ))}
          {cpu.filter((segment) => segment.length > 1).map((segment, index) => (
            <path key={`fill-${index}`} d={`${path(segment)} L ${segment[segment.length - 1].x},${height - padding} L ${segment[0].x},${height - padding} Z`}
              fill={`url(#${gradientId})`} />
          ))}
          {([{ name: "ram", segments: ram, color: "var(--chart-ram)" }, { name: "cpu", segments: cpu, color: "var(--chart-cpu)" }]).map((series) => (
            <g key={series.name}>
              {series.segments.map((segment, index) => (
                <g key={index}>
                  <path d={path(segment)} fill="none" stroke={series.color} strokeWidth="2.5"
                    strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                  {segment.map((point, pointIndex) => (
                    <circle key={pointIndex} cx={point.x} cy={point.y} r="3" fill={series.color}>
                      <title>{`${formatTime(new Date(point.time).toISOString())} · ${series.name.toUpperCase()} ${point.value.toFixed(1)}%`}</title>
                    </circle>
                  ))}
                </g>
              ))}
            </g>
          ))}
        </svg>
      </div>
      <div className="chart-time">
        <span>{formatTime(points[0].recorded_at)}</span>
        <span>{formatTime(new Date(start + (end - start) / 2).toISOString())}</span>
        <span>{formatTime(latest.recorded_at)}</span>
      </div>
      {hasGaps && <p className="chart-gap-note">Đường biểu diễn ngắt khi hai mẫu cách nhau hơn 15 giây.</p>}
    </div>
  );
};
