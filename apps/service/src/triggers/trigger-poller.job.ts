import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { errorMessage } from '../common/error-message';
import type { EnvConfig } from '../config/env.config';
import { JobRegistry } from '../jobs/jobs.module';
import { TriggersService } from './triggers.service';

const QUEUE = 'trigger-poll';

/**
 * Schedules the runtime trigger poll as a pg-boss singleton (distributed-lock-safe across
 * replicas). Interval from TRIGGER_POLL_INTERVAL_SECONDS (0 disables), floored at 1 minute.
 */
@Injectable()
export class TriggerPollerJob implements OnModuleInit {
  private readonly logger = new Logger(TriggerPollerJob.name);

  constructor(
    private readonly jobs: JobRegistry,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    private readonly triggers: TriggersService,
  ) {}

  async onModuleInit(): Promise<void> {
    const env = this.config.get('env', { infer: true });
    if (env.triggerPollIntervalSeconds <= 0) {
      this.logger.log('trigger poller disabled');
      return;
    }

    const minutes = Math.max(1, Math.round(env.triggerPollIntervalSeconds / 60));
    try {
      const on = await this.jobs.register(async (boss) => {
        await boss.createQueue(QUEUE);
        await boss.work(QUEUE, async () => {
          await this.triggers.runActivationPollCycle();
        });
        await boss.schedule(QUEUE, `*/${minutes} * * * *`);
      });
      this.logger.log(
        on ? `trigger poller scheduled every ${minutes}m (pg-boss singleton)` : 'trigger poller disabled',
      );
    } catch (err) {
      // Scheduled and polling triggers do not fire without this — loud, but the API stays up.
      this.logger.error(`trigger poller setup failed, SCHEDULES WILL NOT FIRE: ${errorMessage(err)}`);
    }
  }
}
