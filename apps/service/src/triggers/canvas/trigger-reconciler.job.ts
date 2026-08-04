import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type PgBoss from 'pg-boss';

import { errorMessage } from '../../common/error-message';
import { PG_BOSS } from '../../jobs/jobs.module';
import { RECONCILE_QUEUE, RECONCILE_SWEEP_QUEUE } from '../trigger-signals.service';
import { TriggerReconcilerService } from './trigger-reconciler.service';

/** Periodic full-sweep cadence — the safety net that catches missed enqueues + provider drift. */
const SWEEP_CRON = '*/15 * * * *';

/**
 * Drives the trigger-activation reconciler (ADR 0018) as a pg-boss singleton: a per-workflow
 * queue plus a full-sweep schedule. With pg-boss OFF it is driven inline from the signal seam.
 */
@Injectable()
export class TriggerReconcilerJob implements OnModuleInit {
  private readonly logger = new Logger(TriggerReconcilerJob.name);

  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss | null,
    private readonly reconciler: TriggerReconcilerService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Always wire the inline path — it is the pg-boss-off fallback for pointer moves.
    this.reconciler.registerInline();

    if (!this.boss) {
      this.logger.log('trigger reconciler running inline (pg-boss disabled)');
      return;
    }
    try {
      await this.boss.createQueue(RECONCILE_QUEUE);
      await this.boss.work<{ workflowId: string }>(RECONCILE_QUEUE, async ([job]) => {
        if (job?.data?.workflowId) await this.reconciler.reconcile(job.data.workflowId);
      });
      await this.boss.createQueue(RECONCILE_SWEEP_QUEUE);
      await this.boss.work(RECONCILE_SWEEP_QUEUE, async () => {
        await this.reconciler.sweepAll();
      });
      await this.boss.schedule(RECONCILE_SWEEP_QUEUE, SWEEP_CRON);
      this.logger.log('trigger reconciler scheduled (pg-boss singleton)');
    } catch (err) {
      // The reconciler must never take the API down — log and continue serving.
      this.logger.error(`trigger reconciler setup failed: ${errorMessage(err)}`);
    }
  }
}
