import { Injectable, Optional } from '@nestjs/common';
import { DBOS, Error as DbosErrors, StatusString, type WorkflowStatus } from '@dbos-inc/dbos-sdk';

import type { DurableStep } from '../providers/durable-step';
import type { RunOptions } from '../runtime/base-plan-interpreter';
import type { DagPlan } from '../runtime/dag-plan';
import { DagInterpreter } from '../runtime/dag-interpreter';
import { RunRecorderService } from '../runtime/run-recorder.service';
import type { RunResult, RunStatus } from '../runtime/run-plan';
import { DbosDurableStep, RowGatedDurableStep } from './dbos-durable-step';
import { RecoveryGuard } from './recovery-guard';
import { RUN_PLAN_V2_WORKFLOW, RUN_PLAN_WORKFLOW, RUN_PLAN_WORKFLOWS } from './run-plan-workflow';
import { SequencedDurableStep, dbosOps } from './sequenced-durable-step';

/**
 * Runs the `DagInterpreter` as a registered DBOS workflow; registration is at module load
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

// One run on either engine: the row gate first, before the run writes anything, then the legacy engine's recovery guard, then the plan.
async function runPlan(
  args: PlanWorkflowArgs,
  substrate: DurableStep,
  engine: Pick<RunOptions, 'sharedTopicsByStep' | 'everyWaitByStep' | 'budgetCharged' | 'ownErrorLanePaths'>,
  guard: RecoveryGuard | null,
): Promise<RunResult> {
  if (!activeInterpreter) throw new Error('DbosRuntime is not initialized (no interpreter bound)');
  const { runId } = args;
  const recorder = activeRecorder;
  const interpreter = activeInterpreter;
  const gated =
    runId && recorder ? new RowGatedDurableStep(substrate, () => recorder.runStatus(runId)) : null;
  const enter = async (): Promise<void> => {
    await gated?.admit();
    if (gated && guard) {
      const checkpointed = { plan: args.plan, pins: args.pins ?? {}, initialScope: args.initialScope ?? {} };
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
    durable: gated ?? substrate,
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
    ...engine,
  });
}

// Registered for recovery only: a run it started resumes on it, and no new run starts on it.
DBOS.registerWorkflow(
  (args: PlanWorkflowArgs) =>
    runPlan(
      args,
      durableStep,
      {
        sharedTopicsByStep: args.sharedTopicsByStep === true,
        ownErrorLanePaths: false,
      },
      activeGuard,
    ),
  { name: RUN_PLAN_WORKFLOW },
);

const runPlanV2Workflow = DBOS.registerWorkflow(
  (args: PlanWorkflowArgs) =>
    runPlan(args, new SequencedDurableStep(dbosOps()), { everyWaitByStep: true, budgetCharged: true }, null),
  { name: RUN_PLAN_V2_WORKFLOW },
);

// A workflow in one of these has ended, on whichever build ran it.
const ENDED: ReadonlySet<string> = new Set([
  StatusString.SUCCESS,
  StatusString.ERROR,
  StatusString.CANCELLED,
  StatusString.MAX_RECOVERY_ATTEMPTS_EXCEEDED,
]);

// Whether the workflow runs under a name this build runs; one another build started is that build's to resume.
function owned(status: WorkflowStatus): boolean {
  return RUN_PLAN_WORKFLOWS.has(status.workflowName);
}

// What `canResume` answers, for a workflow that exists.
function resumable(status: WorkflowStatus): boolean {
  return (
    status.status === StatusString.PENDING &&
    owned(status) &&
    status.executorId === DBOS.executorID &&
    status.applicationVersion === DBOS.applicationVersion
  );
}

// The runtime's calls start, steer and read workflows; one made from inside a workflow would be recorded as its op.
function outsideWorkflow(): void {
  if (DBOS.isWithinWorkflow()) throw new Error('DbosRuntime is called only from outside a durable workflow');
}

/** A durable run once its workflow is persisted; `result` settles as the run ends. */
export interface DurableRun {
  result: () => Promise<RunResult>;
}

// A workflow already holds the run id: one the legacy engine started, or one out of recovery attempts.
function alreadyHeld(err: unknown): boolean {
  return (
    err instanceof DbosErrors.DBOSConflictingWorkflowError ||
    err instanceof DbosErrors.DBOSMaxRecoveryAttemptsExceededError
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

  /** Resume a run suspended on a `waitForEvent` node; safe to call before it reaches the wait. A repeat of `key` is dropped. */
  sendEvent(runId: string, topic: string, payload: unknown, key?: string): Promise<void> {
    outsideWorkflow();
    return DBOS.send(runId, payload, topic, key);
  }

  /** Cancel a durable run at its next step boundary; a no-op for a run DBOS does not know or has finished. */
  cancelWorkflow(runId: string): Promise<void> {
    outsideWorkflow();
    return DBOS.cancelWorkflow(runId);
  }

  /** Start a run durably, resolving once its workflow is persisted; `runId` is the idempotency key, so a run already on it starts nothing new. */
  async startDurably(
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
  ): Promise<DurableRun> {
    outsideWorkflow();
    try {
      const handle = await DBOS.startWorkflow(runPlanV2Workflow, { workflowID: opts.runId })({
        plan,
        ...opts,
      });
      return { result: () => handle.getResult() };
    } catch (err) {
      if (!alreadyHeld(err)) throw err;
      return { result: () => DBOS.retrieveWorkflow<RunResult>(opts.runId).getResult() };
    }
  }

  /** Whether a workflow holds the run id, on any engine and in any state. */
  async holdsWorkflow(runId: string): Promise<boolean> {
    outsideWorkflow();
    const held = await DBOS.listWorkflows({ workflowIDs: [runId], loadInput: false, loadOutput: false });
    return held.length > 0;
  }

  /** Whether this instance can still take a durable run on to its end: pending, a workflow it knows, and its own to recover. */
  async canResume(runId: string): Promise<boolean> {
    outsideWorkflow();
    const status = await DBOS.getWorkflowStatus(runId);
    return status !== null && resumable(status);
  }

  /**
   * Whether nothing will take the run's workflow on to its end: it has ended, or it runs under a name this build runs and
   * this instance can't resume it. `false` for a run with no workflow, and for one another build started.
   */
  async wontResume(runId: string): Promise<boolean> {
    outsideWorkflow();
    const status = await DBOS.getWorkflowStatus(runId);
    return status !== null && (ENDED.has(status.status) || (owned(status) && !resumable(status)));
  }

  /** Poll a durable run's status (and its outputs once it has completed). */
  async getRunStatus(runId: string): Promise<RunStatus> {
    outsideWorkflow();
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
