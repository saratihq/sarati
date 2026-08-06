import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { errorMessage } from '../common/error-message';
import type { EnvConfig } from '../config/env.config';
import { JobRegistry } from '../jobs/jobs.module';
import { RunReaperService } from './run-reaper.service';

const QUEUE = 'run-reap';

/** Schedules the run reaper on a pg-boss singleton (one instance reaps per tick); inert without pg-boss or with `RUN_MAX_DURATION_SECONDS=0`. */
@Injectable()
export class RunReaperJob implements OnModuleInit {
  private readonly logger = new Logger(RunReaperJob.name);

  constructor(
    private readonly jobs: JobRegistry,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    private readonly reaper: RunReaperService,
  ) {}

  async onModuleInit(): Promise<void> {
    const env = this.config.get('env', { infer: true });
    if (env.runMaxDurationSeconds <= 0) {
      this.logger.log('run reaper cron disabled (no pg-boss or RUN_MAX_DURATION_SECONDS=0)');
      return;
    }
    try {
      const on = await this.jobs.register(async (boss) => {
        await boss.createQueue(QUEUE);
        await boss.work(QUEUE, async () => {
          const r = await this.reaper.reapStale();
          if (r.crashedRuns + r.timedOutWaits + r.orphanSteps > 0) {
            this.logger.warn(
              `reaped ${r.crashedRuns} crashed run(s), ${r.timedOutWaits} timed-out wait(s), ${r.orphanSteps} orphan step(s)`,
            );
          }
        });
        await boss.schedule(QUEUE, '*/5 * * * *');
      });
      this.logger.log(
        on ? 'run reaper scheduled every 5m (pg-boss singleton)' : 'run reaper cron disabled (no pg-boss)',
      );
    } catch (err) {
      // The reaper must never take the API down — log and continue serving.
      this.logger.error(`run reaper setup failed: ${errorMessage(err)}`);
    }
  }
}
