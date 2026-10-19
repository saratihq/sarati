import { DBOS, Error as DbosErrors } from '@dbos-inc/dbos-sdk';

import { RunCancelledError, type DurableStep } from '../providers/durable-step';

/** Whether a run's rejection is the cancel someone asked for, on either rail — not a failure. */
export function isDurableCancellation(err: unknown): boolean {
  return (
    err instanceof RunCancelledError ||
    err instanceof DbosErrors.DBOSWorkflowCancelledError ||
    err instanceof DbosErrors.DBOSAwaitedWorkflowCancelledError
  );
}

/**
 * `DurableStep` backed by DBOS: each step's result is checkpointed, so a resume returns the
 * memoized value rather than re-firing the side effect. Only meaningful inside a DBOS workflow.
 */
export class DbosDurableStep implements DurableStep {
  run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return DBOS.runStep(fn, { name });
  }

  sleep(_name: string, ms: number): Promise<void> {
    return DBOS.sleepms(ms);
  }

  /** DBOS durable receive: resumed by `DBOS.send(runId, payload, topic)` (DbosRuntime.sendEvent). */
  waitForEvent<T = unknown>(_name: string, topic: string, timeoutMs: number): Promise<T | null> {
    return DBOS.recv<T>(topic, timeoutMs / 1000);
  }

  // A step's body may not call DBOS, and DBOS raises a cancel only at its next call.
  waitInStep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  isCancellation(err: unknown): boolean {
    return err instanceof DbosErrors.DBOSWorkflowCancelledError;
  }

  // DBOS raises a cancel only at its next call.
  throwIfCancelled(): void {}
}

/**
 * One durable run's substrate, gated on its run row at every boundary: a cancel recorded there stops the run even
 * when DBOS never heard of it — cancelled before DBOS registered the run, or telling DBOS failed.
 */
export class RowGatedDurableStep implements DurableStep {
  private cancelled = false;

  constructor(
    private readonly inner: DbosDurableStep,
    private readonly cancelledRow: () => Promise<boolean>,
  ) {}

  async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    await this.gate();
    return this.inner.run(name, fn);
  }

  async sleep(name: string, ms: number): Promise<void> {
    await this.gate();
    return this.inner.sleep(name, ms);
  }

  async waitForEvent<T = unknown>(name: string, topic: string, timeoutMs: number): Promise<T | null> {
    await this.gate();
    return this.inner.waitForEvent<T>(name, topic, timeoutMs);
  }

  waitInStep(ms: number): Promise<void> {
    return this.inner.waitInStep(ms);
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new RunCancelledError();
  }

  isCancellation(err: unknown): boolean {
    return this.inner.isCancellation(err) || (this.cancelled && err instanceof RunCancelledError);
  }

  // Thrown outside any step: DBOS records the workflow ERROR, terminal, so no recovery runs it again.
  private async gate(): Promise<void> {
    if (!this.cancelled && !(await this.cancelledRow())) return;
    this.cancelled = true;
    throw new RunCancelledError();
  }
}
