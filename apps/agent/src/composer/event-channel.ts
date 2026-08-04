/**
 * Single-consumer async push channel: the agent loop and the tool handlers
 * both push protocol events; the SSE writer consumes them in arrival order.
 * Needed because op_applied events originate INSIDE tool handlers, between
 * the SDK's own messages — a plain `for await` over the SDK stream can't
 * interleave them at the moment they happen.
 */
export class EventChannel<T> implements AsyncIterable<T> {
  // The consumer is a local socket write — the buffer stays tiny in practice.
  // The cap is a runaway guard (a wedged consumer must not OOM the process).
  private static readonly MAX_BUFFER = 10_000;

  private readonly buffer: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | null = null;
  private closed = false;

  /** Returns false when the channel is closed or the buffer cap was hit. */
  push(value: T): boolean {
    if (this.closed) return false;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value, done: false });
      return true;
    }
    if (this.buffer.length >= EventChannel.MAX_BUFFER) {
      this.close();
      return false;
    }
    this.buffer.push(value);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        if (this.waiter) return Promise.reject(new Error('EventChannel supports a single consumer'));
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiter = resolve;
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
