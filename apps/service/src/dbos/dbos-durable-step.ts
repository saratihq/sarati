import { DBOS } from '@dbos-inc/dbos-sdk';

import type { DurableStep } from '../providers/durable-step';

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
}
