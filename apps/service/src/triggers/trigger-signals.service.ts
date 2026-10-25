import { Inject, Injectable, Logger } from '@nestjs/common';
import type PgBoss from 'pg-boss';

import { errorMessage } from '../common/error-message';
import { PG_BOSS } from '../jobs/jobs.module';

/** pg-boss queue that reconciles ONE workflow's trigger activations (payload: `{ workflowId }`), at most one job per workflow waiting. */
export const RECONCILE_QUEUE = 'trigger-reconcile';
/** pg-boss queue that reconciles ALL workflows — the periodic safety-net full sweep. */
export const RECONCILE_SWEEP_QUEUE = 'trigger-reconcile-sweep';

/** At most this many queued inline reconciles run at once, so a burst cannot run the database pool dry. */
const INLINE_CONCURRENCY = 5;

/** The reconcile handler the signal seam drives inline when pg-boss is off. */
export type InlineReconcile = (workflowId: string) => Promise<void>;

/**
 * The pointer/slot-move → reconcile SIGNAL seam: the signal carries only a workflow
 * id, and the reconcile recomputes that workflow's whole desired set. MUST stay dependency-light
 * (PG_BOSS only) — workflows/environments depend on it, so importing the trigger layer would
 * be a module cycle. With pg-boss off it runs inline via a handler registered at boot.
 */
@Injectable()
export class TriggerSignalsService {
  private readonly logger = new Logger(TriggerSignalsService.name);
  private inline: InlineReconcile | null = null;
  private readonly waiting: string[] = [];
  private readonly running = new Set<string>();

  constructor(@Inject(PG_BOSS) private readonly boss: PgBoss | null) {}

  /** The trigger layer wires its reconciler here at boot (registered in every mode). */
  registerInline(handler: InlineReconcile): void {
    this.inline = handler;
    this.drain();
  }

  /**
   * Reconcile `workflowId` and WAIT for it — for a caller that has to report the activation state
   * it just created, rather than assert one. Falls back to the queue when no handler is wired.
   */
  async reconcileNow(workflowId: string): Promise<void> {
    if (!this.inline) return this.enqueue(workflowId);
    try {
      await this.inline(workflowId);
    } catch (err) {
      // The row's `last_error` is what the caller reports; this line is for the operator.
      this.logger.warn(`reconcile of ${workflowId} failed: ${errorMessage(err)}`);
    }
  }

  /**
   * Enqueue a reconcile of `workflowId` — best-effort, so a failure never breaks the move that
   * triggered it. Call AFTER the move's transaction commits, so the reconcile reads new pointers.
   */
  async enqueue(workflowId: string): Promise<void> {
    try {
      if (this.boss) {
        // A reconcile reads the state when it starts, so one waiting job per workflow covers every change before it.
        await this.boss.send(RECONCILE_QUEUE, { workflowId }, { singletonKey: workflowId });
        return;
      }
      // Fire-and-forget: the caller must not block on provider registration.
      if (!this.waiting.includes(workflowId)) this.waiting.push(workflowId);
      this.drain();
    } catch (err) {
      this.logger.warn(`enqueue reconcile of ${workflowId} failed: ${errorMessage(err)}`);
    }
  }

  private drain(): void {
    const inline = this.inline;
    for (let next = this.nextWaiting(); inline && next >= 0; next = this.nextWaiting()) {
      const [workflowId] = this.waiting.splice(next, 1) as [string];
      this.running.add(workflowId);
      void inline(workflowId)
        .catch((err: unknown) =>
          this.logger.warn(`inline reconcile of ${workflowId} failed: ${errorMessage(err)}`),
        )
        .finally(() => {
          this.running.delete(workflowId);
          this.drain();
        });
    }
  }

  // A workflow being reconciled keeps its one waiting entry until that reconcile ends, as the queue keeps one job.
  private nextWaiting(): number {
    if (this.running.size >= INLINE_CONCURRENCY) return -1;
    return this.waiting.findIndex((workflowId) => !this.running.has(workflowId));
  }
}
