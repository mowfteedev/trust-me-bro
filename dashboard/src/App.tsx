import React, { useEffect, useState } from "react";
import { api } from "./services/api.js";
import { UserSession, NodeItem } from "./types/index.js";
import { ClusterOverview } from "./components/ClusterOverview.js";
import { AuditLog } from "./components/AuditLog.js";
import { TerminalModal } from "./components/TerminalModal.js";
import {
  Shield,
  ShieldAlert,
  LogOut,
  LockKeyhole,
  UserRound,
  ArrowRight,
  LayoutDashboard,
  Server,
  Network,
  Menu,
  X,
  Sun,
  Moon,
  ChevronRight,
  AlertTriangle,
  Activity,
  Terminal,
  Eye,
  EyeOff,
  ClipboardList,
} from "lucide-react";

const Brand = () => (
  <div className="brand">
    <span className="brand-symbol">
      <Shield size={23} strokeWidth={1.7} />
    </span>
    <div>
      <strong>
        ZT<span> / </span>ServerOps
      </strong>
      <small>INFRASTRUCTURE CONSOLE</small>
    </div>
  </div>
);

export const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<UserSession | null>(
    api.getCurrentUser(),
  );
  const [selectedTerminalNode, setSelectedTerminalNode] =
    useState<NodeItem | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"dashboard" | "fleet" | "audit">(
    "dashboard",
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [logoutWarning, setLogoutWarning] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const onExpired = () => {
      setCurrentUser(null);
      setSelectedTerminalNode(null);
      setLoginError("Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.");
    };
    window.addEventListener("zt-session-expired", onExpired);
    return () => window.removeEventListener("zt-session-expired", onExpired);
  }, []);

  useEffect(() => {
    if (!isMobileMenuOpen) return;
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    const buttons = Array.from(
      sidebar?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
    const mobile = window.matchMedia("(max-width: 860px)");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onViewportChange = () => {
      if (!mobile.matches) setIsMobileMenuOpen(false);
    };
    mobile.addEventListener("change", onViewportChange);
    buttons[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!mobile.matches) return;
      if (event.key === "Escape") setIsMobileMenuOpen(false);
      if (event.key === "Tab") {
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      mobile.removeEventListener("change", onViewportChange);
      document.body.style.overflow = previousOverflow;
      document
        .querySelector<HTMLButtonElement>(".menu-trigger")
        ?.focus({ preventScroll: true });
    };
  }, [isMobileMenuOpen]);

  const selectTab = (tab: "dashboard" | "fleet" | "audit") => {
    setActiveTab(tab);
    setIsMobileMenuOpen(false);
    document.getElementById(tab === "fleet" ? "server-fleet" : "cluster-overview")?.scrollIntoView({ behavior: "smooth" });
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setLogoutWarning(null);
    setIsSubmitting(true);
    try {
      const user = await api.login(username, password);
      setCurrentUser(user);
      setPassword("");
      setShowPassword(false);
      setActiveTab("dashboard");
    } catch (err: any) {
      setLoginError(
        err.message || "Tên đăng nhập hoặc mật khẩu không chính xác",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      const res = await api.logout();
      setLogoutWarning(
        res.serverRevoked
          ? null
          : "Đã xóa phiên trên trình duyệt. Gateway chưa xác nhận thu hồi phiên do lỗi kết nối hoặc máy chủ. Token có thể còn hiệu lực đến khi hết hạn.",
      );
    } catch {
      setLogoutWarning(
        "Không thể kết nối đến Gateway. Phiên trên trình duyệt đã được xóa; máy chủ chưa xác nhận thu hồi phiên.",
      );
    }
    setCurrentUser(null);
    setSelectedTerminalNode(null);
    setIsMobileMenuOpen(false);
  };

  const themeButton = (
    <button
      className="icon-button"
      onClick={() => setIsDarkMode(!isDarkMode)}
      title={
        isDarkMode ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối"
      }
    >
      {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );

  if (!currentUser) {
    return (
      <div className={`ops-app login-page ${isDarkMode ? "dark" : ""}`}>
        <header className="login-top">
          <Brand />
          {themeButton}
        </header>
        <main className="login-layout">
          <section className="login-story">
            <span className="eyebrow">
              <span className="accent-dash" /> ZERO TRUST. CLEAR VISIBILITY.
            </span>
            <h1>
              Mọi máy chủ.
              <br />
              <span>Trong tầm kiểm soát.</span>
            </h1>
            <p>
              Một góc nhìn rõ ràng về hạ tầng của bạn.
              <br />
              Giám sát tài nguyên, kết nối và truy cập SSH từ một nơi.
            </p>
            <div className="network-illustration" aria-hidden="true">
              <div className="network-label">
                <Network size={14} /> MÔ HÌNH KẾT NỐI
              </div>
              <div className="network-flow">
                <div className="network-device">
                  <Shield size={26} />
                  <strong>Gateway</strong>
                  <small>Access control</small>
                </div>
                <div className="network-link">
                  <span>WireGuard</span>
                  <i />
                  <small>VPN M2M</small>
                </div>
                <div className="network-device">
                  <Server size={26} />
                  <strong>Worker</strong>
                  <small>Mini-Agent · SSH</small>
                </div>
              </div>
              <div className="network-caption">
                <LockKeyhole size={13} /> Truy cập qua VPN, phân quyền tại
                Gateway
              </div>
            </div>
            <div className="login-features">
              <span>
                <Activity size={16} /> Giám sát tài nguyên
              </span>
              <span>
                <Shield size={16} /> Admin / Viewer
              </span>
              <span>
                <Terminal size={16} /> Web SSH
              </span>
            </div>
          </section>
          <section className="login-form-panel" aria-labelledby="login-title">
            <div className="login-form-heading">
              <span className="login-form-icon">
                <LockKeyhole size={21} />
              </span>
              <div>
                <h2 id="login-title">Đăng nhập</h2>
                <p>Truy cập bảng điều khiển máy chủ.</p>
              </div>
            </div>
            <form onSubmit={handleLogin}>
              {logoutWarning && (
                <div className="notice warning" role="status">
                  <AlertTriangle size={17} />
                  <span>{logoutWarning}</span>
                </div>
              )}
              {loginError && (
                <div className="notice danger" role="alert">
                  <ShieldAlert size={17} />
                  <span>{loginError}</span>
                </div>
              )}
              <label htmlFor="username">Tên tài khoản</label>
              <div className="form-input">
                <UserRound size={17} />
                <input
                  id="username"
                  autoComplete="username"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Nhập tên tài khoản"
                />
              </div>
              <label htmlFor="password">Mật khẩu xác thực</label>
              <div className="form-input">
                <LockKeyhole size={17} />
                <input
                  id="password"
                  autoComplete="current-password"
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Nhập mật khẩu"
                />
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              <button
                type="submit"
                className="button primary login-submit"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Đang xác thực..." : "Đăng nhập vào Hệ thống"}
                <ArrowRight size={17} />
              </button>
            </form>
            <div className="login-form-note">
              <Shield size={15} />
              <span>
                Tài khoản được cấp bởi quản trị viên.
              </span>
            </div>
          </section>
        </main>
        <footer className="login-bottom">
          <span>
            ZT-ServerOps <b> / </b> Security & monitoring
          </span>
          <span>WireGuard · SSH Ed25519</span>
        </footer>
      </div>
    );
  }

  return (
    <div className={`ops-app console-layout ${isDarkMode ? "dark" : ""}`}>
      {isMobileMenuOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="Đóng menu"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}
      <aside
        className={`sidebar ${isMobileMenuOpen ? "is-open" : ""}`}
        aria-label="Điều hướng chính"
        role={isMobileMenuOpen ? "dialog" : undefined}
        aria-modal={isMobileMenuOpen || undefined}
      >
        <div className="sidebar-brand">
          <Brand />
          <button
            className="icon-button mobile-only sidebar-close"
            aria-label="Đóng menu điều hướng"
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <X size={20} />
          </button>
        </div>
        <div className="workspace-label">
          <span className="workspace-avatar">ZT</span>
          <div>
            <strong>Server workspace</strong>
            <small>Giám sát & điều khiển</small>
          </div>
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav>
          <button
            className={`nav-item ${activeTab === "dashboard" ? "active" : ""}`}
            aria-current={activeTab === "dashboard" ? "page" : undefined}
            onClick={() => selectTab("dashboard")}
          >
            <LayoutDashboard size={18} />
            <span>Tổng quan</span>
            <ChevronRight size={14} />
          </button>
          <button
            className={`nav-item ${activeTab === "fleet" ? "active" : ""}`}
            aria-current={activeTab === "fleet" ? "page" : undefined}
            onClick={() => selectTab("fleet")}
          >
            <Server size={18} />
            <span>Máy chủ</span>
            <ChevronRight size={14} />
          </button>
          {currentUser.role === "ADMIN" && (
            <button
              className={`nav-item ${activeTab === "audit" ? "active" : ""}`}
              aria-current={activeTab === "audit" ? "page" : undefined}
              onClick={() => selectTab("audit")}
            >
              <ClipboardList size={18} />
              <span>Nhật ký hoạt động</span>
              <ChevronRight size={14} />
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="access-note">
            <span className="access-note-icon">
              <Shield size={20} />
            </span>
            <strong>Truy cập có kiểm soát</strong>
            <p>
              Kết nối qua WireGuard.
              <br />
              Quyền SSH được kiểm tra tại Gateway.
            </p>
            <span className="protocol-label">
              VPN M2M <i /> SSH ED25519
            </span>
          </div>
          <div className="sidebar-foot">
            <span className="brand-mini">ZT</span>
            <span>
              Đồ án cơ sở ngành
              <br />
              <strong>An ninh mạng · Nhóm 9</strong>
            </span>
          </div>
        </div>
      </aside>
      <div className="console-workspace">
        <header className="topbar">
          <div className="topbar-path">
            <button
              className="icon-button mobile-only menu-trigger"
              title="Mở menu điều hướng"
              aria-expanded={isMobileMenuOpen}
              onClick={() => setIsMobileMenuOpen(true)}
            >
              <Menu size={21} />
            </button>
            <span className="desktop-label">Workspace</span>
            <ChevronRight size={13} className="desktop-label" />
            <strong>
              {activeTab === "audit"
                ? "Nhật ký hoạt động"
                : activeTab === "fleet"
                  ? "Máy chủ"
                  : "Tổng quan"}
            </strong>
          </div>
          <div className="topbar-actions">
            {themeButton}
            <span className="topbar-divider" />
            <div className="user-profile">
              <span className="user-avatar">
                {currentUser.username.slice(0, 2).toUpperCase()}
              </span>
              <div>
                <strong>{currentUser.username}</strong>
                <span>
                  {currentUser.role === "ADMIN"
                    ? "Administrator"
                    : "Viewer · Chỉ đọc"}
                </span>
              </div>
            </div>
            <button
              className="icon-button logout-button"
              onClick={handleLogout}
              title="Đăng xuất khỏi hệ thống"
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>
        <main id="cluster-overview" className="console-main">
          {activeTab === "audit" && currentUser.role === "ADMIN" ? (
            <AuditLog />
          ) : (
            <ClusterOverview
              currentUser={currentUser}
              onOpenTerminal={setSelectedTerminalNode}
              focusSection={activeTab === "fleet" ? "fleet" : "dashboard"}
            />
          )}
        </main>
        <footer className="console-footer">
          <span>
            ZT-ServerOps <b>/</b> Infrastructure monitoring
          </span>
          <span>React · WireGuard · PostgreSQL</span>
        </footer>
      </div>
      {selectedTerminalNode && (
        <TerminalModal
          node={selectedTerminalNode}
          isOpen
          onClose={() => setSelectedTerminalNode(null)}
        />
      )}
    </div>
  );
};
