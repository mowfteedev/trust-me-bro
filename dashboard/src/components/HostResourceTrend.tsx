import React, { useId, useState } from "react";
import { Activity } from "lucide-react";
import { formatTime } from "../utils/format.js";
import { hostTrendSegments, type HostHistoryPoint, type HostResource } from "../utils/hostHistory.js";
const labels = { cpu: "CPU", ram: "RAM", disk: "Ổ đĩa" };
const colors = { cpu: "var(--chart-cpu)", ram: "var(--chart-ram)", disk: "var(--chart-disk)" };
interface Props { points: HostHistoryPoint[]; resource: HostResource }
export const HostResourceTrend: React.FC<Props> = ({ points, resource }) => {
  const gradientId = `host-trend-${useId().replace(/:/g, "")}`;
  const [inspectedAt, setInspectedAt] = useState<string | null>(null);
  if (!points.length) return <div className="host-trend-empty" data-host-trend={resource}><Activity size={22} /><span>Chưa có mẫu trong phiên xem.</span></div>;
  const width = 680, height = 170, padding = 8;
  const start = Date.parse(points[0].at), end = Date.parse(points[points.length - 1].at);
  const x = (time: number) => start === end ? width / 2 : padding + (time - start) / (end - start) * (width - padding * 2);
  const y = (value: number) => padding + (1 - value / 100) * (height - padding * 2);
  const found = inspectedAt === null ? -1 : points.findIndex(point => point.at === inspectedAt);
  const index = found < 0 ? points.length - 1 : found, point = points[index];
  const segments = hostTrendSegments(points, resource);
  const path = (segment: typeof segments[number]) => segment.map((item, i) => `${i ? "L" : "M"}${x(item.time)},${y(item.value)}`).join(" ");
  const value = point[resource], text = value === null ? "—" : `${value.toFixed(1)}%`;
  const gaps = points.some((item, i) => i > 0 && Date.parse(item.at) - Date.parse(points[i - 1].at) > 15000);
  const inspect = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" && event.type === "pointermove" && event.buttons === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const time = start + position * (end - start);
    const closest = points.reduce((best, candidate) => Math.abs(Date.parse(candidate.at) - time) < Math.abs(Date.parse(best.at) - time) ? candidate : best);
    setInspectedAt(closest.at);
  };
  const keyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next = event.key === "Home" ? 0 : event.key === "End" ? points.length - 1
      : event.key === "ArrowLeft" || event.key === "ArrowDown" ? Math.max(0, index - 1)
      : event.key === "ArrowRight" || event.key === "ArrowUp" ? Math.min(points.length - 1, index + 1) : null;
    if (next === null) return;
    event.preventDefault(); setInspectedAt(points[next].at);
  };
  return <div className="host-resource-trend" data-host-trend={resource} style={{ "--host-trend-color": colors[resource] } as React.CSSProperties}>
    <div className="host-trend-heading"><div><h3>Diễn biến {labels[resource]}</h3><span>Trong phiên xem · {points.length} mẫu</span></div>
      <output className="host-trend-readout" data-chart-sample-at={point.at} data-chart-resource-value={value ?? "unknown"}><strong>{text}</strong><time dateTime={point.at}>{formatTime(point.at)}</time></output>
    </div>
    <div className="host-trend-plot"><div className="host-trend-scale" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
      <div className="host-trend-inspector" role="slider" tabIndex={0} aria-label={`Chọn mẫu ${labels[resource]}`}
        aria-valuemin={0} aria-valuemax={points.length - 1} aria-valuenow={index} aria-valuetext={`${formatTime(point.at)}, ${labels[resource]} ${text}`}
        onPointerDown={inspect} onPointerMove={inspect} onPointerLeave={() => setInspectedAt(null)} onKeyDown={keyboard}>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Diễn biến ${labels[resource]}, ${points.length} mẫu đo trong phiên xem${gaps ? ", có khoảng gián đoạn" : ""}`}>
          <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={colors[resource]} stopOpacity=".22" /><stop offset="100%" stopColor={colors[resource]} stopOpacity=".01" /></linearGradient></defs>
          {[0, 25, 50, 75, 100].map(level => <line key={level} x1={padding} x2={width - padding} y1={y(level)} y2={y(level)} stroke="var(--chart-grid)" strokeDasharray="3 6" vectorEffect="non-scaling-stroke" />)}
          {segments.map((segment, i) => <g key={i}>
            {segment.length > 1 && <path d={`${path(segment)} L${x(segment[segment.length - 1].time)},${height - padding} L${x(segment[0].time)},${height - padding} Z`} fill={`url(#${gradientId})`} />}
            <path d={path(segment)} fill="none" stroke={colors[resource]} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {segment.map(item => <circle key={item.at} cx={x(item.time)} cy={y(item.value)} r="3" fill={colors[resource]}><title>{formatTime(item.at)} · {item.value.toFixed(1)}%</title></circle>)}
          </g>)}
          <line x1={x(Date.parse(point.at))} x2={x(Date.parse(point.at))} y1={padding} y2={height - padding} stroke="var(--border-strong)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
          {value !== null && <circle cx={x(Date.parse(point.at))} cy={y(value)} r="5" fill="var(--panel)" stroke={colors[resource]} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
    </div>
    <div className="host-trend-times"><time dateTime={points[0].at}>{formatTime(points[0].at)}</time><span>{points.length === 1 ? "Đang chờ thêm mẫu" : gaps ? "Có gián đoạn >15 giây" : "← → để xem từng mẫu"}</span><time dateTime={points[points.length - 1].at}>{formatTime(points[points.length - 1].at)}</time></div>
  </div>;
};
