import React, { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Eye,
  EyeOff,
  LockKeyhole,
  ShieldAlert,
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
        <section className="login-form-panel" aria-labelledby="login-title">
          <div className="login-form-heading">
            <span className="login-form-icon">
              <LockKeyhole size={21} />
            </span>
            <div>
              <h1 id="login-title">Đăng nhập</h1>
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
              />
            </div>
            <label htmlFor="password">Mật khẩu</label>
            <div className="form-input">
              <LockKeyhole size={17} />
              <input
                id="password"
                autoComplete="current-password"
                type={showPassword ? "text" : "password"}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
              {isSubmitting ? "Đang đăng nhập..." : "Đăng nhập"}
              <ArrowRight size={17} />
            </button>
          </form>
        </section>
      </main>
    </div>
  );
};
