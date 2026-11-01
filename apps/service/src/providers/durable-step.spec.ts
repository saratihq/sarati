import { PassThroughDurableStep, type EventWait, type ParkHooks } from './durable-step';

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
