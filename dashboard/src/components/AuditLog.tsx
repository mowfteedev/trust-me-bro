import React, { useEffect, useState } from "react";
import {
  ClipboardList,
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Shield,
  Terminal,
  LogIn,
  LogOut,
  AlertTriangle,
  AlertCircle,
  X,
  ArrowUpRight,
} from "lucide-react";
import { api } from "../services/api.js";
import { AuditLogPage } from "../types/index.js";
import { formatTime } from "../utils/format.js";

const events = [
  {
    value: "LOGIN_FAILED",
    label: "Đăng nhập thất bại",
    icon: AlertCircle,
    tone: "danger",
  },
  {
    value: "LOGIN_SUCCESS",
    label: "Đăng nhập thành công",
    icon: LogIn,
    tone: "auth",
  },
  { value: "LOGOUT_SUCCESS", label: "Đăng xuất", icon: LogOut, tone: "auth" },
  {
    value: "BASTION_TICKET_ISSUED",
    label: "Cấp vé SSH",
    icon: Shield,
    tone: "ssh",
  },
  {
    value: "BASTION_SESSION_START",
    label: "Mở phiên SSH",
    icon: Terminal,
    tone: "ssh",
  },
  {
    value: "BASTION_SESSION_END",
    label: "Kết thúc phiên SSH",
    icon: Terminal,
    tone: "ssh",
  },
  {
    value: "CPU_HIGH",
    label: "CPU vượt ngưỡng",
    icon: AlertTriangle,
    tone: "warning",
  },
  {
    value: "NODE_OFFLINE",
    label: "Máy chủ Offline",
    icon: AlertCircle,
    tone: "danger",
  },
];
const detailLabels: Record<string, string> = {
  attempted_username: "Tài khoản thử đăng nhập",
  session_id: "ID phiên SSH",
  reason: "Lý do",
  target_ip: "IP đích",
  message: "Nội dung",
  cpu_percent: "CPU đo được",
  threshold: "Ngưỡng cảnh báo",
  ip: "IP máy chủ",
  last_seen: "Heartbeat lần cuối",
};

interface AuditLogProps {
  initialFilters?: { action?: string; q?: string };
  onOpenNode?: (id: string, name: string | null) => void;
}

