import React, { useEffect, useState } from "react";
import {
  ChevronRight,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Menu,
  Server,
  Shield,
  X,
} from "lucide-react";
import { Brand } from "../components/Brand.js";
import { UserSession } from "../types/index.js";

export type ConsoleTab = "dashboard" | "fleet" | "audit";

interface ConsoleLayoutProps {
  currentUser: UserSession;
  activeTab: ConsoleTab;
  onSelectTab: (tab: ConsoleTab) => void;
  onLogout: () => Promise<void>;
  isDarkMode: boolean;
  themeButton: React.ReactNode;
  children: React.ReactNode;
  terminal: React.ReactNode;
}

export const ConsoleLayout: React.FC<ConsoleLayoutProps> = ({
  currentUser,
  activeTab,
  onSelectTab,
  onLogout,
  isDarkMode,
  themeButton,
  children,
  terminal,
}) => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

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

  const selectTab = (tab: ConsoleTab) => {
    onSelectTab(tab);
    setIsMobileMenuOpen(false);
    document
      .getElementById(tab === "fleet" ? "server-fleet" : "cluster-overview")
      ?.scrollIntoView({ behavior: "smooth" });
  };

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
              onClick={onLogout}
              title="Đăng xuất khỏi hệ thống"
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>
        <main id="cluster-overview" className="console-main">
          {children}
        </main>
        <footer className="console-footer">
          <span>
            ZT-ServerOps <b>/</b> Infrastructure monitoring
          </span>
          <span>React · WireGuard · PostgreSQL</span>
        </footer>
      </div>
      {terminal}
    </div>
  );
};
