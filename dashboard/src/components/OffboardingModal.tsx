import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  Info,
  Lock,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../services/api.js";
import { NodeItem, OffboardingOperation, OffboardingState, UserSession } from "../types/index.js";
import { formatDateTime } from "../utils/format.js";

interface OffboardingModalProps {
  node: NodeItem;
  currentUser?: UserSession | null;
  isOpen: boolean;
  onClose: () => void;
  onStatusChange?: (op: OffboardingOperation) => void;
}

const STATE_CONFIG: Record<
  OffboardingState,
  { label: string; badgeClass: string; desc: string; icon: typeof Clock }
> = {
  PENDING_PEER_REMOVAL: {
    label: "Đang thu hồi",
    badgeClass: "warning",
    desc: "Gateway đã thu hồi quyền truy cập và đang chờ tiến trình gỡ bỏ peer WireGuard hoàn tất.",
    icon: Clock,
  },
  PENDING_LOCAL_CLEANUP: {
    label: "Chờ gỡ tại Worker",
    badgeClass: "warning",
    desc: "Gateway đã thu hồi kết nối; chuyển tệp ủy quyền và chạy bộ gỡ bằng quyền quản trị trên Worker.",
    icon: RefreshCw,
  },
  NEEDS_REVIEW: {
    label: "Cần xử lý",
    badgeClass: "danger",
    desc: "Quá trình gỡ bỏ gặp lỗi hoặc cần quản trị viên kiểm tra thủ công.",
    icon: AlertTriangle,
  },
  COMPLETED: {
    label: "Hoàn tất",
    badgeClass: "success",
    desc: "Máy chủ đã được thu hồi và gỡ bỏ hoàn tất khỏi cụm.",
    icon: CheckCircle2,
  },
};

