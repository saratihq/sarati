import { runBounded } from './bounded';

/** A gate that resolves each task only when the test releases it — lets us observe how many run at once. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('runBounded', () => {
  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await runBounded([1, 2, 3, 4, 5], 2, async (n) => {
      await Promise.resolve();
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('never runs more than `limit` tasks concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];
    const run = runBounded([0, 1, 2, 3, 4], 2, async (i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gates[i]!.promise;
      inFlight -= 1;
    });
    // With limit 2, exactly 2 start; release them one at a time so a fresh one starts.
    await Promise.resolve();
    for (const gate of gates) {
      gate.resolve();
      await Promise.resolve();
    }
    await run;
    expect(peak).toBe(2);
  });

  it('caps the worker count at the item count (limit larger than items)', async () => {
    let inFlight = 0;
    let peak = 0;
    await runBounded([1, 2], 10, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('is a no-op on an empty list', async () => {
    const task = jest.fn(() => Promise.resolve());
    await runBounded([], 3, task);
    expect(task).not.toHaveBeenCalled();
  });

  it('rejects when a task throws (Promise.all semantics)', async () => {
    await expect(
      runBounded([1, 2, 3], 2, async (n) => {
        await Promise.resolve();
        if (n === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
