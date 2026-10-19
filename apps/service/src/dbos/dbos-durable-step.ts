import { DBOS, Error as DbosErrors } from '@dbos-inc/dbos-sdk';

import type { RuntimeRunStatus } from '../database/entities/runtime-run.entity';
import { DeterminismError, RunCancelledError, type DurableStep } from '../providers/durable-step';

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

  // Only `instanceof` on the live throw: DBOS names a step mismatch plain `Error`, and replays a recorded error as one.
  isFatal(err: unknown): boolean {
    return (
      this.isCancellation(err) ||
      err instanceof DbosErrors.DBOSUnexpectedStepError ||
      err instanceof DeterminismError
    );
  }

  // DBOS raises a cancel only at its next call.
  throwIfCancelled(): void {}

  cancelSeenOnRow(): Error {
    return new DbosErrors.DBOSWorkflowCancelledError(DBOS.workflowID ?? '');
  }
}

/** A workflow entered after its run ended: it stops before running anything, so it cannot rewrite that run. */
export class RunAlreadyEnded extends Error {
  constructor(status: RuntimeRunStatus) {
    super(`Run already ended ${status}`);
    this.name = 'RunAlreadyEnded';
  }
}

/**
 * One durable run's substrate, gated on its run row at every boundary: a cancel recorded there stops the run even
 * when DBOS never heard of it — cancelled before DBOS registered the run, or telling DBOS failed.
 */
export class RowGatedDurableStep implements DurableStep {
  private cancelled = false;

  constructor(
    private readonly inner: DurableStep,
    private readonly rowStatus: () => Promise<RuntimeRunStatus | null>,
  ) {}

  /** The gate at the workflow's entry, before the run writes anything: a run that already ended stays as it ended. */
  async admit(): Promise<void> {
    const status = await this.rowStatus();
    if (status === 'completed' || status === 'error') throw new RunAlreadyEnded(status);
    this.stopIf(status === 'cancelled');
  }

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

  cancelSeenOnRow(): Error {
    this.cancelled = true;
    return new RunCancelledError();
  }

  isCancellation(err: unknown): boolean {
    return this.inner.isCancellation(err) || (this.cancelled && err instanceof RunCancelledError);
  }

  isFatal(err: unknown): boolean {
    return this.isCancellation(err) || this.inner.isFatal(err);
  }

  private async gate(): Promise<void> {
    this.stopIf(this.cancelled || (await this.rowStatus()) === 'cancelled');
  }

  // Thrown outside any step: DBOS records the workflow ERROR, terminal, so no recovery runs it again.
  private stopIf(cancelled: boolean): void {
    if (!cancelled) return;
    this.cancelled = true;
    throw new RunCancelledError();
  }
}
