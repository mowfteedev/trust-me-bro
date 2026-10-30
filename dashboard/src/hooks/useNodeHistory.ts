import { useEffect, useState } from "react";
import { api } from "../services/api.js";
import { MetricSnapshot } from "../types/index.js";

export function useNodeHistory(nodeId: string | undefined) {
  const [metricsHistory, setMetricsHistory] = useState<MetricSnapshot[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    setMetricsHistory([]);
    setHistoryError(null);
    setHistoryLoading(Boolean(nodeId));
    if (!nodeId) return;
    let isCurrent = true;
    let pending = false;
    const fetchHistory = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await api.getNodeHistory(nodeId);
        if (isCurrent) {
          setMetricsHistory(data);
          setHistoryError(null);
        }
      } catch (err) {
        if (isCurrent) setHistoryError(err instanceof Error ? err.message : "Không tải được lịch sử tài nguyên.");
      } finally {
        pending = false;
        if (isCurrent) setHistoryLoading(false);
      }
    };
    fetchHistory();
    const historyTimer = setInterval(fetchHistory, 3000);
    return () => {
      isCurrent = false;
      clearInterval(historyTimer);
    };
  }, [nodeId]);

  return { metricsHistory, historyError, historyLoading };
}
