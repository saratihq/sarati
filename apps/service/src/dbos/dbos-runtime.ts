import { Injectable, Optional } from '@nestjs/common';
import { DBOS, type WorkflowStatus } from '@dbos-inc/dbos-sdk';

import type { DagPlan } from '../runtime/dag-plan';
import { DagInterpreter } from '../runtime/dag-interpreter';
import { RunRecorderService } from '../runtime/run-recorder.service';
import type { RunResult, RunStatus } from '../runtime/run-plan';
import { DbosDurableStep, RowGatedDurableStep } from './dbos-durable-step';
import { RecoveryGuard } from './recovery-guard';
import { RUN_PLAN_WORKFLOW } from './run-plan-workflow';

/**
 * Runs the `DagInterpreter` as the one registered DBOS workflow; registration is at module load
 * because it must precede `DBOS.launch()`, and checkpointed args must stay plain data.
 */
let activeInterpreter: DagInterpreter | null = null;
let activeRecorder: RunRecorderService | null = null;
let activeGuard: RecoveryGuard | null = null;
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
  /** Set on every run started since waits on a shared topic receive on their own step's; absent on one recovered from before. */
  sharedTopicsByStep?: boolean;
}

const runPlanWorkflow = DBOS.registerWorkflow(
  async (args: PlanWorkflowArgs): Promise<RunResult> => {
    if (!activeInterpreter) throw new Error('DbosRuntime is not initialized (no interpreter bound)');
    const { runId } = args;
    const recorder = activeRecorder;
    const interpreter = activeInterpreter;
    const guard = activeGuard;
    const gated =
      runId && recorder ? new RowGatedDurableStep(durableStep, () => recorder.runStatus(runId)) : null;
    const enter = async (): Promise<void> => {
      await gated?.admit();
      if (gated && guard) {
        const checkpointed = {
          plan: args.plan,
          pins: args.pins ?? {},
          initialScope: args.initialScope ?? {},
        };
        await guard.admit(runId!, checkpointed, () => gated.admit());
      }
    };
    await enter().catch(async (err: unknown) => {
      // It never reaches the plan, whose end is what drops a run's file blobs.
      await interpreter.cleanupBlobs(runId!);
      throw err;
    });
    return interpreter.run(args.plan, {
      externalUserId: args.externalUserId,
      durable: gated ?? durableStep,
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
      sharedTopicsByStep: args.sharedTopicsByStep === true,
    });
  },
  { name: RUN_PLAN_WORKFLOW },
);

// What `canResume` answers, for a workflow that exists.
function resumable(status: WorkflowStatus): boolean {
  return (
    status.status === 'PENDING' &&
    status.workflowName === RUN_PLAN_WORKFLOW &&
    status.executorId === DBOS.executorID &&
    status.applicationVersion === DBOS.applicationVersion
  );
}

@Injectable()
export class DbosRuntime {
  constructor(
    interpreter: DagInterpreter,
    @Optional() recorder?: RunRecorderService,
    @Optional() guard?: RecoveryGuard,
  ) {
    activeInterpreter = interpreter;
    activeRecorder = recorder ?? null;
    activeGuard = guard ?? null;
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
    return DBOS.withNextWorkflowID(opts.runId, () =>
      runPlanWorkflow({ plan, ...opts, sharedTopicsByStep: true }),
    );
  }

  /** Resume a run suspended on a `waitForEvent` node; safe to call before it reaches the wait. A repeat of `key` is dropped. */
  sendEvent(runId: string, topic: string, payload: unknown, key?: string): Promise<void> {
    return DBOS.send(runId, payload, topic, key);
  }

  /** Cancel a durable run at its next step boundary; a no-op for a run DBOS does not know or has finished. */
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
    await DBOS.startWorkflow(runPlanWorkflow, { workflowID: opts.runId })({
      plan,
      ...opts,
      sharedTopicsByStep: true,
    });
    return opts.runId;
  }

  /** Whether this instance can still take a durable run on to its end: pending, a workflow it knows, and its own to recover. */
  async canResume(runId: string): Promise<boolean> {
    const status = await DBOS.getWorkflowStatus(runId);
    return status !== null && resumable(status);
  }

  /** Whether the run has a workflow that nothing will take on to its end; `false` for a run that has none. */
  async wontResume(runId: string): Promise<boolean> {
    const status = await DBOS.getWorkflowStatus(runId);
    return status !== null && !resumable(status);
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
