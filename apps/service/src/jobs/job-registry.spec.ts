import { Logger } from '@nestjs/common';
import type PgBoss from 'pg-boss';

import { ShutdownDeadline } from '../common/shutdown-deadline';
import { JobRegistry } from './jobs.module';

const boss = {} as PgBoss;

type Fetched = (jobs: PgBoss.JobWithMetadata[]) => Promise<void>;

const fetchedJob = (name: string, over: Partial<PgBoss.JobWithMetadata> = {}): PgBoss.JobWithMetadata =>
  ({
    id: 'job',
    name,
    data: { workflowId: 'wf' },
    expireInSeconds: 900,
    priority: 0,
    retryLimit: 2,
    retryCount: 0,
    retryDelay: 0,
    retryBackoff: false,
    singletonKey: null,
    deadLetter: null,
    ...over,
  }) as unknown as PgBoss.JobWithMetadata;

// A pg-boss whose workers are the handlers the registry attaches, run when a test fetches a job for them.
function fakeBoss() {
  const workers = new Map<string, Fetched>();
  const fake = {
    work: jest.fn((name: string, _options: PgBoss.WorkOptions, handler: Fetched) => {
      workers.set(name, handler);
      return Promise.resolve(`worker-${name}`);
    }),
    offWork: jest.fn(() => Promise.resolve()),
    send: jest.fn(() => Promise.resolve('copy')),
  };
  const fetched = (name: string, job = fetchedJob(name)): Promise<void> => workers.get(name)!([job]);
  return {
    boss: fake as unknown as PgBoss,
    work: fake.work,
    offWork: fake.offWork,
    send: fake.send,
    fetched,
  };
}

function held() {
  let release!: () => void;
  const until = new Promise<void>((resolve) => (release = resolve));
  return { until, release };
}

describe('JobRegistry', () => {
  it('never runs two registrations at once', async () => {
    const registry = new JobRegistry(boss, new ShutdownDeadline());
    let inFlight = 0;
    let overlapped = false;

    const slow = async (): Promise<void> => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    };

    await Promise.all([registry.register(slow), registry.register(slow), registry.register(slow)]);

    expect(overlapped).toBe(false);
  });

  it('keeps the queue moving when one registration throws, and reports the failure to its caller', async () => {
    const registry = new JobRegistry(boss, new ShutdownDeadline());
    const order: string[] = [];

    const failing = registry.register(() => {
      order.push('first');
      return Promise.reject(new Error('deadlock detected'));
    });
    const following = registry.register(() => {
      order.push('second');
      return Promise.resolve();
    });

    await expect(failing).rejects.toThrow('deadlock detected');
    await expect(following).resolves.toBe(true);
    expect(order).toEqual(['first', 'second']);
  });

  it('reports false without running anything when jobs are switched off', async () => {
    const registry = new JobRegistry(null, new ShutdownDeadline());
    const run = jest.fn();

    await expect(registry.register(run)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('attaches no worker until it is started, and every one registered by then once it is', async () => {
    const { boss: pgBoss, work } = fakeBoss();
    const registry = new JobRegistry(pgBoss, new ShutdownDeadline());
    await registry.register(async (queues) => {
      await queues.work('early', () => Promise.resolve());
    });
    expect(work).not.toHaveBeenCalled();

    await registry.start();
    expect(work.mock.calls.map(([name]) => name)).toEqual(['early']);

    await registry.register((queues) => queues.work('late', () => Promise.resolve()));
    expect(work.mock.calls.map(([name]) => name)).toEqual(['early', 'late']);
  });

  it('at a stop, stops every worker fetching, aborts its handlers, and waits for one still running', async () => {
    const { boss: pgBoss, offWork, fetched } = fakeBoss();
    const registry = new JobRegistry(pgBoss, new ShutdownDeadline());
    const job = held();
    let signal: AbortSignal | undefined;
    await registry.register(async (queues) => {
      await queues.work('held', async (_jobs, aborted) => {
        signal = aborted;
        await job.until;
      });
      await queues.work('idle', () => Promise.resolve());
    });
    await registry.start();
    const running = fetched('held');

    let drained = false;
    const draining = registry.beforeApplicationShutdown().then(() => {
      drained = true;
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(offWork.mock.calls).toEqual([['held'], ['idle']]);
    expect(signal?.aborted).toBe(true);
    expect(drained).toBe(false);
    job.release();
    await draining;
    await expect(running).resolves.toBeUndefined();
  });

  it('hands a job fetched once the stop has begun back to its queue as a copy with the retries it had left, so the one fetched completes', async () => {
    const { boss: pgBoss, fetched, send } = fakeBoss();
    const registry = new JobRegistry(pgBoss, new ShutdownDeadline());
    const handler = jest.fn(() => Promise.resolve());
    await registry.register((queues) => queues.work('late', handler));
    await registry.start();

    await registry.beforeApplicationShutdown();

    await expect(
      fetched(
        'late',
        fetchedJob('late', { retryLimit: 3, retryCount: 1, singletonKey: 'wf', priority: 2, retryDelay: 5 }),
      ),
    ).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      'late',
      { workflowId: 'wf' },
      {
        priority: 2,
        retryLimit: 2,
        retryDelay: 5,
        retryBackoff: false,
        expireInSeconds: 900,
        singletonKey: 'wf',
      },
    );
  });

  it('fails a job fetched once the stop has begun that it cannot hand back, so pg-boss keeps it, and says which', async () => {
    const { boss: pgBoss, fetched, send } = fakeBoss();
    send.mockRejectedValueOnce(new Error('Cannot use a pool after calling end on the pool'));
    const registry = new JobRegistry(pgBoss, new ShutdownDeadline());
    await registry.register((queues) => queues.work('late', () => Promise.resolve()));
    await registry.start();
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await registry.beforeApplicationShutdown();

    await expect(fetched('late')).rejects.toThrow('Cannot use a pool after calling end on the pool');
    expect(logged).toHaveBeenCalledWith(
      'Shutting down: could not hand late job job back to its queue, so pg-boss fails it: Cannot use a pool after calling end on the pool',
    );
    logged.mockRestore();
  });

  it('stops waiting at the shutdown deadline and names the queue whose job is still running', async () => {
    const { boss: pgBoss, fetched } = fakeBoss();
    const deadline = {
      remainingMs: () => 20,
      signal: new AbortController().signal,
    } as unknown as ShutdownDeadline;
    const registry = new JobRegistry(pgBoss, deadline);
    await registry.register((queues) => queues.work('stuck', () => new Promise<void>(() => undefined)));
    await registry.start();
    void fetched('stuck');
    const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await registry.beforeApplicationShutdown();

    expect(warned).toHaveBeenCalledWith(
      'Shutting down: stopped waiting for job(s) still running 8000 ms into the stop: stuck',
    );
    warned.mockRestore();
  });
});
