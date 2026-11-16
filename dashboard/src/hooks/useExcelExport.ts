import { useEffect, useRef, useState } from 'react';

export function useExcelExport() {
  const pending = useRef(false);
  const active = useRef(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const run = async (exportFile: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setExporting(true); setError(null);
    try { await exportFile(); }
    catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : 'Không thể xuất Excel. Vui lòng thử lại.');
    } finally {
      pending.current = false;
      if (active.current) setExporting(false);
    }
  };
  return { exporting, error, run };
}
