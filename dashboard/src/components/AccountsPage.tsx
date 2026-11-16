import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Users } from 'lucide-react';
import { api } from '../services/api.js';
import type { ManagedUser, UserRole, UserSession } from '../types/index.js';

export function AccountsPage({ currentUser }: { currentUser: UserSession }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('VIEWER');
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [pairing, setPairing] = useState<{ mode: string; paired: boolean; otp: string | null } | null>(null);
  const isAdmin = currentUser.role === 'ADMIN';

  useEffect(() => {
    let active = true;
    if (!isAdmin) { setLoading(false); return; }
    setLoading(true); setLoadError(null);
    void api.getUsers(page).then(result => {
      if (active) { setUsers(result.data); setHasMore(result.has_more); }
    }).catch(error => { if (active) setLoadError(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, revision, isAdmin]);

  const perform = async (task: () => Promise<void>, message: string) => {
    if (busy) return;
    setBusy(true); setNotice(null);
    try { await task(); setNotice({ error: false, text: message }); setRevision(value => value + 1); }
    catch (error) { setNotice({ error: true, text: error instanceof Error ? error.message : 'Không hoàn tất thao tác.' }); }
    finally { setBusy(false); }
  };

  return <section className="management-page" aria-labelledby="accounts-heading">
    <div className="page-heading"><h1 id="accounts-heading"><Users size={24} /> Tài khoản</h1>
      {isAdmin && <button className="button secondary" aria-label="Làm mới tài khoản" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={18} /><span>Làm mới</span></button>}
    </div>
    {notice && <div role={notice.error ? 'alert' : 'status'} className={`notice ${notice.error ? 'danger' : 'success'}`}>{notice.text}</div>}
    <div className="account-grid">
      <section className="management-panel"><h2>Đổi mật khẩu</h2>
        <form className="management-form" onSubmit={event => {
          event.preventDefault();
          if (newPassword !== repeatPassword) { setNotice({ error: true, text: 'Hai mật khẩu mới chưa khớp.' }); return; }
          void perform(async () => {
            await api.changePassword(currentPassword, newPassword);
          }, 'Đã đổi mật khẩu. Vui lòng đăng nhập lại.');
          setCurrentPassword(''); setNewPassword(''); setRepeatPassword('');
        }}>
          <label>Mật khẩu hiện tại<input type="password" autoComplete="current-password" required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></label>
          <label>Mật khẩu mới<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={newPassword} onChange={event => setNewPassword(event.target.value)} /></label>
          <label>Nhập lại mật khẩu mới<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={repeatPassword} onChange={event => setRepeatPassword(event.target.value)} /></label>
          <p className="field-hint">12–128 ký tự. Đổi mật khẩu sẽ thu hồi mọi phiên đăng nhập và Web SSH của tài khoản.</p>
          <button className="button primary" disabled={busy}>Đổi mật khẩu và đăng xuất</button>
        </form>
        <div className="account-sessions"><h2>Phiên đăng nhập</h2>
          <p>Nút đăng xuất trên thanh trên cùng đóng phiên đăng nhập hiện tại.</p>
          <button className="button secondary" disabled={busy} onClick={() => {
            if (window.confirm('Đăng xuất tài khoản này trên tất cả thiết bị, bao gồm các phiên Web SSH?'))
              void perform(() => api.logoutAll(), 'Đã thu hồi tất cả phiên.');
          }}>Đăng xuất tất cả thiết bị</button>
        </div>
      </section>
      {isAdmin && <section className="management-panel"><h2>Tạo tài khoản</h2>
        <form className="management-form" onSubmit={event => {
          event.preventDefault();
          void perform(async () => {
            await api.createUser({ username, password, role }); setUsername(''); setRole('VIEWER');
          }, 'Đã tạo tài khoản.');
          setPassword('');
        }}>
          <label>Tên đăng nhập<input autoComplete="off" pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,49}" minLength={3} maxLength={50} required value={username} onChange={event => setUsername(event.target.value)} /></label>
          <label>Mật khẩu ban đầu<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={password} onChange={event => setPassword(event.target.value)} /></label>
          <label>Vai trò<select value={role} onChange={event => setRole(event.target.value as UserRole)}><option value="VIEWER">Viewer — chỉ xem</option><option value="ADMIN">Admin — quản trị</option></select></label>
          <p className="field-hint">Tên gồm 3–50 chữ, số hoặc dấu . _ -. Mật khẩu 12–128 ký tự.</p>
          <button className="button primary" disabled={busy}>Tạo tài khoản</button>
        </form>
      </section>}
    </div>
    {isAdmin && <section className="management-panel"><h2>Kênh Telegram</h2>
      <button className="button secondary" disabled={busy} onClick={() => {
        if (pairing) { setPairing(null); return; }
        void perform(async () => { setPairing(await api.getTelegramPairing()); }, 'Đã kiểm tra cấu hình Telegram.');
      }}>{pairing ? 'Ẩn thông tin ghép nối' : 'Kiểm tra kênh nhận cảnh báo'}</button>
      {pairing && <p className="pairing-result">{pairing.paired ? 'Đã ghép kênh nhận cảnh báo.' : pairing.otp ? <>Gửi <code>/pair {pairing.otp}</code> tới bot để ghép kênh nhận cảnh báo.</> : `Chế độ ${pairing.mode}; chưa có mã ghép nối khả dụng.`}</p>}
    </section>}
    {isAdmin && <section className="management-panel"><h2>Danh sách tài khoản</h2>
      {loadError ? <div role="alert" className="notice danger">{loadError} <button className="button secondary" onClick={() => setRevision(value => value + 1)}>Thử lại</button></div>
        : loading ? <p role="status">Đang tải tài khoản…</p> : users.length === 0 ? <p>Không có tài khoản trên trang này.</p> : <div className="management-table-wrap"><table className="management-table">
          <thead><tr><th>Tên đăng nhập</th><th>Vai trò</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
          <tbody>{users.map(user => <tr key={user.id}><td>{user.username}{user.id === currentUser.id && <span className="field-hint"> (bạn)</span>}</td><td>{user.role}</td><td>{user.is_active ? 'Đang hoạt động' : 'Đã khóa'}</td><td>
            <button className="button secondary" disabled={busy || user.id === currentUser.id} onClick={() => { setEditing({ ...user }); setResetPassword(''); }}>Chỉnh sửa</button>
          </td></tr>)}</tbody>
        </table></div>}
      <div className="management-pagination"><button className="button secondary" aria-label="Trang tài khoản trước" disabled={page === 1 || loading || busy} onClick={() => setPage(value => value - 1)}><ChevronLeft size={18} /></button><span>Trang {page}</span><button className="button secondary" aria-label="Trang tài khoản sau" disabled={!hasMore || loading || busy} onClick={() => setPage(value => value + 1)}><ChevronRight size={18} /></button></div>
    </section>}
    {editing && <section className="management-panel" aria-labelledby="edit-user-heading"><h2 id="edit-user-heading">Chỉnh sửa {editing.username}</h2>
      <form className="management-form" onSubmit={event => {
        event.preventDefault();
        void perform(async () => {
          await api.updateUser(editing.id, { role: editing.role, is_active: editing.is_active }); setEditing(null);
        }, 'Đã cập nhật tài khoản và thu hồi phiên cũ khi quyền thay đổi.');
      }}>
        <label>Vai trò<select value={editing.role} onChange={event => setEditing({ ...editing, role: event.target.value as UserRole })}><option value="VIEWER">VIEWER</option><option value="ADMIN">ADMIN</option></select></label>
        <label>Trạng thái<select value={String(editing.is_active)} onChange={event => setEditing({ ...editing, is_active: event.target.value === 'true' })}><option value="true">Đang hoạt động</option><option value="false">Khóa tài khoản</option></select></label>
        <div className="management-actions"><button className="button primary" disabled={busy}>Lưu thay đổi</button><button type="button" className="button secondary" disabled={busy} onClick={() => { setEditing(null); setResetPassword(''); }}>Đóng</button></div>
      </form>
      <form className="management-form password-reset" onSubmit={event => {
        event.preventDefault();
        if (!window.confirm(`Đặt lại mật khẩu và thu hồi mọi phiên của ${editing.username}?`)) return;
        void perform(() => api.resetPassword(editing.id, resetPassword), 'Đã đặt lại mật khẩu và thu hồi phiên.');
        setResetPassword('');
      }}><label>Mật khẩu thay thế<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={resetPassword} onChange={event => setResetPassword(event.target.value)} /></label><button className="button secondary" disabled={busy}>Đặt lại mật khẩu</button></form>
    </section>}
  </section>;
}
