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
  /** Whether `err` is this substrate unwinding a cancelled run — never a step failure. */
  isCancellation(err: unknown): boolean;
}

/** Thrown at the next step boundary of an in-process run that was cancelled. */
export class RunCancelledError extends Error {
  constructor() {
    super('Run was cancelled');
    this.name = 'RunCancelledError';
  }
}

/** Non-durable local/test substrate — in-process timer + in-memory bus. NOT safe for production side effects. */
export class PassThroughDurableStep implements DurableStep {
  private readonly waiters = new Map<string, (value: unknown) => void>();
  private readonly pauses = new Set<() => void>();
  private cancelled = false;

  async run<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    if (this.cancelled) throw new RunCancelledError();
    return fn();
  }

  sleep(_name: string, ms: number): Promise<void> {
    return this.pause<void>((wake) => {
      const timer = setTimeout(wake, ms);
      return () => clearTimeout(timer);
    });
  }

  waitForEvent<T = unknown>(_name: string, topic: string, timeoutMs: number): Promise<T | null> {
    return this.pause<T | null>((wake) => {
      const timer = setTimeout(() => wake(null), timeoutMs);
      const receiver = (value: unknown): void => wake(value as T);
      this.waiters.set(topic, receiver);
      return () => {
        clearTimeout(timer);
        if (this.waiters.get(topic) === receiver) this.waiters.delete(topic);
      };
    });
  }

  isCancellation(err: unknown): boolean {
    return err instanceof RunCancelledError;
  }

  /** Deliver an event to a pending `waitForEvent` on `topic`. Returns false if none is waiting. */
  deliver(topic: string, payload: unknown): boolean {
    const waiter = this.waiters.get(topic);
    if (!waiter) return false;
    waiter(payload);
    return true;
  }

  /** Cancel the run: a pending pause ends now, and every later step throws {@link RunCancelledError}. */
  cancel(): void {
    this.cancelled = true;
    for (const abort of [...this.pauses]) abort();
  }

  /** A pause a cancel cuts short; `arm` starts it and returns how to disarm it. */
  private pause<T>(arm: (wake: (value: T) => void) => () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.cancelled) {
        reject(new RunCancelledError());
        return;
      }
      const settle = (): void => {
        disarm();
        this.pauses.delete(abort);
      };
      const abort = (): void => {
        settle();
        reject(new RunCancelledError());
      };
      const disarm = arm((value) => {
        settle();
        resolve(value);
      });
      this.pauses.add(abort);
    });
  }
}
