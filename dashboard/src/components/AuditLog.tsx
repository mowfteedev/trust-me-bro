import React, { useEffect, useRef, useState } from "react";
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
  Bell,
  Trash2,
  Check,
  Info,
} from "lucide-react";
import { api, PurgePreview } from "../services/api.js";
import { AuditLogPage, UserSession } from "../types/index.js";
import { formatTime } from "../utils/format.js";

const events = [
  { value: 'CPU_RECOVERED', label: 'CPU trở lại bình thường', icon: Check, tone: 'auth' },
  { value: 'USER_CREATED', label: 'Tạo tài khoản', icon: Shield, tone: 'auth' },
  { value: 'USER_UPDATED', label: 'Đổi quyền hoặc khóa tài khoản', icon: Shield, tone: 'warning' },
  { value: 'USER_PASSWORD_RESET', label: 'Đặt lại mật khẩu', icon: Shield, tone: 'warning' },
  { value: 'PASSWORD_CHANGED', label: 'Đổi mật khẩu', icon: Shield, tone: 'auth' },
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
  {
    value: "TELEGRAM_TEST",
    label: "Cảnh báo thử Telegram",
    icon: Bell,
    tone: "auth",
  },
  {
    value: "AUDIT_PURGED",
    label: "Dọn dẹp nhật ký",
    icon: Trash2,
    tone: "warning",
  },
];
const detailLabels: Record<string, string> = {
  username: 'Tài khoản được cập nhật',
  is_active: 'Đang hoạt động',
  scope: 'Phạm vi đăng xuất',
  attempted_username: "Tài khoản thử đăng nhập",
  session_id: "ID phiên SSH",
  reason: "Lý do",
  target_ip: "IP đích",
  message: "Nội dung",
  cpu_percent: "CPU đo được",
  threshold: "Ngưỡng cảnh báo",
  ip: "IP máy chủ",
  last_seen: "Heartbeat lần cuối",
  dry_run: "Chế độ giả lập",
  result: "Kết quả gửi",
  role: "Vai trò",
  deleted_count: "Số bản ghi đã xóa",
  cutoff_time: "Mốc thời gian xóa",
  retention: "Khoảng lưu trữ",
};

interface AuditLogProps {
  initialFilters?: { action?: string; q?: string };
  onOpenNode?: (id: string, name: string | null) => void;
  currentUser?: UserSession | null;
}

