import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type PgBoss from 'pg-boss';

import { errorMessage } from '../common/error-message';
import type { EnvConfig } from '../config/env.config';
import { PG_BOSS } from '../jobs/jobs.module';
import { RunReaperService } from './run-reaper.service';

const QUEUE = 'run-reap';

/** Schedules the run reaper on a pg-boss singleton (one instance reaps per tick); inert without pg-boss or with `RUN_MAX_DURATION_SECONDS=0`. */
@Injectable()
export class RunReaperJob implements OnModuleInit {
  private readonly logger = new Logger(RunReaperJob.name);

  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss | null,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    private readonly reaper: RunReaperService,
  ) {}

  async onModuleInit(): Promise<void> {
    const env = this.config.get('env', { infer: true });
    if (!this.boss || env.runMaxDurationSeconds <= 0) {
      this.logger.log('run reaper cron disabled (no pg-boss or RUN_MAX_DURATION_SECONDS=0)');
      return;
    }
    try {
      await this.boss.createQueue(QUEUE);
      await this.boss.work(QUEUE, async () => {
        const r = await this.reaper.reapStale();
        if (r.crashedRuns + r.timedOutWaits + r.orphanSteps > 0) {
          this.logger.warn(
            `reaped ${r.crashedRuns} crashed run(s), ${r.timedOutWaits} timed-out wait(s), ${r.orphanSteps} orphan step(s)`,
          );
        }
      });
      await this.boss.schedule(QUEUE, '*/5 * * * *');
      this.logger.log('run reaper scheduled every 5m (pg-boss singleton)');
    } catch (err) {
      // The reaper must never take the API down — log and continue serving.
      this.logger.error(`run reaper setup failed: ${errorMessage(err)}`);
    }
  }
}
