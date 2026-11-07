import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Clock3, Cpu, HardDrive, MemoryStick, Network, RefreshCw, Server } from "lucide-react";
import { api } from "../services/api.js";
import type { HostServiceState, HostSnapshot } from "../types/index.js";
import { formatBytes, formatDateTime, formatTime, formatUptime } from "../utils/format.js";

const states: Record<HostServiceState, string> = {
  healthy: "Ổn định", running: "Đang chạy", unhealthy: "Lỗi kiểm tra",
  stopped: "Đã dừng", unknown: "Chưa rõ",
};

function percent(used: number, total: number): number | undefined {
  return Number.isFinite(used) && Number.isFinite(total) && used >= 0 && total > 0 && used <= total
    ? used / total * 100 : undefined;
}

export const GatewayOverview: React.FC = () => {
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (pending.current) return;
    const startedGeneration = generation.current;
    pending.current = true;
    setBusy(true);
    try {
      const result = await api.getHost();
      if (startedGeneration !== generation.current) return;
      setSnapshot(result);
      setError(null);
    } catch (reason) {
      if (startedGeneration === generation.current) {
        setError(reason instanceof Error ? reason.message : "Không tải được thông số Gateway.");
      }
    } finally {
      pending.current = false;
      if (startedGeneration === generation.current) { setBusy(false); setLoading(false); }
    }
  }, []);

  useEffect(() => {
    generation.current++;
    load();
    const timer = setInterval(load, 5000);
    return () => { generation.current++; clearInterval(timer); };
  }, [load]);

  const host = snapshot?.host;
  const stale = Boolean(snapshot?.stale || error);
  const resources = host ? [
    { id: "cpu", label: "CPU", icon: Cpu, value: host.cpu_percent ?? undefined, hint: null },
    { id: "ram", label: "RAM", icon: MemoryStick, value: percent(host.memory_used_bytes, host.memory_total_bytes), hint: `${formatBytes(host.memory_used_bytes)} / ${formatBytes(host.memory_total_bytes)}` },
    { id: "disk", label: "Ổ đĩa", icon: HardDrive, value: percent(host.disk_used_bytes, host.disk_total_bytes), hint: `${formatBytes(host.disk_used_bytes)} / ${formatBytes(host.disk_total_bytes)}` },
  ] : [];

  return (
    <div className="overview workspace-page gateway-overview host-overview" id="gateway-overview" data-stale={stale}>
      <div className="page-heading">
        <h1>Tổng quan</h1>
        <button className="button secondary" aria-label="Làm mới" title="Làm mới thông số Gateway"
          onClick={load} disabled={busy}>
          <RefreshCw size={18} className={busy ? "animate-spin" : ""} /><span>Làm mới</span>
        </button>
      </div>
      {error && <div className="notice warning" role="alert"><AlertCircle size={18} />{error}{snapshot && " Đang hiển thị dữ liệu cũ."}</div>}
      {loading && !snapshot ? (
        <div className="gateway-loading" aria-busy="true" aria-label="Đang tải thông số Gateway">
          <div className="gateway-resource-grid">{[0, 1, 2].map(key => <div className="skeleton" key={key} />)}</div>
          <div className="skeleton gateway-service-skeleton" />
        </div>
      ) : snapshot && host ? <>
        <div className="gateway-host-heading">
          <h2><Server size={19} /> Gateway <span>{host.hostname}</span></h2>
          <span className={`gateway-data-state ${stale ? "is-stale" : ""}`}>
            {stale ? "Dữ liệu cũ" : "Mẫu đo"} <time dateTime={snapshot.sampled_at} title={formatDateTime(snapshot.sampled_at)}>{formatTime(snapshot.sampled_at)}</time>
          </span>
        </div>
        <section className="gateway-resource-grid" aria-label="Tài nguyên máy chạy Gateway">
          {resources.map(({ id, label, icon: Icon, value, hint }) => (
            <article className={`panel gateway-resource gateway-resource--${id}`} key={id} data-host-resource={id}>
              <h3><Icon size={18} />{label}</h3>
              <strong className="gateway-resource-value">{value === undefined ? "—" : value.toFixed(1)}{value !== undefined && <small>%</small>}</strong>
              <div className="gateway-resource-meter" aria-hidden="true"><i style={{ width: `${value ?? 0}%` }} /></div>
              <span className="gateway-resource-capacity" aria-hidden={hint === null}>{hint ?? "\u00a0"}</span>
            </article>
          ))}
        </section>
        <section className="panel gateway-host-stats" aria-label="Uptime và mạng của Gateway">
          <div><span><Clock3 size={17} />Thời gian chạy</span><strong data-host-uptime>{formatUptime(host.uptime_seconds)}</strong></div>
          <div><span><Network size={17} />RX tích lũy · {host.network_interface}</span><strong>{formatBytes(host.network_rx_bytes)}</strong></div>
          <div><span><Network size={17} />TX tích lũy · {host.network_interface}</span><strong>{formatBytes(host.network_tx_bytes)}</strong></div>
        </section>
        <section className="panel gateway-services" aria-labelledby="gateway-services-title">
          <div className="gateway-services-heading"><h2 id="gateway-services-title">Dịch vụ</h2><span>Trạng thái theo lần kiểm tra</span></div>
          <div className="gateway-service-list">
            {snapshot.services.map(service => (
              <article className="gateway-service" key={service.id} data-service-id={service.id} data-service-state={service.state}>
                <div className="gateway-service-heading"><h3>{service.name}</h3><span className="gateway-service-state" data-state={service.state}>{states[service.state]}</span></div>
                <div className="gateway-service-bars" role="img" aria-label={`${service.name}: ${service.observations.length} mẫu kiểm tra gần nhất`}>
                  {Array.from({ length: Math.max(0, 30 - service.observations.length) }, (_, i) => <i key={`empty-${i}`} data-state="unknown" title="Chưa có mẫu kiểm tra" />)}
                  {service.observations.slice(-30).map((point, i) => <i key={`${point.at}-${i}`} data-state={point.state} data-observed-at={point.at} title={`${formatDateTime(point.at)} · ${states[point.state]}`} />)}
                </div>
                <div className="gateway-service-meta">
                  <span>Khởi động <time dateTime={service.started_at ?? undefined}>{formatDateTime(service.started_at)}</time></span>
                  <span>Khởi động lại <b>{service.restarts}</b></span>
                </div>
              </article>
            ))}
          </div>
          <div className="gateway-service-legend" aria-label="Chú giải trạng thái dịch vụ">
            <span><i data-state="healthy" />Ổn định</span><span><i data-state="running" />Đang chạy</span>
            <span><i data-state="unhealthy" />Lỗi / dừng</span><span><i data-state="unknown" />Chưa rõ</span>
          </div>
        </section>
      </> : !error && <section className="state-panel"><h2>Chưa có thông số Gateway</h2></section>}
    </div>
  );
};
