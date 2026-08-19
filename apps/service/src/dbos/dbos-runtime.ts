import { Injectable, Optional } from '@nestjs/common';
import { DBOS } from '@dbos-inc/dbos-sdk';

import type { DagPlan } from '../runtime/dag-plan';
import { DagInterpreter } from '../runtime/dag-interpreter';
import { RunRecorderService } from '../runtime/run-recorder.service';
import type { RunResult, RunStatus } from '../runtime/run-plan';
import { DbosDurableStep } from './dbos-durable-step';

/**
 * Runs the `DagInterpreter` as the one registered DBOS workflow; registration is at module load
 * because it must precede `DBOS.launch()`, and checkpointed args must stay plain data.
 */
let activeInterpreter: DagInterpreter | null = null;
let activeRecorder: RunRecorderService | null = null;
const durableStep = new DbosDurableStep();

/** The plain-data args the durable workflow checkpoints. */
interface PlanWorkflowArgs {
  plan: DagPlan;
  externalUserId: string;
  runId?: string;
  initialScope?: Record<string, unknown>;
  pins?: Record<string, unknown>;
  environment?: string | null;
  environmentId?: string | null;
  orgId?: string | null;
  chatChannelKey?: string | null;
}

const runPlanWorkflow = DBOS.registerWorkflow(
  (args: PlanWorkflowArgs): Promise<RunResult> => {
    if (!activeInterpreter) throw new Error('DbosRuntime is not initialized (no interpreter bound)');
    return activeInterpreter.run(args.plan, {
      externalUserId: args.externalUserId,
      durable: durableStep,
      runId: args.runId,
      recorder: activeRecorder ?? undefined,
      initialScope: args.initialScope,
      // Pins ride the checkpointed args so a crash-resume replays the same pinned steps.
      pins: args.pins,
      // Checkpointed too, so a crash-resume rehydrates the env and re-resolves the slot connection.
      environment: args.environment,
      environmentId: args.environmentId,
      orgId: args.orgId,
      // Checkpointed so a resume re-publishes to the same `workflow:env:session` channel.
      chatChannelKey: args.chatChannelKey,
    });
  },
  { name: 'orchestr.runPlan' },
);

@Injectable()
export class DbosRuntime {
  constructor(interpreter: DagInterpreter, @Optional() recorder?: RunRecorderService) {
    activeInterpreter = interpreter;
    activeRecorder = recorder ?? null;
  }

  /** Run a plan durably; `runId` is the idempotency key and resume handle (requires `DBOS_ENABLED`). */
  runDurably(
    plan: DagPlan,
    opts: {
      externalUserId: string;
      runId: string;
      initialScope?: Record<string, unknown>;
      pins?: Record<string, unknown>;
      environment?: string | null;
      environmentId?: string | null;
      orgId?: string | null;
      chatChannelKey?: string | null;
    },
  ): Promise<RunResult> {
    return DBOS.withNextWorkflowID(opts.runId, () => runPlanWorkflow({ plan, ...opts }));
  }

  /** Resume a run suspended on a `waitForEvent` node; safe to call before it reaches the wait. */
  sendEvent(runId: string, topic: string, payload: unknown): Promise<void> {
    return DBOS.send(runId, payload, topic);
  }

  /** Cancel a durable run at its next step boundary; throws `DBOSNonExistentWorkflowError` if unknown. */
  cancelWorkflow(runId: string): Promise<void> {
    return DBOS.cancelWorkflow(runId);
  }

  /** Start a durable run without awaiting it; returns once the workflow is persisted (no race). */
  async startDurably(
    plan: DagPlan,
    opts: {
      externalUserId: string;
      runId: string;
      initialScope?: Record<string, unknown>;
      environment?: string | null;
      environmentId?: string | null;
      orgId?: string | null;
    },
  ): Promise<string> {
    await DBOS.startWorkflow(runPlanWorkflow, { workflowID: opts.runId })({ plan, ...opts });
    return opts.runId;
  }

  /** Poll a durable run's status (and its outputs once it has completed). */
  async getRunStatus(runId: string): Promise<RunStatus> {
    const handle = DBOS.retrieveWorkflow<RunResult>(runId);
    const status = await handle.getStatus();
    if (!status) return { runId, status: 'not_found' };
    if (status.status === 'SUCCESS') {
      const result = await handle.getResult();
      return { runId, status: 'completed', outputs: result.outputs };
    }
    if (status.status === 'CANCELLED') return { runId, status: 'cancelled' };
    if (status.status === 'ERROR' || status.status === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED') {
      return { runId, status: 'error', error: status.status };
    }
    return { runId, status: 'running' };
  }
}
