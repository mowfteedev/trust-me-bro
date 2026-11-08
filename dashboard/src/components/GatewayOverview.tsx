import React, { useEffect, useRef, useState } from "react";
import { Activity, AlertCircle, ArrowRight, ArrowUpRight, Check, Clock3, Cpu, Database, Globe, HardDrive, MemoryStick, Network, RefreshCw, Server, Shield, ShieldCheck } from "lucide-react";
import { api } from "../services/api.js";
import type { HostService, HostServiceState, HostSnapshot, UserSession } from "../types/index.js";
import { formatBytes, formatDateTime, formatTime, formatUptime } from "../utils/format.js";
import { appendHostHistory, type HostHistoryPoint, type HostResource } from "../utils/hostHistory.js";
import { HostResourceTrend } from "./HostResourceTrend.js";

const states: Record<HostServiceState, string> = {
  healthy: "Ổn định", running: "Đang chạy", unhealthy: "Lỗi kiểm tra",
  stopped: "Đã dừng", unknown: "Chưa rõ",
};
const serviceInfo = {
  proxy: { icon: Globe, role: "HTTPS", check: "HTTPS /" },
  gateway: { icon: Server, role: "API", check: "API /readyz" },
  postgres: { icon: Database, role: "Database", check: "Docker healthcheck" },
  wireguard_gateway: { icon: Shield, role: "VPN", check: "Docker healthcheck" },
};
const order: HostService["id"][] = ["proxy", "gateway", "postgres", "wireguard_gateway"];

function percent(used: number, total: number): number | undefined {
  return Number.isFinite(used) && Number.isFinite(total) && used >= 0 && total > 0 && used <= total
    ? used / total * 100 : undefined;
}

interface Props {
  currentUser: UserSession;
  onNavigateFleet: () => void;
  onNavigateAudit: (action?: string) => void;
}

