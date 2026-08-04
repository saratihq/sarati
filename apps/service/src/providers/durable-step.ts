/**
 * Thin seam over the durable-execution substrate: the interpreter runs every side effect and pause through THIS
 * contract, never DBOS directly, and the DBOS impl checkpoints each so a crash resumes instead of re-firing.
 */
export interface DurableStep {
  /** A checkpointed step — its result is memoized on resume. */
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Pause durably for `ms`. */
  sleep(name: string, ms: number): Promise<void>;
  /** Suspend durably until an event is delivered to `topic`, or `timeoutMs` elapses (→ null). */
  waitForEvent<T = unknown>(name: string, topic: string, timeoutMs: number): Promise<T | null>;
}

/** Non-durable local/test substrate — in-process timer + in-memory bus. NOT safe for production side effects. */
export class PassThroughDurableStep implements DurableStep {
  private readonly waiters = new Map<string, (value: unknown) => void>();

  run<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  sleep(_name: string, ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  waitForEvent<T = unknown>(_name: string, topic: string, timeoutMs: number): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(topic);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(topic, (value) => {
        clearTimeout(timer);
        this.waiters.delete(topic);
        resolve(value as T);
      });
    });
  }

  /** Deliver an event to a pending `waitForEvent` on `topic`. Returns false if none is waiting. */
  deliver(topic: string, payload: unknown): boolean {
    const waiter = this.waiters.get(topic);
    if (!waiter) return false;
    waiter(payload);
    return true;
  }
}
