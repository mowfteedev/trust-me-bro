import { useEffect, useRef, useState } from "react";
import { api } from "../services/api.js";
import { NodeItem } from "../types/index.js";
import { startVisiblePolling } from "../utils/visiblePolling.js";

export function useClusterData() {
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [selectedNode, setSelectedNode] = useState<NodeItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const clusterRequestPending = useRef(false);
  const mounted = useRef(true);

  const fetchClusterData = async (isManual = false) => {
    // A slow response must not queue additional polling requests.
    if (clusterRequestPending.current) return;
    clusterRequestPending.current = true;
    if (isManual) setIsRefreshing(true);
    try {
      const data = await api.getNodes();
      if (!mounted.current) return;
      setNodes(data);
      setErrorMessage(null);
      setLastUpdated(new Date().toISOString());
      setSelectedNode(
        (prev) => data.find((n) => n.id === prev?.id) ?? data[0] ?? null,
      );
    } catch (err: any) {
      if (!mounted.current) return;
      setErrorMessage(
        err.message || "Không thể kết nối tới Control Plane Gateway",
      );
    } finally {
      clusterRequestPending.current = false;
      if (mounted.current) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  };

  useEffect(() => {
    mounted.current = true;
    const stop = startVisiblePolling(() => {
      setNow(Date.now());
      return fetchClusterData();
    }, 5000);
    return () => { mounted.current = false; stop(); };
  }, []);

  return {
    nodes,
    selectedNode,
    setSelectedNode,
    isLoading,
    isRefreshing,
    errorMessage,
    lastUpdated,
    now,
    fetchClusterData,
  };
}
