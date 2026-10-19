import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type PgBoss from 'pg-boss';

import type { EnvConfig } from '../config/env.config';
import { JobRegistry } from '../jobs/jobs.module';
import { RunReaperJob } from './run-reaper.job';
import type { RunReaperService } from './run-reaper.service';

describe('RunReaperJob', () => {
  it('logs a pass that throws on a cron tick, and still fails the job', async () => {
    let tick: (() => Promise<void>) | undefined;
    const boss = {
      createQueue: jest.fn().mockResolvedValue(undefined),
      work: jest.fn((_queue: string, handler: () => Promise<void>) => {
        tick = handler;
        return Promise.resolve('worker');
      }),
      schedule: jest.fn().mockResolvedValue(undefined),
    } as unknown as PgBoss;
    const config = {
      get: () => ({ runMaxDurationSeconds: 3600 }),
    } as unknown as ConfigService<{ env: EnvConfig }, true>;
    const reaper = {
      reapStale: jest.fn().mockRejectedValue(new Error('deadlock detected')),
    } as unknown as RunReaperService;
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await new RunReaperJob(new JobRegistry(boss), config, reaper).onModuleInit();
    await expect(tick!()).rejects.toThrow('deadlock detected');

    expect(logged).toHaveBeenCalledWith('run reap failed: deadlock detected');
    logged.mockRestore();
  });
});
