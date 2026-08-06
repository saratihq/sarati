import type PgBoss from 'pg-boss';

import { JobRegistry } from './jobs.module';

const boss = {} as PgBoss;

describe('JobRegistry', () => {
  it('never runs two registrations at once', async () => {
    const registry = new JobRegistry(boss);
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
    const registry = new JobRegistry(boss);
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
    const registry = new JobRegistry(null);
    const run = jest.fn();

    await expect(registry.register(run)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
