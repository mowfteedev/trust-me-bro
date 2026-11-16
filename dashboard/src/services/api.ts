import { NodeItem, MetricSnapshot, UserSession, AuditLogPage, HostSnapshot, ManagedUser, IncidentPage } from '../types/index.js';

const TOKEN_STORAGE_KEY = 'zt_session_token';
const USER_STORAGE_KEY = 'zt_user_profile';

class ApiService {
  private token: string | null = null;
  private user: UserSession | null = null;

  constructor() {
    this.token = localStorage.getItem(TOKEN_STORAGE_KEY);
    const savedUser = localStorage.getItem(USER_STORAGE_KEY);
    if (savedUser) {
      try {
        const user = JSON.parse(savedUser);
        if (user && typeof user.id === 'string' && user.id.trim()
          && typeof user.username === 'string' && user.username.trim()
          && (user.role === 'ADMIN' || user.role === 'VIEWER')) {
          this.user = user;
        }
      } catch {
        this.user = null;
      }
    }
    if (!this.token || !this.user) this.clearSession();
  }

  public getToken(): string | null {
    return this.token;
  }

  public getCurrentUser(): UserSession | null {
    return this.token ? this.user : null;
  }

  public isAuthenticated(): boolean {
    return !!this.token;
  }

  private setSession(token: string, user: UserSession): void {
    this.token = token;
    this.user = user;
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
  }

  public clearSession(): void {
    this.token = null;
    this.user = null;
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(USER_STORAGE_KEY);
  }

  // Xóa phiên đã đăng xuất; caller phân biệt Gateway đã xác nhận thu hồi hay chưa.
  public async logout(): Promise<{ serverRevoked: boolean; error?: string }> {
    const logoutToken = this.token;
    let serverRevoked = false;
    let errorMsg: string | undefined;
    try {
      if (this.token) {
        await this.request('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
        serverRevoked = true;
      }
    } catch (err: any) {
      errorMsg = err.message || 'Mất kết nối máy chủ';
      console.warn('⚠️ [API LOGOUT] Máy chủ chưa xác nhận thu hồi phiên do sự cố kết nối:', errorMsg);
    } finally {
      if (this.token === logoutToken) this.clearSession();
    }
    return { serverRevoked, error: errorMsg };
  }

  private async response(endpoint: string, options: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
    const requestToken = this.token;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };

    if (requestToken) {
      headers['Authorization'] = `Bearer ${requestToken}`;
    }

    const response = await fetch(endpoint, {
      ...options,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const data = response.ok ? null : await response.json().catch(() => null);

    if ((response.status === 401 || (response.status === 403 && data?.code === 'ACCOUNT_DISABLED'))
      && endpoint !== '/api/auth/login') {
      // A response from an old session must not invalidate a newer login.
      if (this.token === requestToken) {
        this.clearSession();
        window.dispatchEvent(new Event('zt-session-expired'));
      }
      throw new Error(data?.detail || 'Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.');
    }

    if (!response.ok) {
      const errorMessage = data?.detail || data?.message || `Lỗi máy chủ: ${response.statusText}`;
      throw new Error(errorMessage);
    }

    return response;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await this.response(endpoint, options);
    return response.json().catch(() => null) as Promise<T>;
  }

  private async downloadExcel(endpoint: string, filename: string): Promise<void> {
    const token = this.token;
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const response = await this.response(endpoint, { headers: { Accept: mime } }, 60000);
    if (!response.headers.get('content-type')?.includes(mime)) {
      throw new Error('Máy chủ chưa trả về file Excel hợp lệ. Vui lòng thử lại.');
    }
    const blob = await response.blob();
    if (this.token !== token) throw new Error('Phiên đăng nhập đã thay đổi. Vui lòng xuất lại.');
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url; link.download = filename; link.hidden = true;
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); }
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }

  public async exportAuditLogs(filters: { action: string; q: string }): Promise<void> {
    const params = new URLSearchParams();
    if (filters.action) params.set('action', filters.action);
    if (filters.q) params.set('q', filters.q);
    return this.downloadExcel(`/api/audit/logs/export?${params}`, 'zt-audit-logs.xlsx');
  }

