/**
 * Run `task` over `items` with at most `limit` in flight. `task` owns its errors — a throw rejects
 * the whole run, so a caller that must not abort the batch passes a `.catch`-wrapped task.
 */
export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const total = items.length;
  if (total === 0) return;
  const workerCount = Math.min(Math.max(1, Math.floor(limit)), total);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < total) {
      const item = items[next++]; // synchronous claim before any await — no double-run
      if (item === undefined) continue;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
