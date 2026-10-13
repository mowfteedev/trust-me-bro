import React, { useState } from 'react';
import { api } from './services/api.js';
import { UserSession, NodeItem } from './types/index.js';
import { ClusterOverview } from './components/ClusterOverview.js';
import { TerminalModal } from './components/TerminalModal.js';
import {
  Shield,
  ShieldAlert,
  LogOut,
  Lock,
  User,
  ArrowRight,
  LayoutDashboard,
  Server,
  Network,
  FileText,
  Menu,
  X,
  Sun,
  Moon,
  CheckCircle2,
  ChevronRight,
  Layers,
  Radio,
  AlertTriangle
} from 'lucide-react';

/**
 * ==============================================================================
 * KHUNG ỨNG DỤNG BẢNG ĐIỀU KHIỂN CHÍNH (App.tsx)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phong cách: DirectAdmin Evolution Modern (Light & Dark Responsive)
 * Phụ trách: frontend (chủ trì), designer, tech-lead
 * ==============================================================================
 */

export const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<UserSession | null>(api.getCurrentUser());
  const [selectedTerminalNode, setSelectedTerminalNode] = useState<NodeItem | null>(null);

  // Chế độ Theme (Mặc định Light Mode phong cách DirectAdmin Evolution)
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'fleet' | 'mesh' | 'audit'>('dashboard');

  // Form đăng nhập
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [logoutWarning, setLogoutWarning] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setLogoutWarning(null);
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

  const handleLogout = async () => {
    try {
      const res = await api.logout();
      if (!res.serverRevoked) {
        console.warn('⚠️ [LOGOUT WARNING] Máy chủ chưa xác nhận thu hồi phiên do sự cố mạng hoặc 503.');
        setLogoutWarning('Máy chủ ngoại tuyến hoặc trả về lỗi 503. Bạn đã được đăng xuất an toàn trên trình duyệt, nhưng phiên làm việc trên máy chủ chưa thể thu hồi từ xa.');
      } else {
        setLogoutWarning(null);
      }
    } catch {
      setLogoutWarning('Không thể kết nối đến máy chủ Gateway. Bạn đã được đăng xuất an toàn trên trình duyệt.');
    }
    setCurrentUser(null);
    setSelectedTerminalNode(null);
    setIsMobileMenuOpen(false);
  };

  // --------------------------------------------------------------------------
  // MÀN HÌNH ĐĂNG NHẬP (KHI CHƯA XÁC THỰC DANH TÍNH)
  // --------------------------------------------------------------------------
  if (!currentUser) {
    return (
      <div className={`flex min-h-screen items-center justify-center px-4 py-12 relative overflow-hidden transition-colors ${
        isDarkMode ? 'bg-[#090d16]' : 'bg-[#f8fafc]'
      }`}>
        {/* Nền hiệu ứng lưới mạng không gian ngầm */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#0284c70a_1px,transparent_1px),linear-gradient(to_bottom,#0284c70a_1px,transparent_1px)] bg-[size:24px_24px]" />
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-sky-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className={`relative w-full max-w-md rounded-3xl border p-8 shadow-2xl backdrop-blur-xl transition-all ${
          isDarkMode
            ? 'border-neutral-800 bg-neutral-900/90 text-neutral-100'
            : 'border-slate-200 bg-white/95 text-slate-800 shadow-sky-500/5'
        }`}>
          {/* Logo & Tiêu đề */}
          <div className="text-center">
            <div className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-500 text-white shadow-lg shadow-sky-500/30">
              <Shield className="h-7 w-7" />
            </div>
            <h1 className="mt-4 text-2xl font-bold tracking-tight">
              ZT-ServerOps
            </h1>
            <p className="mt-1 text-xs font-mono text-slate-500 dark:text-neutral-400">
              DirectAdmin Evolution Console • Zero-Trust Gateway
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleLogin} className="mt-8 space-y-4">
            {logoutWarning && (
              <div className="rounded-xl border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-300 font-mono flex items-start space-x-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
                <span>{logoutWarning}</span>
              </div>
            )}

            {loginError && (
              <div className="rounded-xl border border-rose-300 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-950/30 p-3 text-xs text-rose-600 dark:text-rose-400 font-mono flex items-center space-x-2">
                <ShieldAlert className="h-4 w-4 shrink-0" />
                <span>{loginError}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-neutral-300 mb-1.5">Tên tài khoản</label>
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin hoặc viewer"
                  className="w-full rounded-xl border border-slate-200 dark:border-neutral-800 bg-slate-50/50 dark:bg-neutral-950 pl-10 pr-4 py-2.5 text-sm text-slate-900 dark:text-neutral-100 placeholder-slate-400 focus:border-sky-500 focus:bg-white focus:outline-none transition-colors"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-neutral-300 mb-1.5">Mật khẩu xác thực</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full rounded-xl border border-slate-200 dark:border-neutral-800 bg-slate-50/50 dark:bg-neutral-950 pl-10 pr-4 py-2.5 text-sm text-slate-900 dark:text-neutral-100 placeholder-slate-400 focus:border-sky-500 focus:bg-white focus:outline-none transition-colors"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-6 w-full min-h-[44px] inline-flex items-center justify-center space-x-2 rounded-xl bg-sky-600 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-50 transition-all shadow-md shadow-sky-600/20"
            >
              <span>{isSubmitting ? 'Đang xác thực...' : 'Đăng nhập vào Hệ thống'}</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>

          <div className="mt-6 border-t border-slate-100 dark:border-neutral-800 pt-4 flex items-center justify-between text-[11px] font-mono text-slate-400 dark:text-neutral-500">
            <span>TLS 1.3 • Ed25519</span>
            <button
              onClick={() => setIsDarkMode(!isDarkMode)}
              className="hover:text-sky-600 transition-colors"
            >
              {isDarkMode ? '☀️ Light' : '🌙 Dark'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // GIAO DIỆN CHÍNH DASHBOARD (DIRECTADMIN EVOLUTION MODERN LAYOUT)
  // --------------------------------------------------------------------------
  return (
    <div className={`min-h-screen flex flex-col md:flex-row transition-colors ${
      isDarkMode ? 'dark bg-[#090d16] text-neutral-100' : 'bg-[#f8fafc] text-slate-800'
    }`}>
      {/* 1. THANH ICON DOCK BÊN TRÁI (Chuẩn DirectAdmin Ảnh 1 - Desktop Only) */}
      <aside className="hidden md:flex flex-col w-16 bg-[#0284c7] text-white py-4 items-center justify-between shrink-0 shadow-md z-30 select-none">
        {/* Top: Logo thương hiệu */}
        <div className="flex flex-col items-center space-y-6">
          <div
            className="h-10 w-10 rounded-xl bg-white/20 flex items-center justify-center shadow-inner hover:scale-105 transition-transform cursor-pointer"
            title="ZT-ServerOps Control Panel (DirectAdmin Evolution Skin)"
          >
            <Shield className="h-6 w-6 text-white" />
          </div>

          {/* Cụm Icons điều hướng nhanh */}
          <div className="flex flex-col space-y-2">
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`p-2.5 rounded-xl transition-all ${
                activeTab === 'dashboard'
                  ? 'bg-white text-sky-700 shadow-md'
                  : 'text-sky-100 hover:bg-white/15'
              }`}
              title="Tổng quan Cụm (Dashboard)"
            >
              <LayoutDashboard className="h-5 w-5" />
            </button>

            <button
              onClick={() => setActiveTab('fleet')}
              className={`p-2.5 rounded-xl transition-all ${
                activeTab === 'fleet'
                  ? 'bg-white text-sky-700 shadow-md'
                  : 'text-sky-100 hover:bg-white/15'
              }`}
              title="Danh sách Máy chủ (Server Fleet)"
            >
              <Server className="h-5 w-5" />
            </button>

            <button
              onClick={() => setActiveTab('mesh')}
              className={`p-2.5 rounded-xl transition-all ${
                activeTab === 'mesh'
                  ? 'bg-white text-sky-700 shadow-md'
                  : 'text-sky-100 hover:bg-white/15'
              }`}
              title="Mạng ảo WireGuard (VPN Mesh)"
            >
              <Network className="h-5 w-5" />
            </button>

            <button
              onClick={() => setActiveTab('audit')}
              className={`p-2.5 rounded-xl transition-all ${
                activeTab === 'audit'
                  ? 'bg-white text-sky-700 shadow-md'
                  : 'text-sky-100 hover:bg-white/15'
              }`}
              title="Nhật ký Kiểm toán (Audit Logs)"
            >
              <FileText className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Bottom: Theme toggle và Đăng xuất */}
        <div className="flex flex-col items-center space-y-3">
          <button
            onClick={() => setIsDarkMode(!isDarkMode)}
            className="p-2.5 rounded-xl text-sky-100 hover:bg-white/15 transition-all"
            title={isDarkMode ? 'Chuyển sang Light Mode (DirectAdmin)' : 'Chuyển sang Dark Mode'}
          >
            {isDarkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>

          <button
            onClick={handleLogout}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl text-sky-100 hover:bg-rose-600 hover:text-white transition-all"
            title="Đăng xuất khỏi hệ thống"
          >
            <LogOut className="h-5 w-5" />
          </button>
        </div>
      </aside>

      {/* 2. SUB-SIDEBAR NAVIGATION (Cột trắng ngà chuẩn DirectAdmin Ảnh 1 - Desktop Only) */}
      <aside className="hidden lg:flex flex-col w-60 border-r border-slate-200/90 dark:border-slate-800 bg-[#f8fafc] dark:bg-slate-900/90 p-4 shrink-0 justify-between select-none">
        <div>
          {/* Header Sub-Sidebar */}
          <div className="flex items-center justify-between pb-3 border-b border-slate-200/80 dark:border-slate-800">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">Control Panel</h2>
              <span className="text-[11px] font-mono text-slate-400">Navigation</span>
            </div>
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" title="Gateway Online" />
          </div>

          {/* Segmented Switch: Admin vs User (RBAC Visual - Chuẩn DirectAdmin) */}
          <div className="mt-4 p-1 rounded-xl bg-slate-200/70 dark:bg-slate-800 flex items-center text-xs font-semibold">
            <div
              className={`flex-1 py-1.5 text-center rounded-lg transition-all ${
                currentUser.role === 'ADMIN'
                  ? 'bg-white dark:bg-slate-700 text-sky-700 dark:text-sky-300 shadow-xs'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Admin
            </div>
            <div
              className={`flex-1 py-1.5 text-center rounded-lg transition-all ${
                currentUser.role === 'VIEWER'
                  ? 'bg-white dark:bg-slate-700 text-sky-700 dark:text-sky-300 shadow-xs'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              User
            </div>
          </div>

          {/* Danh mục tính năng */}
          <nav className="mt-5 space-y-1 text-xs">
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-medium transition-colors ${
                activeTab === 'dashboard'
                  ? 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <span className="flex items-center">
                <LayoutDashboard className="h-4 w-4 mr-2.5 text-sky-600" />
                Tổng quan (Dashboard)
              </span>
              <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
            </button>

            <button
              onClick={() => setActiveTab('fleet')}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-medium transition-colors ${
                activeTab === 'fleet'
                  ? 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <span className="flex items-center">
                <Server className="h-4 w-4 mr-2.5 text-slate-400" />
                Danh sách Máy chủ
              </span>
              <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
            </button>

            <button
              onClick={() => setActiveTab('mesh')}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-medium transition-colors ${
                activeTab === 'mesh'
                  ? 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <span className="flex items-center">
                <Network className="h-4 w-4 mr-2.5 text-slate-400" />
                Mạng ảo WireGuard
              </span>
              <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
            </button>

            <button
              onClick={() => setActiveTab('audit')}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-medium transition-colors ${
                activeTab === 'audit'
                  ? 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <span className="flex items-center">
                <FileText className="h-4 w-4 mr-2.5 text-slate-400" />
                Nhật ký Kiểm toán
              </span>
              <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
            </button>
          </nav>
        </div>

        {/* Khối thẻ Mini Banner ở đáy (Tương tự ô 'Pro Pack' trong DirectAdmin Ảnh 1) */}
        <div className="rounded-2xl border border-sky-200/80 dark:border-sky-800/50 bg-gradient-to-br from-sky-600 to-indigo-700 p-3.5 text-white shadow-sm">
          <div className="flex items-center space-x-2">
            <Shield className="h-4 w-4 text-sky-200" />
            <span className="text-xs font-bold">Zero-Trust Shield</span>
          </div>
          <p className="mt-1.5 text-[11px] text-sky-100 leading-snug">
            Fast Probe 300ms • Cổng 22 Inbound bị chặn tuyệt đối.
          </p>
          <div className="mt-3 flex items-center justify-between text-[10px] font-mono text-sky-200 border-t border-white/10 pt-2">
            <span>Overlay Mesh</span>
            <span className="text-emerald-300">10.8.0.0/24</span>
          </div>
        </div>
      </aside>

      {/* 3. MOBILE HEADER & DRAWER (Hiển thị mượt mà trên Điện thoại < 768px) */}
      <header className="md:hidden sticky top-0 z-40 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center space-x-2.5">
          <button
            onClick={() => setIsMobileMenuOpen(true)}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title="Mở menu điều hướng"
          >
            <Menu className="h-6 w-6" />
          </button>

          <div className="flex items-center space-x-2">
            <div className="h-8 w-8 rounded-lg bg-sky-600 flex items-center justify-center text-white">
              <Shield className="h-4 w-4" />
            </div>
            <span className="font-bold text-sm text-slate-900 dark:text-slate-100">ZT-ServerOps</span>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
            currentUser.role === 'ADMIN'
              ? 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-400'
              : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
          }`}>
            {currentUser.role}
          </span>

          <button
            onClick={handleLogout}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl text-slate-400 hover:text-rose-600 transition-colors"
            title="Đăng xuất"
          >
            <LogOut className="h-5 w-5" />
          </button>
        </div>
      </header>

      {/* Mobile Drawer Backdrop & Panel */}
      {isMobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity"
            onClick={() => setIsMobileMenuOpen(false)}
          />
          <div className="relative w-72 max-w-[80vw] bg-white dark:bg-slate-900 h-full p-5 flex flex-col justify-between shadow-2xl z-10">
            <div>
              <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center space-x-2.5">
                  <div className="h-8 w-8 rounded-lg bg-sky-600 flex items-center justify-center text-white">
                    <Shield className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="font-bold text-sm text-slate-900 dark:text-slate-100">DirectAdmin Panel</h3>
                    <p className="text-[10px] font-mono text-slate-400">{currentUser.username} ({currentUser.role})</p>
                  </div>
                </div>
                <button
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Navigation items trên điện thoại */}
              <nav className="mt-5 space-y-1.5 text-xs font-medium">
                <button
                  onClick={() => { setActiveTab('dashboard'); setIsMobileMenuOpen(false); }}
                  className="w-full min-h-[44px] flex items-center px-3 rounded-xl bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 font-semibold"
                >
                  <LayoutDashboard className="h-4 w-4 mr-3 text-sky-600" />
                  Tổng quan (Dashboard)
                </button>
                <button
                  onClick={() => { setActiveTab('fleet'); setIsMobileMenuOpen(false); }}
                  className="w-full min-h-[44px] flex items-center px-3 rounded-xl text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <Server className="h-4 w-4 mr-3 text-slate-400" />
                  Danh sách Máy chủ
                </button>
                <button
                  onClick={() => { setActiveTab('mesh'); setIsMobileMenuOpen(false); }}
                  className="w-full min-h-[44px] flex items-center px-3 rounded-xl text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <Network className="h-4 w-4 mr-3 text-slate-400" />
                  Mạng ảo WireGuard
                </button>
                <button
                  onClick={() => { setActiveTab('audit'); setIsMobileMenuOpen(false); }}
                  className="w-full min-h-[44px] flex items-center px-3 rounded-xl text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <FileText className="h-4 w-4 mr-3 text-slate-400" />
                  Nhật ký Kiểm toán
                </button>
              </nav>
            </div>

            <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-3">
              <button
                onClick={() => setIsDarkMode(!isDarkMode)}
                className="w-full min-h-[44px] flex items-center justify-between px-3 rounded-xl border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-300"
              >
                <span>Chế độ hiển thị</span>
                <span>{isDarkMode ? '☀️ Light Mode' : '🌙 Dark Mode'}</span>
              </button>
              <button
                onClick={handleLogout}
                className="w-full min-h-[44px] flex items-center justify-center space-x-2 rounded-xl bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 text-xs font-semibold"
              >
                <LogOut className="h-4 w-4" />
                <span>Đăng xuất tài khoản</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. WORKSPACE CHÍNH (Nền Slate-50 sang trọng, thoáng đãng) */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        {/* Top Header thanh thoát trên Desktop */}
        <header className="hidden md:flex h-16 border-b border-slate-200/90 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md px-6 items-center justify-between sticky top-0 z-20">
          <div className="flex items-center space-x-3">
            <h1 className="text-base font-bold text-slate-900 dark:text-slate-100">
              Dashboard
            </h1>
            <span className="text-xs text-slate-400 font-mono">
              / Cluster Overview
            </span>
          </div>

          <div className="flex items-center space-x-4">
            {/* Status WireGuard Mesh */}
            <div className="flex items-center space-x-2 px-3 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span>Mesh UDP 51820</span>
            </div>

            {/* Thông tin tài khoản & Role */}
            <div className="flex items-center space-x-2 text-xs font-mono border-l border-slate-200 dark:border-slate-800 pl-4">
              <span className="text-slate-600 dark:text-slate-400 font-semibold">{currentUser.username}</span>
              <span
                className={`px-2 py-0.5 rounded font-bold ${
                  currentUser.role === 'ADMIN'
                    ? 'bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-400'
                    : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                }`}
              >
                {currentUser.role}
              </span>
            </div>

            {/* Nút Đăng xuất */}
            <button
              onClick={handleLogout}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800 text-slate-500 hover:border-rose-300 hover:text-rose-600 transition-colors shadow-xs"
              title="Đăng xuất"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>

        {/* Nội dung chính màn hình */}
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <ClusterOverview currentUser={currentUser} onOpenTerminal={(node) => setSelectedTerminalNode(node)} />
        </main>

        {/* Footer tối giản */}
        <footer className="border-t border-slate-200/80 dark:border-slate-800/60 py-5 text-center text-xs font-mono text-slate-400 dark:text-slate-500">
          <p>ZT-ServerOps Control Plane • DirectAdmin Evolution Light Archetype • Do-an-co-so-nganh (HaUI, TS. Nguyễn Đắc Hải, Nhóm 9)</p>
        </footer>
      </div>

      {/* 5. CỬA SỔ DÒNG LỆNH TERMINAL MODAL */}
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