  public async exportIncidents(state: 'open' | 'resolved' | 'all'): Promise<void> {
    return this.downloadExcel(`/api/incidents/export?state=${state}`, 'zt-incidents.xlsx');
  }

  public async login(username: string, password: string): Promise<UserSession> {
    const res = await this.request<{ success: boolean; token: string; user: UserSession }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });

    this.setSession(res.token, res.user);
    return res.user;
  }

  public async getHost(): Promise<HostSnapshot> {
    return this.request<HostSnapshot>('/api/host');
  }

  public async getUsers(page = 1): Promise<{ data: ManagedUser[]; has_more: boolean }> {
    return this.request(`/api/users?page=${page}`);
  }

  public async createUser(input: { username: string; password: string; role: 'ADMIN' | 'VIEWER' }): Promise<void> {
    await this.request('/api/users', { method: 'POST', body: JSON.stringify(input) });
  }

  public async updateUser(id: string, input: { role: 'ADMIN' | 'VIEWER'; is_active: boolean }): Promise<void> {
    await this.request(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
  }

  public async resetPassword(id: string, password: string): Promise<void> {
    await this.request(`/api/users/${encodeURIComponent(id)}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) });
  }

  public async changePassword(current_password: string, new_password: string): Promise<void> {
    const sessionToken = this.token;
    await this.request('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password, new_password }) });
    if (this.token === sessionToken) {
      this.clearSession();
      window.dispatchEvent(Object.assign(new Event('zt-session-expired'), { message: 'Đã đổi mật khẩu. Vui lòng đăng nhập lại.' }));
    }
  }

  public async logoutAll(): Promise<void> {
    const sessionToken = this.token;
    await this.request('/api/auth/logout-all', { method: 'POST', body: JSON.stringify({}) });
    if (this.token === sessionToken) {
      this.clearSession();
      window.dispatchEvent(Object.assign(new Event('zt-session-expired'), { message: 'Đã đăng xuất tất cả thiết bị. Vui lòng đăng nhập lại.' }));
    }
  }

  public async getTelegramPairing(): Promise<{ mode: string; paired: boolean; otp: string | null }> {
    return this.request('/api/telegram/pairing');
  }

  public async getIncidents(state: 'open' | 'resolved' | 'all', page = 1): Promise<IncidentPage> {
    return this.request(`/api/incidents?state=${state}&page=${page}&page_size=20`);
  }

  public async getNodes(): Promise<NodeItem[]> {
    const res = await this.request<{ success: boolean; data: NodeItem[] }>('/api/telemetry/nodes');
    return res.data;
  }

  public async getNodeHistory(nodeId: string): Promise<MetricSnapshot[]> {
    const res = await this.request<{ success: boolean; data: MetricSnapshot[] }>(`/api/telemetry/nodes/${nodeId}/history`);
    return res.data;
  }

  public async getAuditLogs(filters: { page: number; action: string; q: string }): Promise<AuditLogPage> {
    const params = new URLSearchParams({ page: String(filters.page) });
    if (filters.action) params.set('action', filters.action);
    if (filters.q) params.set('q', filters.q);
    return this.request<AuditLogPage>(`/api/audit/logs?${params}`);
  }

  public async getBastionTicket(nodeId: string): Promise<string> {
    const res = await this.request<{ success: boolean; ticket: string }>('/api/bastion/ticket', {
      method: 'POST',
      body: JSON.stringify({ node_id: nodeId }),
    });
    return res.ticket;
  }

  public async sendTestAlert(): Promise<{ success: boolean; dryRun: boolean; message: string }> {
    return this.request<{ success: boolean; dryRun: boolean; message: string }>('/api/telegram/test', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  public async checkHealth(): Promise<{ status: string }> {
    const res = await fetch('/healthz', { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Gateway: HTTP ${res.status}`);
    return await res.json();
  }
}

export const api = new ApiService();
