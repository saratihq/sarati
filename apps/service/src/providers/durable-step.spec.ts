import { WAKE_POLL_MS } from '../runtime/timer-wait';
import { PassThroughDurableStep, type EventWait, type Park, type ParkHooks } from './durable-step';

const wait = (topic: string): EventWait => ({
  name: topic,
  stepKey: topic,
  topic,
  deliveryTopic: null,
  timeoutMs: 600_000,
});
const recorded: ParkHooks = { parked: () => Promise.resolve(null), resumed: () => Promise.resolve() };
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe('PassThroughDurableStep.parked', () => {
  const made: PassThroughDurableStep[] = [];
  const substrate = (): PassThroughDurableStep => {
    const durable = new PassThroughDurableStep();
    made.push(durable);
    return durable;
  };

  // A run a failed assertion leaves parked is cancelled after it, so its rejection is expected.
  const rooted = <T>(durable: PassThroughDurableStep, fn: () => Promise<T>): Promise<T> => {
    const run = durable.root(fn);
    run.catch(() => undefined);
    return run;
  };

  afterEach(() => {
    for (const durable of made.splice(0)) durable.cancel();
  });

  it('is parked once its one lane waits on an event, and not before the park is recorded nor after it is answered', async () => {
    const durable = substrate();
    const recording = deferred();
    const run = rooted(durable, () =>
      durable.waitForEvent(wait('approval'), {
        ...recorded,
        parked: () => recording.promise.then(() => null),
      }),
    );
    expect(durable.parked()).toBe(false);
    await settled();
    expect(durable.parked()).toBe(false);

    recording.resolve();
    await settled();
    expect(durable.parked()).toBe(true);

    expect(durable.deliver('approval', { ok: true })).toBe(true);
    await expect(run).resolves.toEqual({ ok: true });
    expect(durable.parked()).toBe(false);
  });

  it('is not parked while one lane runs a step beside a lane waiting on an event, and is once that step ends', async () => {
    const durable = substrate();
    const step = deferred();
    const run = rooted(durable, async () => {
      const waiting = durable.spawn(() => durable.waitForEvent(wait('approval'), recorded));
      const working = durable.spawn(() => durable.run('work', () => step.promise));
      return durable.joinAll([waiting, working]);
    });
    await settled();
    expect(durable.parked()).toBe(false);

    step.resolve();
    await settled();
    expect(durable.parked()).toBe(true);

    durable.deliver('approval', null);
    await run;
    expect(durable.parked()).toBe(false);
  });

  it('is parked while the lane that started a waiting lane waits for whichever of its lanes ends next', async () => {
    const durable = substrate();
    const step = deferred();
    const run = rooted(durable, async () => {
      const waiting = durable.spawn(() => durable.waitForEvent(wait('approval'), recorded));
      const working = durable.spawn(() => durable.run('work', () => step.promise));
      await durable.joinAny([waiting, working]);
      return durable.joinAny([waiting]);
    });
    await settled();
    expect(durable.parked()).toBe(false);

    step.resolve();
    await settled();
    expect(durable.parked()).toBe(true);

    durable.deliver('approval', 'yes');
    await expect(run).resolves.toMatchObject({ outcome: { ok: true, value: 'yes' } });
    expect(durable.parked()).toBe(false);
  });

  it('waits out a short delay, and parks on a long one', async () => {
    const short = substrate();
    const shortRun = rooted(short, () => short.delay({ name: 'short', stepKey: 'short', ms: 20 }, recorded));
    await settled();
    expect(short.parked()).toBe(false);
    await shortRun;

    const long = substrate();
    const longRun = rooted(long, () => long.delay({ name: 'long', stepKey: 'long', ms: 600_000 }, recorded));
    await settled();
    expect(long.parked()).toBe(true);
    long.cancel();
    await expect(longRun).rejects.toThrow('Run was cancelled');
  });

  it('counts a lane whose step waits on a nested run as parked only while that run is parked', async () => {
    const durable = substrate();
    let inner: PassThroughDurableStep | undefined;
    const recording = deferred();
    const run = rooted(durable, () =>
      durable.run('call', () =>
        durable.nest((nested) => {
          inner = nested;
          return nested.root(() =>
            nested.waitForEvent(wait('approval'), {
              ...recorded,
              parked: () => recording.promise.then(() => null),
            }),
          );
        }),
      ),
    );
    await settled();
    expect(durable.parked()).toBe(false);

    recording.resolve();
    await settled();
    expect(durable.parked()).toBe(true);

    inner!.deliver('approval', 'yes');
    await expect(run).resolves.toBe('yes');
    expect(durable.parked()).toBe(false);
  });
});

