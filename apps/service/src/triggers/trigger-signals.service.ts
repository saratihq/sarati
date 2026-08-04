import { Inject, Injectable, Logger } from '@nestjs/common';
import type PgBoss from 'pg-boss';

import { errorMessage } from '../common/error-message';
import { PG_BOSS } from '../jobs/jobs.module';

/** pg-boss queue that reconciles ONE workflow's trigger activations (payload: `{ workflowId }`). */
export const RECONCILE_QUEUE = 'trigger-reconcile';
/** pg-boss queue that reconciles ALL workflows — the periodic safety-net full sweep. */
export const RECONCILE_SWEEP_QUEUE = 'trigger-reconcile-sweep';

/** The reconcile handler the signal seam drives inline when pg-boss is off. */
export type InlineReconcile = (workflowId: string) => Promise<void>;

/**
 * The pointer/slot-move → reconcile SIGNAL seam (ADR 0018): the signal carries only a workflow
 * id, and the reconcile recomputes that workflow's whole desired set. MUST stay dependency-light
 * (PG_BOSS only) — workflows/environments depend on it, so importing the trigger layer would
 * be a module cycle. With pg-boss off it runs inline via a handler registered at boot.
 */
@Injectable()
export class TriggerSignalsService {
  private readonly logger = new Logger(TriggerSignalsService.name);
  private inline: InlineReconcile | null = null;

  constructor(@Inject(PG_BOSS) private readonly boss: PgBoss | null) {}

  /** The trigger layer wires its reconciler here at boot (used only when pg-boss is off). */
  registerInline(handler: InlineReconcile): void {
    this.inline = handler;
  }

  /**
   * Enqueue a reconcile of `workflowId` — best-effort, so a failure never breaks the move that
   * triggered it. Call AFTER the move's transaction commits, so the reconcile reads new pointers.
   */
  async enqueue(workflowId: string): Promise<void> {
    try {
      if (this.boss) {
        await this.boss.send(RECONCILE_QUEUE, { workflowId });
        return;
      }
      if (this.inline) {
        // Fire-and-forget: the caller must not block on provider registration.
        void this.inline(workflowId).catch((err) =>
          this.logger.warn(`inline reconcile of ${workflowId} failed: ${errorMessage(err)}`),
        );
      }
    } catch (err) {
      this.logger.warn(`enqueue reconcile of ${workflowId} failed: ${errorMessage(err)}`);
    }
  }
}
