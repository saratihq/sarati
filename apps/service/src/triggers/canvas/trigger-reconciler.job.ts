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
      const on = await this.jobs.register(async (queues) => {
        await queues.createQueue(RECONCILE_QUEUE);
        // `short` keeps one waiting job per singleton key; createQueue leaves an existing queue's policy as it was.
        await queues.updateQueue(RECONCILE_QUEUE, { name: RECONCILE_QUEUE, policy: 'short' });
        await queues.work<{ workflowId: string }>(RECONCILE_QUEUE, async ([job]) => {
          if (job?.data?.workflowId) await this.reconciler.reconcile(job.data.workflowId);
        });
        await queues.createQueue(RECONCILE_SWEEP_QUEUE);
        await queues.work(RECONCILE_SWEEP_QUEUE, (_jobs, signal) => this.reconciler.sweepAll(signal));
        await queues.schedule(RECONCILE_SWEEP_QUEUE, SWEEP_CRON);
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
    await this.reconciler
      .reconcileStale()
      .catch((err: unknown) =>
        this.logger.error(`reconcile of stale trigger activations failed: ${errorMessage(err)}`),
      );
  }
}