export const OffboardingModal: React.FC<OffboardingModalProps> = ({
  node,
  currentUser,
  isOpen,
  onClose,
  onStatusChange,
}) => {
  // Snapshot target tightly per open/node change to prevent stale selection mixup
  const targetId = node.id;
  const targetName = node.name;
  const targetIp = node.ip_address;
  const isEnrolled = node.is_enrolled !== false;

  const [confirmInput, setConfirmInput] = useState("");
  const [operation, setOperation] = useState<OffboardingOperation | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloadSuccessNotice, setDownloadSuccessNotice] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inflightRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeTargetIdRef = useRef(targetId);

  const isAdmin = currentUser?.role === "ADMIN";

  // Reset state whenever targetId changes
  useEffect(() => {
    activeTargetIdRef.current = targetId;
    setConfirmInput("");
    setOperation(null);
    setIsLoadingStatus(true);
    setLoadError(null);
    setActionError(null);
    setDownloadSuccessNotice(null);
  }, [targetId]);

  // Accessibility: Inert outside background & restore focus on unmount/close
  useEffect(() => {
    if (!isOpen) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const background = Array.from(document.querySelectorAll<HTMLElement>(".console-workspace, .sidebar"));
    const previousInert = background.map((element) => element.inert);
    background.forEach((element) => {
      element.inert = true;
    });
    document.body.style.overflow = "hidden";

    closeBtnRef.current?.focus();

    return () => {
      background.forEach((element, index) => {
        element.inert = previousInert[index];
      });
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, [isOpen]);

  // Status fetching & 3s polling with fail-closed error handling
  const fetchStatus = async (isInitial = false) => {
    if (inflightRef.current) return;
    const currentAbort = abortControllerRef.current;
    if (currentAbort?.signal.aborted) return;

    inflightRef.current = true;
    if (isInitial) {
      setIsLoadingStatus(true);
      setLoadError(null);
    }

    try {
      const op = await api.getOffboardingStatus(targetId, currentAbort?.signal);
      if (currentAbort?.signal.aborted || activeTargetIdRef.current !== targetId) return;
      setOperation(op);
      setLoadError(null);
      if (op && onStatusChange) onStatusChange(op);
    } catch (err: any) {
      if (currentAbort?.signal.aborted || activeTargetIdRef.current !== targetId) return;
      // Fail closed: surface network/server error; do not fall back to destructive form
      const msg = err.message || "Không thể tải trạng thái quy trình gỡ bỏ từ máy chủ.";
      if (isInitial || !operation) {
        setLoadError(msg);
      } else {
        setActionError(`Mất kết nối cập nhật tiến trình: ${msg}`);
      }
    } finally {
      inflightRef.current = false;
      if (activeTargetIdRef.current === targetId) {
        setIsLoadingStatus(false);
      }
    }
  };

  useEffect(() => {
    if (!isOpen) return;

    abortControllerRef.current = new AbortController();
    void fetchStatus(true);

    pollingRef.current = setInterval(() => {
      if (document.visibilityState === "visible") {
        void fetchStatus(false);
      }
    }, 3000);

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      abortControllerRef.current?.abort();
    };
  }, [isOpen, targetId]);

  // Initial focus containment after async status load resolves
  useEffect(() => {
    if (!isOpen || isLoadingStatus) return;

    // Status has resolved: set initial focus
    if (inputRef.current) {
      inputRef.current.focus();
    } else {
      const focusable = dialogRef.current?.querySelector<HTMLElement>(
        "button:not(:disabled), [tabindex]:not([tabindex='-1'])"
      );
      focusable?.focus();
    }
  }, [isOpen, isLoadingStatus, operation]);

  // Real keyboard Tab/Shift+Tab focus containment & Escape handling
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && !isSubmitting) {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === "Tab") {
      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusableElements = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);

      if (focusableElements.length === 0) {
        event.preventDefault();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (event.shiftKey) {
        if (document.activeElement === firstElement || !dialog.contains(document.activeElement)) {
          event.preventDefault();
          lastElement.focus();
        }
      } else {
        if (document.activeElement === lastElement || !dialog.contains(document.activeElement)) {
          event.preventDefault();
          firstElement.focus();
        }
      }
    }
  };

  if (!isOpen) return null;

  const handleStartOffboarding = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isAdmin || isSubmitting || confirmInput.trim() !== targetName) return;

    setIsSubmitting(true);
    setActionError(null);
    try {
      const op = await api.startOffboarding(targetId, confirmInput.trim());
      if (activeTargetIdRef.current !== targetId) return;
      setOperation(op);
      if (onStatusChange) onStatusChange(op);
    } catch (err: any) {
      if (activeTargetIdRef.current === targetId) {
        setActionError(err.message || "Không thể khởi tạo quy trình gỡ bỏ.");
      }
    } finally {
      if (activeTargetIdRef.current === targetId) {
        setIsSubmitting(false);
      }
    }
  };

  const handleDownloadAuthorization = async () => {
    if (!isAdmin || isDownloading || operation?.state === "COMPLETED") return;

    setIsDownloading(true);
    setActionError(null);
    setDownloadSuccessNotice(null);
    try {
      await api.downloadOffboardingAuthorization(targetId, `offboarding-${targetName}.json`);
      if (activeTargetIdRef.current === targetId) {
        setDownloadSuccessNotice("Đã tải tệp ủy quyền dọn dẹp thành công.");
      }
    } catch (err: any) {
      if (activeTargetIdRef.current === targetId) {
        setActionError(err.message || "Không thể tải tệp ủy quyền dọn dẹp.");
      }
    } finally {
      if (activeTargetIdRef.current === targetId) {
        setIsDownloading(false);
      }
    }
  };

  const stateDetails = operation ? STATE_CONFIG[operation.state] : null;
  const isStarted = Boolean(operation);

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-3 sm:p-6"
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="offboarding-modal-title"
        className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-2xl border border-neutral-800 bg-[#0c121e] shadow-2xl text-neutral-100 overflow-hidden"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 bg-neutral-900/80 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
              <Trash2 size={18} />
            </span>
            <div>
              <h2 id="offboarding-modal-title" className="text-base font-semibold leading-tight text-neutral-100">
                {isStarted ? "Tiến trình gỡ bỏ máy chủ" : "Gỡ bỏ máy chủ Worker"}
              </h2>
              <span className="text-xs text-neutral-400">
                {targetName} ({targetIp})
              </span>
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
            aria-label="Đóng hộp thoại"
            disabled={isSubmitting}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-sm">
          {/* Node identity summary */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3.5 space-y-1.5 text-xs text-neutral-300">
            <div className="flex justify-between">
              <span className="text-neutral-400">Tên máy chủ:</span>
              <strong className="font-mono text-neutral-200">{targetName}</strong>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">Địa chỉ VPN:</span>
              <span className="font-mono">{targetIp}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">Mã định danh (UUID):</span>
              <span className="font-mono text-neutral-400">{targetId}</span>
            </div>
            {operation?.operation_id && (
              <div className="flex justify-between">
                <span className="text-neutral-400">ID quy trình gỡ:</span>
                <span className="font-mono text-neutral-300">{operation.operation_id}</span>
              </div>
            )}
          </div>

          {actionError && (
            <div role="alert" className="notice danger flex items-start gap-2.5 p-3 rounded-lg bg-red-950/40 border border-red-500/30 text-red-300 text-xs">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{actionError}</span>
            </div>
          )}

          {downloadSuccessNotice && (
            <div role="status" className="notice flex items-start gap-2.5 p-3 rounded-lg bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 text-xs">
              <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
              <span>{downloadSuccessNotice}</span>
            </div>
          )}

          {/* Fail-closed: Initial load or network failure */}
          {loadError && !operation && (
            <div role="alert" className="p-4 rounded-lg bg-red-950/30 border border-red-500/40 space-y-3 text-xs text-red-300">
              <div className="flex items-start gap-2">
                <AlertCircle size={17} className="shrink-0 mt-0.5 text-red-400" />
                <div>
                  <strong className="block text-red-200">Không thể kiểm tra trạng thái gỡ bỏ</strong>
                  <span>{loadError}</span>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" className="button secondary" onClick={onClose}>
                  Đóng
                </button>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => fetchStatus(true)}
                  disabled={isLoadingStatus}
                >
                  <RefreshCw size={14} className={isLoadingStatus ? "animate-spin" : ""} />
                  Thử lại
                </button>
              </div>
            </div>
          )}

          {/* Legacy check: If node is not enrolled */}
          {!isEnrolled && !isStarted && !loadError && (
            <div role="alert" className="notice warning flex items-start gap-2.5 p-3.5 rounded-lg bg-amber-950/30 border border-amber-500/30 text-amber-300 text-xs">
              <AlertTriangle size={17} className="shrink-0 mt-0.5" />
              <div>
                <strong className="block font-semibold">Máy chủ legacy chưa đăng ký tự động</strong>
                <span>Máy chủ này chưa đăng ký tự động qua Gateway, không khả dụng để thực hiện quy trình gỡ tự động.</span>
              </div>
            </div>
          )}

          {/* Phase 1: Confirmation Form (Offboarding not yet started and no load error) */}
          {isEnrolled && !isStarted && !isLoadingStatus && !loadError && (
            <>
              {isAdmin ? (
                <form onSubmit={handleStartOffboarding} className="space-y-4">
                  <div className="rounded-lg border border-red-500/20 bg-red-950/20 p-3.5 text-xs text-red-300 space-y-1.5">
                    <div className="flex items-center gap-2 font-semibold text-red-200">
                      <ShieldAlert size={16} />
                      Cảnh báo thu hồi bảo mật
                    </div>
                    <p className="leading-relaxed">
                      Khi bắt đầu gỡ bỏ, Gateway thu hồi quyền truy cập ngay lập tức, chấm dứt các phiên kết nối SSH và chờ hoàn tất gỡ peer WireGuard.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="confirm-node-name-input" className="block text-xs font-medium text-neutral-300">
                      Nhập chính xác tên máy chủ <strong className="text-red-400 font-mono">{targetName}</strong> để xác nhận:
                    </label>
                    <input
                      ref={inputRef}
                      id="confirm-node-name-input"
                      type="text"
                      className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3.5 py-2.5 font-mono text-sm text-neutral-100 placeholder-neutral-500 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
                      placeholder={targetName}
                      value={confirmInput}
                      onChange={(e) => setConfirmInput(e.target.value)}
                      disabled={isSubmitting}
                      autoComplete="off"
                    />
                  </div>

                  <div className="flex justify-end gap-3 pt-2">
                    <button
                      type="button"
                      className="button secondary"
                      onClick={onClose}
                      disabled={isSubmitting}
                    >
                      Hủy bỏ
                    </button>
                    <button
                      type="submit"
                      className="button danger"
                      disabled={isSubmitting || confirmInput.trim() !== targetName}
                      aria-busy={isSubmitting}
                    >
                      {isSubmitting ? (
                        <>
                          <RefreshCw size={15} className="animate-spin" />
                          Đang thu hồi…
                        </>
                      ) : (
                        <>
                          <Trash2 size={15} />
                          Xác nhận gỡ Worker
                        </>
                      )}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 text-center text-xs text-neutral-400 space-y-2">
                  <Lock size={20} className="mx-auto text-neutral-500" />
                  <p>Tài khoản của bạn có vai trò Người xem (VIEWER). Chỉ quản trị viên (ADMIN) mới có quyền gỡ bỏ máy chủ.</p>
                </div>
              )}
            </>
          )}

          {/* Phase 2: Active or Completed Offboarding Progress */}
          {isStarted && operation && (
            <div className="space-y-4">
              {/* Status Header */}
              <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-neutral-400">Trạng thái hiện tại:</span>
                  <span className={`status-badge ${stateDetails?.badgeClass || "neutral"}`}>
                    <i />
                    {stateDetails?.label || operation.state}
                  </span>
                </div>
                <p className="text-xs text-neutral-300 leading-relaxed">{stateDetails?.desc}</p>
                {operation.peer_removed_at && (
                  <div className="text-[11px] text-neutral-400 pt-1">
                    Thời điểm thu hồi truy cập: {formatDateTime(operation.peer_removed_at)}
                  </div>
                )}
                {operation.completed_at && (
                  <div className="text-[11px] text-neutral-400">
                    Thời điểm hoàn tất: {formatDateTime(operation.completed_at)}
                  </div>
                )}
              </div>

              {/* Actionable Error if any */}
              {operation.last_error && (
                <div role="alert" className="notice danger flex items-start gap-2.5 p-3 rounded-lg bg-red-950/40 border border-red-500/30 text-red-300 text-xs">
                  <AlertCircle size={16} className="shrink-0 mt-0.5" />
                  <div>
                    <strong className="block font-semibold">Lỗi gần nhất được ghi nhận:</strong>
                    <span>{operation.last_error}</span>
                  </div>
                </div>
              )}

              {/* Single useful instruction */}
              <div className="rounded-lg border border-cyan-500/20 bg-cyan-950/20 p-3.5 flex items-start gap-3 text-xs text-cyan-200">
                <Info size={17} className="shrink-0 mt-0.5 text-cyan-400" />
                <div className="leading-relaxed">
                  <strong>Hướng dẫn gỡ bỏ:</strong> Chuyển tệp ủy quyền và chạy bộ gỡ bằng quyền quản trị trên Worker.
                </div>
              </div>

              {/* Authorization Bundle Download Section */}
              <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-neutral-200">Tệp ủy quyền dọn dẹp (Capability):</span>
                  {operation.state === "COMPLETED" ? (
                    <span className="text-xs text-neutral-400">Đã hoàn tất</span>
                  ) : operation.has_cleanup_token ? (
                    <span className="text-xs text-emerald-400">Đã cấp mã</span>
                  ) : (
                    <span className="text-xs text-amber-400">Chưa tải</span>
                  )}
                </div>

                {isAdmin ? (
                  operation.state !== "COMPLETED" ? (
                    <div className="space-y-2">
                      <button
                        type="button"
                        className="button primary w-full justify-center"
                        onClick={handleDownloadAuthorization}
                        disabled={isDownloading}
                      >
                        {isDownloading ? (
                          <>
                            <RefreshCw size={15} className="animate-spin" />
                            Đang tải mã ủy quyền…
                          </>
                        ) : (
                          <>
                            <Download size={15} />
                            Tải mã ủy quyền dọn dẹp
                          </>
                        )}
                      </button>
                      <p className="text-[11px] text-neutral-400 text-center">
                        Tải lại sẽ thay mã cũ.
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-neutral-400 text-center">
                      Quy trình gỡ bỏ đã hoàn tất, không thể cấp mã dọn dẹp mới.
                    </p>
                  )
                ) : (
                  <p className="text-xs text-neutral-400 text-center">
                    Chỉ quản trị viên (ADMIN) mới có quyền tải tệp ủy quyền dọn dẹp.
                  </p>
                )}
              </div>

              <div className="flex justify-end pt-2">
                <button type="button" className="button secondary" onClick={onClose}>
                  Đóng
                </button>
              </div>
            </div>
          )}

          {isLoadingStatus && !operation && !loadError && (
            <div className="py-8 text-center text-xs text-neutral-400 space-y-2">
              <RefreshCw size={20} className="animate-spin mx-auto text-neutral-500" />
              <span>Đang kiểm tra trạng thái gỡ bỏ máy chủ…</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(modalContent, document.body) : modalContent;
};