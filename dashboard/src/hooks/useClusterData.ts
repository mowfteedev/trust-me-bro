import { useEffect, useRef, useState } from "react";
import { api } from "../services/api.js";
import { NodeItem } from "../types/index.js";

export function useClusterData() {
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [selectedNode, setSelectedNode] = useState<NodeItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const clusterRequestPending = useRef(false);

  const fetchClusterData = async (isManual = false) => {
    // A slow response must not queue additional polling requests.
    if (clusterRequestPending.current) return;
    clusterRequestPending.current = true;
    if (isManual) setIsRefreshing(true);
    try {
      const data = await api.getNodes();
      setNodes(data);
      setErrorMessage(null);
      setLastUpdated(new Date().toISOString());
      setSelectedNode(
        (prev) => data.find((n) => n.id === prev?.id) ?? data[0] ?? null,
      );
    } catch (err: any) {
      setErrorMessage(
        err.message || "Không thể kết nối tới Control Plane Gateway",
      );
    } finally {
      clusterRequestPending.current = false;
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    fetchClusterData();
    const timer = setInterval(() => {
      setNow(Date.now());
      fetchClusterData();
    }, 5000);
    return () => clearInterval(timer);
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
