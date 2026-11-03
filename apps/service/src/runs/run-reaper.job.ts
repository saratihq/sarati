import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { errorMessage } from '../common/error-message';
import { JobRegistry } from '../jobs/jobs.module';
import { RunReaperService } from './run-reaper.service';

const QUEUE = 'run-reap';

/** Schedules the run reaper on a pg-boss singleton (one instance reaps per tick); inert without pg-boss. */
@Injectable()
export class RunReaperJob implements OnModuleInit {
  private readonly logger = new Logger(RunReaperJob.name);

  constructor(
    private readonly jobs: JobRegistry,
    private readonly reaper: RunReaperService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const on = await this.jobs.register(async (queues) => {
        await queues.createQueue(QUEUE);
        await queues.work(QUEUE, (_jobs, signal) => this.tick(signal));
        await queues.schedule(QUEUE, '*/5 * * * *');
      });
      this.logger.log(
        on ? 'run reaper scheduled every 5m (pg-boss singleton)' : 'run reaper cron disabled (no pg-boss)',
      );
    } catch (err) {
      // The reaper must never take the API down — log and continue serving.
      this.logger.error(`run reaper setup failed: ${errorMessage(err)}`);
    }
  }

  // A failed pass is logged and still fails the job, so pg-boss records it.
  private async tick(signal: AbortSignal): Promise<void> {
    try {
      const r = await this.reaper.reapStale(signal);
      if (r.stoppedRuns + r.crashedRuns + r.timedOutWaits + r.orphanSteps + r.strandedDecisions > 0) {
        this.logger.warn(
          `stopped ${r.stoppedRuns} run(s) past their time limit, reaped ${r.crashedRuns} crashed run(s), ${r.timedOutWaits} timed-out wait(s), ` +
            `${r.orphanSteps} orphan step(s), ${r.strandedDecisions} stranded decision(s)`,
        );
      }
    } catch (err) {
      this.logger.error(`run reap failed: ${errorMessage(err)}`);
      throw err;
    }
  }
}
