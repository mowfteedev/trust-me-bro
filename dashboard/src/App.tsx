import React, { useState, useEffect } from 'react';
import { api } from './services/api.js';
import { UserSession, NodeItem } from './types/index.js';
import { ClusterOverview } from './components/ClusterOverview.js';
import { TerminalModal } from './components/TerminalModal.js';
import { Shield, ShieldAlert, LogOut, Terminal, Lock, User, Radio, Cpu, ArrowRight } from 'lucide-react';

/**
 * ==============================================================================
 * KHUNG ỨNG DỤNG BẢNG ĐIỀU KHIỂN CHÍNH (App.tsx)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: frontend (chủ trì), designer, tech-lead
 * ==============================================================================
 */

export const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<UserSession | null>(api.getCurrentUser());
  const [selectedTerminalNode, setSelectedTerminalNode] = useState<NodeItem | null>(null);

  // Form đăng nhập
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setIsSubmitting(true);

    try {
      const user = await api.login(username, password);
      setCurrentUser(user);
    } catch (err: any) {
      setLoginError(err.message || 'Tên đăng nhập hoặc mật khẩu không chính xác');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = () => {
    api.clearSession();
    setCurrentUser(null);
    setSelectedTerminalNode(null);
  };

  // --------------------------------------------------------------------------
  // MÀN HÌNH ĐĂNG NHẬP (KHI CHƯA XÁC THỰC DANH TÍNH)
  // --------------------------------------------------------------------------
  if (!currentUser) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#090d16] px-4 py-12 relative overflow-hidden">
        {/* Nền hiệu ứng lưới mạng không gian ngầm */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#1f29370a_1px,transparent_1px),linear-gradient(to_bottom,#1f29370a_1px,transparent_1px)] bg-[size:24px_24px]" />
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative w-full max-w-md rounded-3xl border border-neutral-800 bg-neutral-900/80 p-8 shadow-2xl backdrop-blur-xl">
          {/* Logo & Tiêu đề */}
          <div className="text-center">
            <div className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-inner">
              <Shield className="h-7 w-7" />
            </div>
            <h1 className="mt-4 text-2xl font-bold tracking-tight text-neutral-100">
              ZT-ServerOps
            </h1>
            <p className="mt-1 text-xs font-mono text-neutral-400">
              Control Plane Gateway | Zero-Trust Infrastructure
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleLogin} className="mt-8 space-y-4">
            {loginError && (
              <div className="rounded-xl border border-red-500/30 bg-red-950/30 p-3 text-xs text-red-400 font-mono flex items-center space-x-2">
                <ShieldAlert className="h-4 w-4 shrink-0" />
                <span>{loginError}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1.5">Tên tài khoản</label>
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin hoặc viewer"
                  className="w-full rounded-xl border border-neutral-800 bg-neutral-950 pl-10 pr-4 py-2.5 text-sm text-neutral-100 placeholder-neutral-600 focus:border-cyan-500 focus:outline-none transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1.5">Mật khẩu xác thực</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full rounded-xl border border-neutral-800 bg-neutral-950 pl-10 pr-4 py-2.5 text-sm text-neutral-100 placeholder-neutral-600 focus:border-cyan-500 focus:outline-none transition-colors"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-6 w-full min-h-[44px] inline-flex items-center justify-center space-x-2 rounded-xl bg-cyan-500 text-sm font-semibold text-neutral-950 hover:bg-cyan-400 disabled:opacity-50 transition-all shadow-lg shadow-cyan-500/20"
            >
              <span>{isSubmitting ? 'Đang xác thực...' : 'Đăng nhập vào Hệ thống'}</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>

          <div className="mt-6 border-t border-neutral-800 pt-4 text-center">
            <span className="text-[11px] font-mono text-neutral-500">
              Mã hóa TLS 1.3 • Chữ ký HMAC-SHA256 • Phân vùng 3NF
            </span>
          </div>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // GIAO DIỆN CHÍNH DASHBOARD (KHI ĐÃ ĐĂNG NHẬP)
  // --------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-[#090d16] text-neutral-100 flex flex-col">
      {/* 1. Thanh điều hướng đầu trang (Navbar) */}
      <header className="sticky top-0 z-40 border-b border-neutral-800/80 bg-[#090d16]/80 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="rounded-xl bg-cyan-500/10 p-2 text-cyan-400 border border-cyan-500/20">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <span className="font-bold text-base tracking-tight text-neutral-100">ZT-ServerOps</span>
              <span className="hidden sm:inline-block ml-2 text-xs font-mono px-2 py-0.5 rounded bg-neutral-800 text-neutral-400">
                Web Console v1.0
              </span>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            {/* Thông tin tài khoản & Role */}
            <div className="hidden sm:flex items-center space-x-2 text-xs font-mono">
              <span className="text-neutral-400">{currentUser.username}</span>
              <span className={`px-2 py-0.5 rounded font-semibold ${
                currentUser.role === 'ADMIN'
                  ? 'bg-purple-500/10 text-purple-400 border border-purple-500/30'
                  : 'bg-neutral-800 text-neutral-300'
              }`}>
                {currentUser.role}
              </span>
            </div>

            {/* Nút Đăng xuất (Touch Target >= 44x44px) */}
            <button
              onClick={handleLogout}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400 transition-colors"
              title="Đăng xuất"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      {/* 2. Nội dung chính (Cluster Overview) */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <ClusterOverview onOpenTerminal={(node) => setSelectedTerminalNode(node)} />
      </main>

      {/* 3. Footer */}
      <footer className="border-t border-neutral-800/60 py-6 text-center text-xs font-mono text-neutral-500">
        <p>ZT-ServerOps Control Plane • Do-an-co-so-nganh (HaUI, TS. Nguyễn Đắc Hải, Nhóm 9)</p>
      </footer>

      {/* 4. Cửa sổ dòng lệnh Terminal Modal */}
      {selectedTerminalNode && (
        <TerminalModal
          node={selectedTerminalNode}
          isOpen={!!selectedTerminalNode}
          onClose={() => setSelectedTerminalNode(null)}
        />
      )}
    </div>
  );
};
