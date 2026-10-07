import { NodeItem, MetricSnapshot, UserSession } from '../types/index.js';

/**
 * ==============================================================================
 * DỊCH VỤ GIAO TIẾP VỚI GATEWAY API (services/api.ts)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: frontend (chủ trì), backend
 * ==============================================================================
 */

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
        this.user = JSON.parse(savedUser);
      } catch {
        this.user = null;
      }
    }
  }

  public getToken(): string | null {
    return this.token;
  }

  public getCurrentUser(): UserSession | null {
    return this.user;
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

  /**
   * Bộ điều phối HTTP Request có tự động đính kèm JWT Bearer Header
   */
  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(endpoint, {
      ...options,
      headers,
    });

    if (response.status === 401) {
      this.clearSession();
      throw new Error('Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.');
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMessage = data?.detail || data?.message || `Lỗi máy chủ: ${response.statusText}`;
      throw new Error(errorMessage);
    }

    return data as T;
  }

  /**
   * Đăng nhập người dùng quản trị
   */
  public async login(username: string, password: string): Promise<UserSession> {
    const res = await this.request<{ success: boolean; token: string; user: UserSession }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });

    this.setSession(res.token, res.user);
    return res.user;
  }

  /**
   * Lấy danh sách toàn bộ Endpoint Hosts
   */
  public async getNodes(): Promise<NodeItem[]> {
    const res = await this.request<{ success: boolean; data: NodeItem[] }>('/api/telemetry/nodes');
    return res.data;
  }

  /**
   * Lấy lịch sử số liệu chuỗi thời gian của một máy chủ con
   */
  public async getNodeHistory(nodeId: string): Promise<MetricSnapshot[]> {
    const res = await this.request<{ success: boolean; data: MetricSnapshot[] }>(`/api/telemetry/nodes/${nodeId}/history`);
    return res.data;
  }

  /**
   * Yêu cầu cấp One-Time Ticket để kết nối Web SSH Terminal
   */
  public async getBastionTicket(nodeId: string): Promise<string> {
    const res = await this.request<{ success: boolean; ticket: string }>('/api/bastion/ticket', {
      method: 'POST',
      body: JSON.stringify({ node_id: nodeId }),
    });
    return res.ticket;
  }

  /**
   * Kiểm tra tính khả dụng của Gateway Server
   */
  public async checkHealth(): Promise<{ status: string }> {
    const res = await fetch('/healthz');
    return await res.json();
  }
}

export const api = new ApiService();
