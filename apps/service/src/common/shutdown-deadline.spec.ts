import { SHUTDOWN_WAIT_MS, ShutdownDeadline, ShuttingDown, untilStopping } from './shutdown-deadline';

describe('ShutdownDeadline', () => {
  afterEach(() => jest.useRealTimers());

  it('counts every wait of a stop against one deadline, 8 s after the stop began', () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const deadline = new ShutdownDeadline();
    expect(deadline.remainingMs()).toBe(SHUTDOWN_WAIT_MS);

    jest.advanceTimersByTime(3_000);
    expect(deadline.remainingMs()).toBe(SHUTDOWN_WAIT_MS - 3_000);
    jest.advanceTimersByTime(1_000);
    expect(deadline.remainingMs()).toBe(SHUTDOWN_WAIT_MS - 4_000);
    jest.advanceTimersByTime(SHUTDOWN_WAIT_MS);
    expect(deadline.remainingMs()).toBe(0);
  });

  it('aborts its signal with ShuttingDown as the stop begins, and not before', () => {
    const deadline = new ShutdownDeadline();
    expect(deadline.signal.aborted).toBe(false);

    deadline.remainingMs();
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toBeInstanceOf(ShuttingDown);
  });
});

describe('untilStopping', () => {
  it('settles as the work does while nothing stops it', async () => {
    const stop = new AbortController();
    await expect(untilStopping(Promise.resolve('done'), stop.signal)).resolves.toBe('done');
    await expect(untilStopping(Promise.reject(new Error('failed')), stop.signal)).rejects.toThrow('failed');
  });

  it('stops waiting once the stop begins, and the work it leaves failing later raises no unhandled rejection', async () => {
    const stop = new AbortController();
    let fail!: (err: Error) => void;
    const work = new Promise<string>((_, reject) => (fail = reject));
    const waiting = untilStopping(work, stop.signal);

    stop.abort();
    await expect(waiting).rejects.toBeInstanceOf(ShuttingDown);
    fail(new Error('failed after the stop'));
    await new Promise((r) => setImmediate(r));
  });

  it('refuses at once once the stop has begun', async () => {
    await expect(untilStopping(new Promise(() => undefined), AbortSignal.abort())).rejects.toBeInstanceOf(
      ShuttingDown,
    );
  });
});
