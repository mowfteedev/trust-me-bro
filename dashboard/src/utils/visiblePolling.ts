// Each caller owns its in-flight guard and stale-response protection.
export function startVisiblePolling(task: () => void | Promise<void>, intervalMs: number): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const run = () => { if (!stopped && !document.hidden) void task(); };
  const update = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (!stopped && !document.hidden) {
      run();
      timer = setInterval(run, intervalMs);
    }
  };
  document.addEventListener('visibilitychange', update);
  update();
  return () => {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    document.removeEventListener('visibilitychange', update);
  };
}
