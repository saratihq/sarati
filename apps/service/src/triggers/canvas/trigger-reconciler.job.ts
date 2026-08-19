import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { errorMessage } from '../../common/error-message';
import { JobRegistry } from '../../jobs/jobs.module';
import { RECONCILE_QUEUE, RECONCILE_SWEEP_QUEUE } from '../trigger-signals.service';
import { TriggerReconcilerService } from './trigger-reconciler.service';

/** Periodic full-sweep cadence — the safety net that catches missed enqueues + provider drift. */
const SWEEP_CRON = '*/15 * * * *';

/**
 * Drives the trigger-activation reconciler as a pg-boss singleton: a per-workflow
 * queue plus a full-sweep schedule. With pg-boss OFF it is driven inline from the signal seam.
 */
@Injectable()
export class TriggerReconcilerJob implements OnModuleInit {
  private readonly logger = new Logger(TriggerReconcilerJob.name);

  constructor(
    private readonly jobs: JobRegistry,
    private readonly reconciler: TriggerReconcilerService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Always wire the inline path — it is the pg-boss-off fallback for pointer moves.
    this.reconciler.registerInline();

    try {
      const on = await this.jobs.register(async (boss) => {
        await boss.createQueue(RECONCILE_QUEUE);
        await boss.work<{ workflowId: string }>(RECONCILE_QUEUE, async ([job]) => {
          if (job?.data?.workflowId) await this.reconciler.reconcile(job.data.workflowId);
        });
        await boss.createQueue(RECONCILE_SWEEP_QUEUE);
        await boss.work(RECONCILE_SWEEP_QUEUE, async () => {
          await this.reconciler.sweepAll();
        });
        await boss.schedule(RECONCILE_SWEEP_QUEUE, SWEEP_CRON);
      });
      this.logger.log(
        on
          ? 'trigger reconciler scheduled (pg-boss singleton)'
          : 'trigger reconciler running inline (pg-boss disabled)',
      );
    } catch (err) {
      // The reconciler must never take the API down — log and continue serving.
      this.logger.error(`trigger reconciler setup failed: ${errorMessage(err)}`);
    }
  }
}