export const AuditLog: React.FC<AuditLogProps> = ({ initialFilters, onOpenNode }) => {
  const initialAction = events.find(event => event.value === initialFilters?.action)?.value ?? "";
  const initialSearch = initialFilters?.q?.trim().slice(0, 100) ?? "";
  const [filters, setFilters] = useState({ page: 1, action: initialAction, q: initialSearch });
  const [search, setSearch] = useState(initialSearch);
  const [action, setAction] = useState(initialAction);
  const [refreshKey, setRefreshKey] = useState(0);
  const [result, setResult] = useState<AuditLogPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    setResult(null);
    api
      .getAuditLogs(filters)
      .then((data) => {
        if (!current) return;
        setResult(data);
        setLoadedAt(new Date().toISOString());
        setLoading(false);
      })
      .catch((err: Error) => {
        if (!current) return;
        setError(err.message || "Không tải được nhật ký hoạt động.");
        setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [filters, refreshKey]);

  const refresh = () => {
    setFilters((previous) => ({ ...previous, page: 1 }));
    setRefreshKey((previous) => previous + 1);
  };
  const apply = (event: React.FormEvent) => {
    event.preventDefault();
    setFilters({ page: 1, action, q: search.trim() });
  };
  const clear = () => {
    setSearch("");
    setAction("");
    setFilters({ page: 1, action: "", q: "" });
  };

  return (
    <div className="overview audit-page">
      <div className="page-heading">
        <div>
          <h1>Nhật ký hoạt động</h1>
        </div>
        <button
          className="button secondary"
          aria-label="Làm mới nhật ký"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          <span>Làm mới</span>
        </button>
      </div>
      <section className="panel audit-panel" aria-labelledby="audit-title">
        <div className="audit-panel-title">
          <h2 id="audit-title" title="Nhật ký sự kiện; không ghi nội dung lệnh terminal.">
            <ClipboardList size={18} />
            Sự kiện hệ thống
          </h2>
          <span>
            {result ? `${result.data.length} sự kiện` : ""}
            {loadedAt && !error && !loading && ` · ${formatTime(loadedAt)}`}
          </span>
        </div>
        <form className="audit-filters" onSubmit={apply}>
          <div className="audit-search">
            <label htmlFor="audit-search">Tìm kiếm</label>
            <div className="fleet-search">
              <Search size={16} />
              <input
                id="audit-search"
                value={search}
                maxLength={100}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Tên tài khoản, máy chủ hoặc IP..."
              />
            </div>
          </div>
          <div className="audit-event-filter">
            <label htmlFor="audit-event">Loại sự kiện</label>
            <select
              id="audit-event"
              value={action}
              onChange={(event) => setAction(event.target.value)}
            >
              <option value="">Tất cả sự kiện</option>
              {events.map((item) => (
                <option value={item.value} key={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
          <button className="button secondary" type="submit" disabled={loading}>
            Áp dụng
          </button>
          {(search || action || filters.q || filters.action) && (
            <button
              className="icon-button"
              type="button"
              aria-label="Xóa bộ lọc"
              title="Xóa bộ lọc"
              onClick={clear}
              disabled={loading}
            >
              <X size={17} />
            </button>
          )}
        </form>
        <div className="audit-results" aria-busy={loading}>
          {loading ? (
            <div className="audit-loading" role="status">
              <div className="skeleton" />
              <div className="skeleton" />
              <div className="skeleton" />
              <span>Đang tải nhật ký...</span>
            </div>
          ) : error ? (
            <div className="audit-state" role="alert">
              <AlertCircle size={28} />
              <h3>Không tải được nhật ký</h3>
              <p>{error}</p>
              <button className="button secondary" onClick={refresh}>
                Thử lại
              </button>
            </div>
          ) : result?.data.length === 0 ? (
            <div className="audit-state">
              <ClipboardList size={28} />
              <h3>
                {filters.q || filters.action
                  ? "Không có sự kiện phù hợp"
                  : "Chưa có sự kiện trên trang này"}
              </h3>
              {(filters.q || filters.action) && (
                <button className="button secondary" onClick={clear}>
                  Xóa bộ lọc
                </button>
              )}
            </div>
          ) : (
            result && (
              <table className="audit-table">
                <thead>
                  <tr>
                    <th scope="col">Thời gian</th>
                    <th scope="col">Sự kiện</th>
                    <th scope="col">Người thực hiện</th>
                    <th scope="col">Đối tượng</th>
                    <th scope="col">Chi tiết</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.map((entry) => {
                    const event = events.find(
                      (item) => item.value === entry.action,
                    );
                    const Icon = event?.icon || ClipboardList;
                    const detailItems = Object.entries(entry.details).filter(
                      ([key, value]) =>
                        value !== undefined &&
                        (value !== null || key === "last_seen") &&
                        value !== "",
                    );
                    return (
                      <tr key={entry.id}>
                        <td data-label="Thời gian">
                          <time dateTime={entry.created_at}>
                            <strong>{formatTime(entry.created_at)}</strong>
                            <span>
                              {new Date(entry.created_at).toLocaleDateString(
                                "vi-VN",
                              )}
                            </span>
                          </time>
                        </td>
                        <td data-label="Sự kiện">
                          <div
                            className={`audit-event ${event?.tone || "other"}`}
                          >
                            <Icon size={15} />
                            <span>{event?.label || entry.action}</span>
                          </div>
                        </td>
                        <td data-label="Người thực hiện">
                          <strong className="audit-actor">
                            {entry.username ||
                              entry.details.attempted_username ||
                              (entry.user_id
                                ? "Tài khoản không xác định"
                                : "Hệ thống")}
                          </strong>
                          {entry.ip_address && (
                            <span className="audit-secondary" title="IP ghi nhận">{entry.ip_address}</span>
                          )}
                        </td>
                        <td data-label="Đối tượng">
                          {entry.node_id && onOpenNode ? (
                            <button type="button" className="context-link audit-node-link"
                              data-node-id={entry.node_id}
                              aria-label={`Xem máy chủ ${entry.node_name || entry.node_id}`}
                              onClick={() => entry.node_id && onOpenNode(entry.node_id, entry.node_name)}>
                              {entry.node_name || entry.node_id}<ArrowUpRight size={14} aria-hidden="true" />
                            </button>
                          ) : <strong className="audit-target">
                            {entry.node_name ||
                              entry.node_id ||
                              (entry.target === "auth"
                                ? "Xác thực"
                                : entry.target === "bastion"
                                  ? "SSH Gateway"
                                  : entry.target || "Gateway")}
                          </strong>}
                        </td>
                        <td
                          className="audit-details-cell"
                          data-label="Chi tiết"
                        >
                          <details className="audit-details">
                            <summary
                              aria-label={`Chi tiết sự kiện ${entry.id}`}
                            >
                              <span>Xem</span>
                              <ChevronDown size={14} />
                            </summary>
                            <dl>
                              <div>
                                <dt>ID sự kiện</dt>
                                <dd>{entry.id}</dd>
                              </div>
                              <div><dt>Mã sự kiện</dt><dd>{entry.action}</dd></div>
                              {entry.node_id && <div><dt>ID máy chủ</dt><dd>{entry.node_id}</dd></div>}
                              {detailItems.map(([key, value]) => (
                                <div key={key}>
                                  <dt>{detailLabels[key] || key}</dt>
                                  <dd>
                                    {key === "cpu_percent" ||
                                    key === "threshold"
                                      ? `${value}%`
                                      : key === "last_seen"
                                        ? typeof value === "string"
                                          ? new Date(value).toLocaleString(
                                              "vi-VN",
                                            )
                                          : "Chưa nhận heartbeat"
                                        : value}
                                  </dd>
                                </div>
                              ))}
                              {detailItems.length === 0 && (
                                <div>
                                  <dd>Không có thông tin bổ sung.</dd>
                                </div>
                              )}
                            </dl>
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          )}
        </div>
        <div className="audit-pagination">
          <span>
            Trang <b>{filters.page}</b>
          </span>
          <div>
            <button
              className="button secondary"
              aria-label="Trang trước"
              disabled={loading || filters.page <= 1}
              onClick={() =>
                setFilters((previous) => ({
                  ...previous,
                  page: previous.page - 1,
                }))
              }
            >
              <ChevronLeft size={15} />
              Trước
            </button>
            <button
              className="button secondary"
              aria-label="Trang sau"
              disabled={loading || !result?.has_more}
              onClick={() =>
                setFilters((previous) => ({
                  ...previous,
                  page: previous.page + 1,
                }))
              }
            >
              Sau
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};
