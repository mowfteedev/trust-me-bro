import { useEffect, useState } from "react";
import { api } from "../services/api.js";
import { UserSession } from "../types/index.js";

export function useSession() {
  const [currentUser, setCurrentUser] = useState<UserSession | null>(
    api.getCurrentUser(),
  );
  // Giữ tên đăng nhập qua các phiên; mật khẩu chỉ nằm trong LoginPage.
  const [username, setUsername] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [logoutWarning, setLogoutWarning] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const onExpired = () => {
      setCurrentUser(null);
      setLoginError("Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.");
    };
    window.addEventListener("zt-session-expired", onExpired);
    return () => window.removeEventListener("zt-session-expired", onExpired);
  }, []);

  const login = async (password: string): Promise<boolean> => {
    setLoginError(null);
    setLogoutWarning(null);
    setIsSubmitting(true);
    try {
      const user = await api.login(username, password);
      setCurrentUser(user);
      return true;
    } catch (err: any) {
      setLoginError(
        err.message || "Tên đăng nhập hoặc mật khẩu không chính xác",
      );
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  const logout = async () => {
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
  };

  return {
    currentUser,
    username,
    setUsername,
    loginError,
    logoutWarning,
    isSubmitting,
    login,
    logout,
  };
}
