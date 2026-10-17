export const formatBytes = (value?: number): string => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index =
    value > 0
      ? Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
      : 0;
  return `${(value / 1024 ** index).toFixed(1)} ${units[index]}`;
};

export const formatUptime = (seconds?: number): string => {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
};

export const formatTime = (value?: string | null): string => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
  return new Date(value).toLocaleTimeString("vi-VN");
};

export const formatDateTime = (value?: string | null): string => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
  return new Date(value).toLocaleString("vi-VN");
};

// Browser clock is only a display aid. Online/Stale/Offline always comes from Gateway.
export const formatAge = (value: string | null | undefined, now: number): string => {
  if (!value || !Number.isFinite(Date.parse(value))) return "Chưa nhận heartbeat";
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds} giây trước`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} giờ trước`;
  return `${Math.floor(seconds / 86400)} ngày trước`;
};

export const nodeTypeLabel = (type: string): string => {
  if (type === "DOCKER") return "Docker container";
  if (type === "VM") return "Máy ảo";
  if (type === "BARE_METAL") return "Máy vật lý";
  return type;
};