export const AuditLog: React.FC<AuditLogProps> = ({ initialFilters, onOpenNode, currentUser }) => {
  const isAdmin = (currentUser?.role ?? api.getCurrentUser()?.role) === "ADMIN";
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
  const [purgeDropdownOpen, setPurgeDropdownOpen] = useState(false);
  const [purgeRetention, setPurgeRetention] = useState<"1d" | "7d" | "30d">("7d");
  const [purging, setPurging] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<PurgePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [purgeFeedback, setPurgeFeedback] = useState<{ type: "success" | "info" | "error"; message: string } | null>(null);
  const purgeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!purgeDropdownOpen || !isAdmin) {
      setPreviewData(null);
      setPreviewError(null);
      return;
    }
    let isCurrent = true;
    setPreviewLoading(true);
    setPreviewError(null);
    api
      .getPurgePreview(purgeRetention)
      .then((data) => {
        if (!isCurrent) return;
        setPreviewData(data);
        setPreviewLoading(false);
      })
      .catch((err: Error) => {
        if (!isCurrent) return;
        setPreviewError(err.message || "Không thể tải dữ liệu xem trước.");
        setPreviewLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, [purgeDropdownOpen, purgeRetention, isAdmin]);

  useEffect(() => {
    if (!purgeDropdownOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (purgeMenuRef.current && !purgeMenuRef.current.contains(e.target as Node)) {
        setPurgeDropdownOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPurgeDropdownOpen(false);
    };
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [purgeDropdownOpen]);

  useEffect(() => {
    if (!purgeFeedback) return;
    const timer = setTimeout(() => setPurgeFeedback(null), 6000);
    return () => clearTimeout(timer);
  }, [purgeFeedback]);

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

  const formatCutoffTime = (isoString?: string) => {
    if (!isoString) return "";
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return isoString;
      return d.toLocaleString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour12: false,
      });
    } catch {
      return isoString;
    }
  };

  const handlePurge = async () => {
    if (purging || !previewData?.can_purge) return;
    setPurging(true);
    setPurgeFeedback(null);
    try {
      const res = await api.purgeAuditLogs(purgeRetention);
      if (res.deleted_count > 0) {
        setPurgeFeedback({ type: "success", message: res.message });
      } else {
        setPurgeFeedback({ type: "info", message: res.message });
      }
      setPurgeDropdownOpen(false);
      refresh();
    } catch (err: any) {
      setPurgeFeedback({
        type: "error",
        message: err.message || "Không thể dọn dẹp nhật ký hoạt động.",
      });
    } finally {
      setPurging(false);
    }
  };

  return (
    <div className="overview audit-page">
      <div className="page-heading">
        <div>
          <h1>Nhật ký hoạt động</h1>
        </div>
        <div className="page-heading-actions" ref={purgeMenuRef}>
          {isAdmin && (
            <div className="audit-purge-container">
              <button
                type="button"
                className="button secondary audit-purge-btn"
                aria-label="Dọn nhật ký cũ"
                aria-expanded={purgeDropdownOpen}
                aria-haspopup="dialog"
                onClick={() => setPurgeDropdownOpen((prev) => !prev)}
                disabled={loading || purging}
                title="Dọn dẹp nhật ký hoạt động cũ (Giữ 1 ngày, 7 ngày hoặc 30 ngày gần nhất)"
              >
                <Trash2 size={15} />
                <span>Dọn nhật ký cũ</span>
                <ChevronDown size={14} className={purgeDropdownOpen ? "rotate-180" : ""} />
              </button>
              {purgeDropdownOpen && (
                <div className="audit-purge-popover" role="dialog" aria-label="Dọn nhật ký cũ">
                  <div className="audit-purge-popover-title">
                    <Trash2 size={16} />
                    <span>Dọn nhật ký cũ</span>
                  </div>
                  <p className="audit-purge-popover-desc">
                    Áp dụng cho toàn bộ nhật ký hệ thống (không phụ thuộc bộ lọc hay trang đang xem). Các bản ghi mới hơn mốc đã chọn sẽ được giữ nguyên.
                  </p>
                  <div className="audit-purge-options">
                    <button
                      type="button"
                      className={`audit-purge-option-btn ${purgeRetention === "7d" ? "active" : ""}`}
                      onClick={() => setPurgeRetention("7d")}
                      disabled={purging || previewLoading}
                    >
                      <span className="option-title">Giữ 7 ngày gần nhất (Mặc định)</span>
                      <span className="option-desc">Chỉ dọn các sự kiện cũ hơn 7 ngày trước</span>
                    </button>
                    <button
                      type="button"
                      className={`audit-purge-option-btn ${purgeRetention === "1d" ? "active" : ""}`}
                      onClick={() => setPurgeRetention("1d")}
                      disabled={purging || previewLoading}
                    >
                      <span className="option-title">Giữ 1 ngày gần nhất</span>
                      <span className="option-desc">Chỉ dọn các sự kiện cũ hơn 24 giờ trước</span>
                    </button>
                    <button
                      type="button"
                      className={`audit-purge-option-btn ${purgeRetention === "30d" ? "active" : ""}`}
                      onClick={() => setPurgeRetention("30d")}
                      disabled={purging || previewLoading}
                    >
                      <span className="option-title">Giữ 30 ngày gần nhất</span>
                      <span className="option-desc">Chỉ dọn các sự kiện cũ hơn 30 ngày trước</span>
                    </button>
                  </div>

                  <div className="audit-purge-preview-box">
                    <div className="preview-header">
                      <span className="preview-label">Xem trước khi dọn:</span>
                      {previewLoading && (
                        <span className="preview-loading">
                          <RefreshCw size={12} className="animate-spin" /> Đang kiểm tra...
                        </span>
                      )}
                    </div>
                    {previewError ? (
                      <div className="preview-error">{previewError}</div>
                    ) : previewData ? (
                      <div className="preview-content">
                        <div className="preview-row cutoff-row">
                          <span className="row-label">Mốc cắt:</span>
                          <span className="row-value">{formatCutoffTime(previewData.cutoff_time)}</span>
                        </div>
                        {previewData.records_to_delete === 0 ? (
                          <div className="preview-empty-notice">
                            <Info size={14} />
                            <span>Không có nhật ký cần dọn (tất cả {previewData.total_records} bản ghi đều mới hơn mốc này).</span>
                          </div>
                        ) : (
                          <div className="preview-counts-grid">
                            <div className="count-item delete-count">
                              <span className="count-num">{previewData.records_to_delete}</span>
                              <span className="count-desc">Dự kiến xóa</span>
                            </div>
                            <div className="count-item keep-count">
                              <span className="count-num">{previewData.records_to_keep}</span>
                              <span className="count-desc">Sẽ giữ lại</span>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>

                  <div className="audit-purge-actions">
                    <button
                      type="button"
                      className="button secondary sm"
                      onClick={() => setPurgeDropdownOpen(false)}
                      disabled={purging}
                    >
                      Hủy
                    </button>
                    <button
                      type="button"
                      className="button danger sm"
                      onClick={handlePurge}
                      disabled={purging || previewLoading || !previewData?.can_purge}
                      title={!previewData?.can_purge ? "Không có bản ghi nào cũ hơn mốc này để dọn" : "Xác nhận dọn dẹp các bản ghi cũ"}
                    >
                      {purging ? (
                        <>
                          <RefreshCw size={13} className="animate-spin" />
                          <span>Đang dọn dẹp...</span>
                        </>
                      ) : (
                        <>
                          <Trash2 size={13} />
                          <span>Xác nhận dọn dẹp</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            className="button secondary"
            aria-label="Làm mới nhật ký"
            onClick={refresh}
            disabled={loading || purging}
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            <span>Làm mới</span>
          </button>
        </div>
      </div>
      {purgeFeedback && (
        <div className={`audit-feedback-toast ${purgeFeedback.type}`}>
          {purgeFeedback.type === "success" ? (
            <Check size={16} />
          ) : purgeFeedback.type === "info" ? (
            <Info size={16} />
          ) : (
            <AlertCircle size={16} />
          )}
          <span>{purgeFeedback.message}</span>
          <button
            type="button"
            className="icon-button sm"
            onClick={() => setPurgeFeedback(null)}
            aria-label="Đóng thông báo"
          >
            <X size={14} />
          </button>
        </div>
      )}
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
                                        : key === 'scope'
                                          ? value === 'current' ? 'Thiết bị hiện tại' : 'Tất cả thiết bị'
                                          : typeof value === 'boolean' ? value ? 'Có' : 'Không' : value}
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
