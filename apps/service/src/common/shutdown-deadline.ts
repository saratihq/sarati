import { Injectable } from '@nestjs/common';

/** How long a stop waits, all told, for work in flight: inside the 10 s Docker gives by default a container whose process is the service. */
export const SHUTDOWN_WAIT_MS = 8_000;

/** Work refused because the service is stopping; what it would have done is left to the next boot. */
export class ShuttingDown extends Error {
  constructor() {
    super('the service is stopping');
    this.name = 'ShuttingDown';
  }
}

/** Settles as `work` does, or rejects with {@link ShuttingDown} once `signal` aborts; `work` goes on, its settling still handled. */
export function untilStopping<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(new ShuttingDown());
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** The one deadline every wait of a stop shares, {@link SHUTDOWN_WAIT_MS} after the stop began, and the signal that it has begun. */
@Injectable()
export class ShutdownDeadline {
  private readonly stop = new AbortController();
  private at: number | undefined;

  /** Aborted, with {@link ShuttingDown}, as the stop begins. */
  get signal(): AbortSignal {
    return this.stop.signal;
  }

  /** The milliseconds left until the deadline; the first call begins the stop, starting the deadline and aborting the signal. */
  remainingMs(): number {
    const now = Date.now();
    if (this.at === undefined) {
      this.at = now + SHUTDOWN_WAIT_MS;
      this.stop.abort(new ShuttingDown());
    }
    return Math.max(0, this.at - now);
  }
}
