import { useEffect, useRef, useState } from "react";
import { api } from "../services/api.js";
import { NodeItem, NodeLifecycleFilter } from "../types/index.js";
import { startVisiblePolling } from "../utils/visiblePolling.js";

export function useClusterData(lifecycle: NodeLifecycleFilter = "active") {
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [activeNodes, setActiveNodes] = useState<NodeItem[]>([]);
  const [selectedNode, setSelectedNode] = useState<NodeItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const clusterRequestPending = useRef(false);
  const mounted = useRef(true);
  const lifecycleRef = useRef(lifecycle);
  lifecycleRef.current = lifecycle;

  const fetchClusterData = async (isManual = false) => {
    // A slow response must not queue additional polling requests.
    if (clusterRequestPending.current) return;
    clusterRequestPending.current = true;
    if (isManual) setIsRefreshing(true);
    try {
      const currentLifecycle = lifecycleRef.current;
      const data = await api.getNodes(currentLifecycle);
      if (!mounted.current) return;
      setNodes(data);
      if (currentLifecycle === "active") {
        setActiveNodes(data);
      } else if (activeNodes.length === 0) {
        // Fetch active nodes once for cluster summary if not yet loaded
        api.getNodes("active").then((act) => {
          if (mounted.current) setActiveNodes(act);
        }).catch(() => {});
      }
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
    void fetchClusterData();
  }, [lifecycle]);

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
    activeNodes,
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
