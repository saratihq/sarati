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
  /** Wait `ms` inside a step's body, unrecorded; a cancel this substrate can see mid-step cuts it short. */
  waitInStep(ms: number): Promise<void>;
  /** Whether `err` is this substrate unwinding its own run's cancel — never a step failure. */
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
  private readonly onCancel = new Set<() => void>();
  private cancelled = false;

  async run<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    if (this.cancelled) throw new RunCancelledError();
    return fn();
  }

  sleep(_name: string, ms: number): Promise<void> {
    return this.waitInStep(ms);
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

  waitInStep(ms: number): Promise<void> {
    return this.pause<void>((wake) => {
      const timer = setTimeout(wake, ms);
      return () => clearTimeout(timer);
    });
  }

  isCancellation(err: unknown): boolean {
    return this.cancelled && err instanceof RunCancelledError;
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
    for (const hook of [...this.onCancel]) hook();
  }

  /** Run a run nested inside this one's current step on a substrate this run's cancel reaches too. */
  async nest<T>(run: (durable: PassThroughDurableStep) => Promise<T>): Promise<T> {
    const nested = new PassThroughDurableStep();
    const cascade = (): void => nested.cancel();
    if (this.cancelled) nested.cancel();
    this.onCancel.add(cascade);
    try {
      return await run(nested);
    } finally {
      this.onCancel.delete(cascade);
    }
  }

  // `arm` starts the pause and returns how to disarm it; a cancel rejects it at once.
  private pause<T>(arm: (wake: (value: T) => void) => () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.cancelled) {
        reject(new RunCancelledError());
        return;
      }
      const settle = (): void => {
        disarm();
        this.onCancel.delete(abort);
      };
      const abort = (): void => {
        settle();
        reject(new RunCancelledError());
      };
      const disarm = arm((value) => {
        settle();
        resolve(value);
      });
      this.onCancel.add(abort);
    });
  }
}
