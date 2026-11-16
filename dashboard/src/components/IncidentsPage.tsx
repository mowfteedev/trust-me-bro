import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpRight, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { api } from '../services/api.js';
import type { DeliveryStatus, IncidentPage } from '../types/index.js';
import { formatDateTime } from '../utils/format.js';
import { startVisiblePolling } from '../utils/visiblePolling.js';

const deliveryLabels: Record<DeliveryStatus['status'], string> = {
  PENDING: 'Chờ gửi', PROCESSING: 'Đang gửi', SENT: 'Telegram đã nhận', FAILED: 'Gửi thất bại',
  DRY_RUN: 'Giả lập', DISABLED: 'Đã tắt gửi',
};
const duration = (seconds: number) => seconds < 60 ? `${seconds} giây`
  : seconds < 3600 ? `${Math.floor(seconds / 60)} phút ${seconds % 60} giây`
    : `${Math.floor(seconds / 3600)} giờ ${Math.floor(seconds % 3600 / 60)} phút`;
function Delivery({ value }: { value: DeliveryStatus | null }) {
  return <span className={`delivery-status delivery-${value?.status.toLowerCase() ?? 'unknown'}`}
    title={value ? `${value.attempts} lần thử${value.last_error ? ` · ${value.last_error}` : ''}` : 'Sự cố chưa có dữ liệu kết quả gửi'}>
    {value ? deliveryLabels[value.status] : 'Chưa ghi nhận'}
  </span>;
}

export function IncidentsPage({ onOpenNode, onOpenAudit }: {
  onOpenNode: (id: string, name: string | null) => void;
  onOpenAudit: (name: string) => void;
}) {
  const [state, setState] = useState<'open' | 'resolved' | 'all'>('open');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<IncidentPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true, pending = false;
    setData(null); setLoading(true); setError(null);
    const load = async () => {
      if (pending) return;
      pending = true; setBusy(true);
      try { const result = await api.getIncidents(state, page); if (active) { setData(result); setError(null); } }
      catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Không tải được sự cố.'); }
      finally { pending = false; if (active) { setBusy(false); setLoading(false); } }
    };
    const stop = startVisiblePolling(load, 10000);
    return () => { active = false; stop(); };
  }, [state, page, revision]);

  return <section className="management-page" aria-labelledby="incidents-heading">
    <div className="page-heading"><h1 id="incidents-heading"><AlertTriangle size={24} /> Sự cố</h1><button className="button secondary" aria-label="Làm mới sự cố" disabled={busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={18} className={busy ? 'animate-spin' : ''} /><span>Làm mới</span></button></div>
    <div className="management-toolbar"><label>Trạng thái<select value={state} onChange={event => { setState(event.target.value as typeof state); setPage(1); }}><option value="open">Đang mở</option><option value="resolved">Đã phục hồi</option><option value="all">Tất cả</option></select></label><span>{data ? `${data.pagination.total} sự cố` : ''}</span></div>
    {error && <div className="notice danger" role="alert">{error} <button className="button secondary" onClick={() => setRevision(value => value + 1)}>Thử lại</button></div>}
    {loading && <p role="status">Đang tải sự cố…</p>}
    {!loading && !error && data?.data.length === 0 && <div className="management-panel empty-state">Không có sự cố {state === 'open' ? 'đang mở' : state === 'resolved' ? 'đã phục hồi' : 'được ghi nhận'}.</div>}
    {data && data.data.length > 0 && <div className="incident-list">{data.data.map(incident => <article className={`management-panel incident-card ${incident.resolved_at ? 'is-resolved' : 'is-open'}`} key={incident.id}>
      <div className="incident-title"><h2>{incident.type === 'CPU_HIGH' ? 'CPU vượt ngưỡng' : incident.type === 'NODE_OFFLINE' ? 'Mất kết nối Worker' : 'Sự cố hệ thống'}</h2><span className="incident-state">{incident.resolved_at ? 'Đã phục hồi' : 'Đang mở'}</span></div>
      <button className="incident-node" disabled={!incident.node_id} onClick={() => onOpenNode(incident.node_id, incident.node_name)}>{incident.node_name || 'Máy chủ không còn trong danh sách'}<ArrowUpRight size={16} /></button>
      <dl className="incident-facts"><div><dt>Bắt đầu</dt><dd>{formatDateTime(incident.created_at)}</dd></div><div><dt>Phục hồi</dt><dd>{incident.resolved_at ? formatDateTime(incident.resolved_at) : 'Chưa phục hồi'}</dd></div><div><dt>Kéo dài</dt><dd>{duration(incident.duration_seconds)}</dd></div><div><dt>IP máy chủ</dt><dd>{incident.ip_address || 'Không có dữ liệu'}</dd></div></dl>
      <div className="incident-delivery"><span>Cảnh báo <Delivery value={incident.opening_delivery} /></span><span>Phục hồi {incident.resolved_at ? <Delivery value={incident.recovery_delivery} /> : '—'}</span></div>
      {incident.node_name && <button className="button secondary" onClick={() => onOpenAudit(incident.node_name!)}>Xem nhật ký liên quan <ArrowUpRight size={16} /></button>}
    </article>)}</div>}
    <div className="management-pagination"><button className="button secondary" aria-label="Trang sự cố trước" disabled={page === 1 || busy} onClick={() => setPage(value => value - 1)}><ChevronLeft size={18} /></button><span>Trang {page}{data ? ` / ${Math.max(1, data.pagination.total_pages)}` : ''}</span><button className="button secondary" aria-label="Trang sự cố sau" disabled={!data || page >= data.pagination.total_pages || busy} onClick={() => setPage(value => value + 1)}><ChevronRight size={18} /></button></div>
  </section>;
}