export const GatewayOverview: React.FC<Props> = ({ currentUser, onNavigateFleet, onNavigateAudit }) => {
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null);
  const [history, setHistory] = useState<HostHistoryPoint[]>([]);
  const [resource, setResource] = useState<HostResource>("cpu");
  const [selectedServiceId, setSelectedServiceId] = useState<HostService["id"]>("gateway");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    let active = true;
    let pending = false;
    const load = async () => {
      if (pending || !active) return;
      pending = true;
      setBusy(true);
      try {
        const result = await api.getHost();
        if (!active) return;
        setSnapshot(result);
        setHistory(previous => appendHostHistory(previous, result));
        setError(null);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Không tải được thông số Gateway.");
      } finally {
        pending = false;
        if (active) { setBusy(false); setLoading(false); }
      }
    };
    refresh.current = load;
    void load();
    const timer = setInterval(load, 5000);
    return () => { active = false; refresh.current = null; clearInterval(timer); };
  }, []);

  const host = snapshot?.host;
  const stale = Boolean(snapshot?.stale || error);
  const healthy = snapshot?.services.filter(service => service.state === "healthy").length ?? 0;
  const attention = snapshot?.services.some(service => ["unhealthy", "stopped"].includes(service.state));
  const tone = stale ? "unknown" : attention ? "unhealthy" : healthy === 4 ? "healthy" : "running";
  const selected = snapshot?.services.find(service => service.id === selectedServiceId);
  const resources = host ? [
    { id: "cpu" as const, label: "CPU", icon: Cpu, value: host.cpu_percent ?? undefined, hint: null },
    { id: "ram" as const, label: "RAM", icon: MemoryStick, value: percent(host.memory_used_bytes, host.memory_total_bytes), hint: `${formatBytes(host.memory_used_bytes)} / ${formatBytes(host.memory_total_bytes)}` },
    { id: "disk" as const, label: "Ổ đĩa", icon: HardDrive, value: percent(host.disk_used_bytes, host.disk_total_bytes), hint: `${formatBytes(host.disk_used_bytes)} / ${formatBytes(host.disk_total_bytes)}` },
  ] : [];

  return (
    <div className="overview workspace-page gateway-overview host-overview" id="gateway-overview" data-stale={stale}>
      <div className="page-heading">
        <h1>Tổng quan</h1>
        <button className="button secondary" aria-label="Làm mới" title="Làm mới thông số Gateway"
          onClick={() => void refresh.current?.()} disabled={busy}>
          <RefreshCw size={18} className={busy ? "animate-spin" : ""} /><span>Làm mới</span>
        </button>
      </div>
      {error && <div className="notice warning" role="alert"><AlertCircle size={18} />{error}{snapshot && " Đang hiển thị dữ liệu cũ."}</div>}
      {loading && !snapshot ? (
        <div className="gateway-loading" aria-busy="true" aria-label="Đang tải thông số Gateway">
          <div className="skeleton gateway-banner-skeleton" /><div className="skeleton gateway-content-skeleton" />
        </div>
      ) : snapshot && host ? <>
        <section className="panel gateway-banner" data-state={tone} aria-label="Tình trạng máy Gateway">
          <div className="gateway-banner-identity">
            <span className="gateway-health-icon">{tone === "healthy" ? <ShieldCheck size={30} /> : <Server size={30} />}</span>
            <div><span className="gateway-overline">Máy Gateway</span><h2>{stale ? "Chờ cập nhật" : attention ? "Cần kiểm tra dịch vụ" : healthy === 4 ? "Hệ thống ổn định" : "Đang kiểm tra dịch vụ"}</h2><span className="gateway-hostname">{host.hostname}</span></div>
          </div>
          <div className="gateway-banner-facts">
            <span className="gateway-health-count"><i data-state={tone} />{healthy} / 4 dịch vụ ổn định</span>
            <span><Clock3 size={16} /><strong data-host-uptime>{formatUptime(host.uptime_seconds)}</strong></span>
            <span className={`gateway-data-state ${stale ? "is-stale" : ""}`}>
              {stale ? "Dữ liệu cũ" : "Mẫu đo"} <time dateTime={snapshot.sampled_at} title={formatDateTime(snapshot.sampled_at)}>{formatTime(snapshot.sampled_at)}</time>
            </span>
          </div>
        </section>
        <div className="gateway-main-grid">
          <section className="panel gateway-resources" aria-labelledby="gateway-resources-title">
            <div className="gateway-section-heading"><h2 id="gateway-resources-title"><Activity size={19} />Tài nguyên host</h2><span>CPU · RAM · Ổ đĩa</span></div>
            <div className="gateway-resource-grid" aria-label="Tài nguyên máy chạy Gateway">
              {resources.map(({ id, label, icon: Icon, value, hint }) => (
                <article className={`gateway-resource gateway-resource--${id}`} key={id} data-host-resource={id} data-selected={resource === id}>
                  <button className="gateway-resource-select" aria-label={`Xem diễn biến ${label}`} aria-pressed={resource === id} onClick={() => setResource(id)}>
                    <span className="gateway-resource-label"><Icon size={17} />{label}{resource === id && <Check size={14} />}</span>
                    <strong className="gateway-resource-value">{value === undefined ? "—" : value.toFixed(value >= 99.95 ? 0 : 1)}{value !== undefined && <small>%</small>}</strong>
                    <span className="gateway-resource-meter" aria-hidden="true"><i style={{ width: `${value ?? 0}%` }} /></span>
                    <span className="gateway-resource-capacity" aria-hidden={hint === null}>{hint ?? "\u00a0"}</span>
                  </button>
                </article>
              ))}
            </div>
            <HostResourceTrend points={history} resource={resource} />
            <div className="gateway-host-network" aria-label="Lưu lượng mạng tích lũy của host">
              <span className="gateway-network-interface"><Network size={17} />{host.network_interface}</span>
              <div><span>RX tích lũy</span><strong>{formatBytes(host.network_rx_bytes)}</strong></div>
              <div><span>TX tích lũy</span><strong>{formatBytes(host.network_tx_bytes)}</strong></div>
            </div>
          </section>
          <section className="panel gateway-services" id="gateway-services" aria-labelledby="gateway-services-title">
            <div className="gateway-section-heading"><h2 id="gateway-services-title"><Network size={19} />Luồng dịch vụ</h2><span>{snapshot.services.length} dịch vụ</span></div>
            <div className="gateway-service-topology" aria-label="Caddy tới Gateway tới PostgreSQL; WireGuard kết nối Gateway">
              {order.map(id => {
                const service = snapshot.services.find(item => item.id === id);
                if (!service) return null;
                const info = serviceInfo[id]; const Icon = info.icon;
                return <article className={`gateway-service gateway-service--${id}`} key={id} data-service-id={id} data-service-state={service.state}>
                  <button className="gateway-service-node" aria-label={`Xem dịch vụ ${service.name}: ${states[service.state]}`} title={states[service.state]} aria-pressed={selectedServiceId === id}
                    onClick={() => setSelectedServiceId(id)}>
                    <span className="gateway-service-node-top"><Icon size={20} /><i className="gateway-status-dot" data-state={service.state} /></span>
                    <strong>{service.name}</strong><span>{info.role}</span>
                    <span className="gateway-service-bars" aria-hidden="true">
                      {Array.from({ length: Math.max(0, 30 - service.observations.length) }, (_, i) => <i key={`empty-${i}`} data-state="unknown" />)}
                      {service.observations.slice(-30).map((point, i) => <i key={`${point.at}-${i}`} data-state={point.state} data-observed-at={point.at} title={`${formatDateTime(point.at)} · ${states[point.state]}`} />)}
                    </span>
                  </button>
                </article>;
              })}
              <span className="gateway-flow-label" aria-hidden="true">HTTPS <ArrowRight size={13} /> API <ArrowRight size={13} /> SQL</span>
            </div>
            {selected && <div className="gateway-service-detail" data-selected-service={selected.id}>
              <div className="gateway-service-detail-heading"><h3>{selected.name}</h3><span className="gateway-service-state" data-state={selected.state}><i className="gateway-status-dot" data-state={selected.state} />{states[selected.state]}</span></div>
              <dl className="gateway-service-meta">
                <div><dt>Kiểm tra</dt><dd>{serviceInfo[selected.id].check}</dd></div>
                <div><dt>Khởi động lại</dt><dd>{selected.restarts}</dd></div>
                <div className="gateway-service-start"><dt>Khởi động</dt><dd><time dateTime={selected.started_at ?? undefined}>{formatDateTime(selected.started_at)}</time></dd></div>
              </dl>
              <details className="gateway-check-details" key={selected.id}>
                <summary>{selected.observations.length} lần kiểm tra gần nhất</summary>
                <ol>{[...selected.observations].reverse().map((point, i) => <li key={`${point.at}-${i}`}><time dateTime={point.at}>{formatDateTime(point.at)}</time><span data-state={point.state}><i className="gateway-status-dot" data-state={point.state} />{states[point.state]}</span></li>)}</ol>
              </details>
              {selected.id === "wireguard_gateway" && <button className="button secondary gateway-context-action" onClick={onNavigateFleet}>Xem máy chủ<ArrowUpRight size={17} /></button>}
              {selected.id === "gateway" && currentUser.role === "ADMIN" && <button className="button secondary gateway-context-action" onClick={() => onNavigateAudit("LOGIN_FAILED")}>Nhật ký đăng nhập thất bại<ArrowUpRight size={17} /></button>}
            </div>}
          </section>
        </div>
      </> : !error && <section className="state-panel"><h2>Chưa có thông số Gateway</h2></section>}
    </div>
  );
};
