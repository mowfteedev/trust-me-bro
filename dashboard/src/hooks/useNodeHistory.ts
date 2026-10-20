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
    if (!nodeId) return;
    setHistoryLoading(true);
    let isCurrent = true;
    const fetchHistory = () => {
      api
        .getNodeHistory(nodeId)
        .then((data) => {
          if (isCurrent) {
            setMetricsHistory(data);
            setHistoryError(null);
            setHistoryLoading(false);
          }
        })
        .catch((err: Error) => {
          if (isCurrent) {
            setHistoryError(
              err.message || "Không tải được lịch sử tài nguyên.",
            );
            setHistoryLoading(false);
          }
        });
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
