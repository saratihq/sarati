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
}
