import React, { useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Eye,
  EyeOff,
  LockKeyhole,
  Network,
  Server,
  Shield,
  ShieldAlert,
  Terminal,
  UserRound,
} from "lucide-react";
import { Brand } from "../components/Brand.js";

interface LoginPageProps {
  isDarkMode: boolean;
  themeButton: React.ReactNode;
  username: string;
  onUsernameChange: (username: string) => void;
  loginError: string | null;
  logoutWarning: string | null;
  isSubmitting: boolean;
  onLogin: (password: string) => Promise<boolean>;
}

export const LoginPage: React.FC<LoginPageProps> = ({
  isDarkMode,
  themeButton,
  username,
  onUsernameChange,
  loginError,
  logoutWarning,
  isSubmitting,
  onLogin,
}) => {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await onLogin(password)) {
      setPassword("");
      setShowPassword(false);
    }
  };

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
                onChange={(e) => onUsernameChange(e.target.value)}
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
};