describe('PassThroughDurableStep.waitForEvent, with a timeout longer than one timer can hold', () => {
  const T0 = Date.parse('2026-11-01T09:00:00.000Z');
  const MONTH = 30 * 24 * 3_600_000;

  beforeEach(() => jest.useFakeTimers({ now: T0 }));
  afterEach(() => jest.useRealTimers());

  const waiting = (durable: PassThroughDurableStep): { run: Promise<unknown>; ended: () => boolean } => {
    let ended = false;
    const run = durable.root(() => durable.waitForEvent({ ...wait('approval'), timeoutMs: MONTH }, recorded));
    run.then(
      () => (ended = true),
      () => (ended = true),
    );
    return { run, ended: () => ended };
  };

  it('still takes its event once its timer has re-armed at its polls', async () => {
    const durable = new PassThroughDurableStep();
    const { run, ended } = waiting(durable);
    await jest.advanceTimersByTimeAsync(3 * WAKE_POLL_MS);
    expect(ended()).toBe(false);

    expect(durable.deliver('approval', { ok: true })).toBe(true);
    await expect(run).resolves.toEqual({ ok: true });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('times out when the wall clock reaches its timeout, though its timer fell behind that clock', async () => {
    const { run, ended } = waiting(new PassThroughDurableStep());
    await jest.advanceTimersByTimeAsync(0);
    jest.setSystemTime(T0 + MONTH - 15_000);
    await jest.advanceTimersByTimeAsync(WAKE_POLL_MS);
    expect(ended()).toBe(false);

    await jest.advanceTimersByTimeAsync(4_999);
    expect(ended()).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(run).resolves.toBeNull();
  });
});

describe('PassThroughDurableStep.delay, parked', () => {
  const T0 = Date.parse('2026-11-01T09:00:00.000Z');
  const MINUTE_AND_A_SECOND = 61_000;

  beforeEach(() => jest.useFakeTimers({ now: T0 }));
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  /** A delay whose park write takes `write.ms` and then answers the deadline `write.kept` says history keeps. */
  const parkedDelay = (
    durable: PassThroughDurableStep,
    ms: number,
    write: { ms: number; kept: () => Date | null } = { ms: 0, kept: () => null },
  ): { run: Promise<Date | null>; parks: Park[]; ended: () => boolean } => {
    const parks: Park[] = [];
    let ended = false;
    const run = durable.root(() =>
      durable.delay(
        { name: 'pause', stepKey: 'pause', ms },
        {
          parked: (park) => {
            parks.push(park);
            return write.ms > 0
              ? new Promise((resolve) => setTimeout(() => resolve(write.kept()), write.ms))
              : Promise.resolve(write.kept());
          },
          resumed: () => Promise.resolve(),
        },
      ),
    );
    run.then(
      () => (ended = true),
      () => (ended = true),
    );
    return { run, parks, ended: () => ended };
  };

  it.each([
    ['written late, and history answers another deadline', () => new Date(Date.now() + MINUTE_AND_A_SECOND)],
    ['lost', () => null],
  ])('hands history the deadline it armed, and reports that one, when its park is %s', async (_, kept) => {
    const { run, parks } = parkedDelay(new PassThroughDurableStep(), MINUTE_AND_A_SECOND, {
      ms: 3_000,
      kept,
    });
    await jest.advanceTimersByTimeAsync(MINUTE_AND_A_SECOND);
    await expect(run).resolves.toEqual(new Date(T0 + MINUTE_AND_A_SECOND));
    expect(parks.map((park) => park.due)).toEqual([new Date(T0 + MINUTE_AND_A_SECOND)]);
  });

  it('never wakes before the wall-clock time it is due, though its timer runs ahead of that clock', async () => {
    const { run, ended } = parkedDelay(new PassThroughDurableStep(), MINUTE_AND_A_SECOND);
    await jest.advanceTimersByTimeAsync(0);
    jest.setSystemTime(Date.now() - 50);
    await jest.advanceTimersByTimeAsync(MINUTE_AND_A_SECOND);
    expect(Date.now()).toBe(T0 + MINUTE_AND_A_SECOND - 50);
    expect(ended()).toBe(false);

    await jest.advanceTimersByTimeAsync(50);
    await expect(run).resolves.toEqual(new Date(T0 + MINUTE_AND_A_SECOND));
  });

  it('wakes within a poll once the wall clock passes its due, though its timer fell behind that clock', async () => {
    const day = 24 * 3_600_000;
    const { run, ended } = parkedDelay(new PassThroughDurableStep(), day);
    await jest.advanceTimersByTimeAsync(WAKE_POLL_MS / 2);
    jest.setSystemTime(T0 + day + 8 * 3_600_000);
    expect(ended()).toBe(false);

    await jest.advanceTimersByTimeAsync(WAKE_POLL_MS);
    await expect(run).resolves.toEqual(new Date(T0 + day));
  });

  it('sleeps out a delay longer than one timer can hold, re-reading the clock no more than once a poll', async () => {
    const month = 30 * 24 * 3_600_000;
    const timeouts = jest.spyOn(global, 'setTimeout');
    const { ended } = parkedDelay(new PassThroughDurableStep(), month);
    await jest.advanceTimersByTimeAsync(3 * WAKE_POLL_MS);
    expect(timeouts).toHaveBeenCalledTimes(4);
    expect(jest.getTimerCount()).toBe(1);
    expect(ended()).toBe(false);
  });

  it('ends with the cancel when the run is cancelled while its park is still being written', async () => {
    const durable = new PassThroughDurableStep();
    const { run } = parkedDelay(durable, MINUTE_AND_A_SECOND, { ms: 3_000, kept: () => null });
    await jest.advanceTimersByTimeAsync(1_000);
    durable.cancel();
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(run).rejects.toThrow('Run was cancelled');
  });

  it.each([
    [
      'its timer re-armed at its polls',
      30 * 24 * 3_600_000,
      () => jest.advanceTimersByTimeAsync(3 * WAKE_POLL_MS),
    ],
    [
      'its timer ran ahead of the wall clock and re-armed for what was left',
      MINUTE_AND_A_SECOND,
      async () => {
        await jest.advanceTimersByTimeAsync(0);
        jest.setSystemTime(Date.now() - 50);
        await jest.advanceTimersByTimeAsync(MINUTE_AND_A_SECOND);
      },
    ],
  ])('ends with the cancel and leaves no timer behind once %s', async (_, ms, rearm) => {
    const durable = new PassThroughDurableStep();
    const timeouts = jest.spyOn(global, 'setTimeout');
    const { run, ended } = parkedDelay(durable, ms);
    await rearm();
    expect(timeouts.mock.calls.length).toBeGreaterThan(1);
    expect(ended()).toBe(false);

    durable.cancel();
    await expect(run).rejects.toThrow('Run was cancelled');
    expect(jest.getTimerCount()).toBe(0);
  });
});
