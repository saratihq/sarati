import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type PgBoss from 'pg-boss';

import { errorMessage } from '../common/error-message';
import type { EnvConfig } from '../config/env.config';
import { PG_BOSS } from '../jobs/jobs.module';
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
    @Inject(PG_BOSS) private readonly boss: PgBoss | null,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    private readonly triggers: TriggersService,
  ) {}

  async onModuleInit(): Promise<void> {
    const env = this.config.get('env', { infer: true });
    if (!this.boss || env.triggerPollIntervalSeconds <= 0) {
      this.logger.log('trigger poller disabled');
      return;
    }

    const minutes = Math.max(1, Math.round(env.triggerPollIntervalSeconds / 60));
    try {
      await this.boss.createQueue(QUEUE);
      await this.boss.work(QUEUE, async () => {
        await this.triggers.runActivationPollCycle();
      });
      await this.boss.schedule(QUEUE, `*/${minutes} * * * *`);
      this.logger.log(`trigger poller scheduled every ${minutes}m (pg-boss singleton)`);
    } catch (err) {
      // The poller must never take the API down — log and continue serving.
      this.logger.error(`trigger poller setup failed: ${errorMessage(err)}`);
    }
  }
}
