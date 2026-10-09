import { randomUUID } from 'node:crypto';

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { IsNull, Not, type DataSource, type EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import type { EnvConfig } from '../config/env.config';
import { isIdShape } from '../database/ids';
import { RuntimeRunEntity, RuntimeRunStepEntity } from '../database/entities/runtime-run.entity';
import type { RunSource } from '../database/entities/runtime-run.entity';
import { WorkflowEntity } from '../database/entities/workflow.entity';
import { DbosRuntime, isDurableCancellation } from '../dbos/dbos-runtime';
import type { WorkflowIR } from '../ir/models';
import { PassThroughDurableStep } from '../providers/durable-step';
import type { AgentWorkflowCatalog } from '../runtime/agent';
import { AgentStepBus } from '../runtime/agent-step-bus';
import { DagInterpreter } from '../runtime/dag-interpreter';
import type { DagAgentNode, DagPlan } from '../runtime/dag-plan';
import { rawQuery } from '../database/raw-query';
import {
  recordCancel,
  REFUSED_RUN_ERROR_PREFIX,
  RunRecorderService,
  truncatedValueOf,
  withWaitLock,
} from '../runtime/run-recorder.service';
import type { SubWorkflowRunner } from '../runtime/sub-workflow-runner';
import { RuntimeCompiler } from '../runtime/runtime-compiler';
import type { RunOutcome, RunPlan, RunResult, RunStatus } from '../runtime/run-plan';
import { eventTopicFor } from '../runtime/event-wait';
import { isTimerWait, TIMER_TOPIC_SQL_PREFIX } from '../runtime/timer-wait';
import { reachesRun, runReachSql, type RunAccess } from './run-access';
import { failedNodeIdOf, type RunFailureDetails } from './run-failure';

/** ~2KB cap for the per-step `output_preview` the runs panel renders. */
const OUTPUT_PREVIEW_CHARS = 2_048;

export interface RunDispatchOptions {
  externalUserId: string;
  runId?: string;
  initialScope?: Record<string, unknown>;
  /** TRUE PINNING: ephemeral `{ [nodeId]: output }` overrides — a pinned node replays instead of hitting the provider. */
  pins?: Record<string, unknown>;
  /** The workflow this run executes — recorded for the runs panel (already validated). */
  workflowId?: string | null;
  /** The exact version this run executes (env-pointer resolution at fire time); null for raw plans. */
  workflowVersionId?: string | null;
  /** What started the run (defaults to 'api' — a raw plan over HTTP). */
  source?: RunSource;
  /** Per-env connection scoping: env NAME snapshot; unset = Default → personal. */
  environment?: string | null;
  environmentId?: string | null;
  orgId?: string | null;
  /** The review this run tests (recorded when source='review_test'). */
  reviewId?: string | null;
  /** Dry run (preview): no state-changing external call fires; forced onto the in-process path. */
  dryRun?: boolean;
  /** SCOPED `workflow:env:session` key the agent loop streams steps to; unset → no streaming. */
  chatChannelKey?: string | null;
}

/** Dispatch options for the IR entry points, which additionally resolve the caller's org. */
export type IrRunOptions = RunDispatchOptions & { activeOrgId?: string | null };

/** What an entry point asks to run: a raw client-supplied plan, or a workflow document. */
export type PlanSource = { plan: RunPlan } | { ir: WorkflowIR };

/** Read options for {@link RunsService.getRun}. */
export interface GetRunOptions {
  /** Default true. False withholds every step payload (`output` AND `output_preview`) from the read itself. */
  includeStepOutputs?: boolean;
}

/** One end of a sub-workflow call, as run detail reports it. */
export interface SubWorkflowRunLink {
  run_id: string;
  /** The calling step's key — always the CHILD's, whichever end this link is. */
  step_key: string | null;
  workflow_id: string | null;
  workflow_name: string | null;
  status: string;
}

interface SubWorkflowRunRow {
  run_id: string;
  parent_step_key: string | null;
  workflow_id: string | null;
  workflow_name: string | null;
  status: string;
}

function timerWaitRefusal(message: string): DomainError {
  return new DomainError(message, 409, { code: 'timer_wait' });
}

function timerTopicRefusal(topic: string): DomainError {
  return timerWaitRefusal(`Topic "${topic}" belongs to a timed wait and can't be sent to`);
}

function parkedTimerRefusal(runId: string, wakesAt: Date | null): DomainError {
  if (wakesAt && wakesAt.getTime() <= Date.now()) {
    return timerWaitRefusal(
      `Run ${runId} was due at ${wakesAt.toISOString()}, not waiting for an event — it resumes on its own`,
    );
  }
  const until = wakesAt ? ` until ${wakesAt.toISOString()}` : '';
  return timerWaitRefusal(`Run ${runId} is waiting${until}, not for an event — it resumes on its own`);
}

/** What a parked run is waiting for: its own clock (`timer`) or someone sending an event. */
export interface RunWaiting {
  kind: 'timer' | 'event';
  /** When a timer wakes, or when an event wait times out. */
  until: string | null;
}

// A claim older than this lost its event on the way out, so the wait is answerable again.
const CLAIM_LEASE_SECONDS = 60;

function stepWaitingOf(step: RuntimeRunStepEntity): RunWaiting | null {
  if (!step.waitingTopic) return null;
  return {
    kind: isTimerWait(step.waitingTopic) ? 'timer' : 'event',
    until: step.waitingTimeoutAt?.toISOString() ?? null,
  };
}

// A person's decision outranks a timer, then whichever is due first.
function runWaitingOf(status: string, steps: RuntimeRunStepEntity[]): RunWaiting | null {
  if (status !== 'waiting') return null;
  const due = (w: RunWaiting): number => (w.until ? Date.parse(w.until) : Infinity);
  const waits = steps.map(stepWaitingOf).filter((w): w is RunWaiting => w !== null);
  return (
    waits.sort((a, b) => Number(a.kind === 'timer') - Number(b.kind === 'timer') || due(a) - due(b))[0] ??
    null
  );
}

function isClaimed(step: RuntimeRunStepEntity): boolean {
  return step.claimedAt !== null && Date.now() - step.claimedAt.getTime() < CLAIM_LEASE_SECONDS * 1000;
}

// The named step, else the wait on the topic that has waited longest; a claimed one only when nothing else is left.
function waitFor(
  parked: RuntimeRunStepEntity[],
  topic: string,
  stepKey: string | undefined,
): RuntimeRunStepEntity | undefined {
  if (isTimerWait(topic)) return undefined;
  const since = (s: RuntimeRunStepEntity): number => s.waitingSince?.getTime() ?? 0;
  return parked
    .filter((s) => s.waitingTopic === topic && (stepKey === undefined || s.stepKey === stepKey))
    .sort(
      (a, b) =>
        Number(isClaimed(a)) - Number(isClaimed(b)) ||
        since(a) - since(b) ||
        a.stepKey.localeCompare(b.stepKey),
    )[0];
}

function noWaitOn(
  runId: string,
  topic: string,
  stepKey: string | undefined,
  parked: RuntimeRunStepEntity[],
): DomainError {
  if (parked.length === 0) return new DomainError(`Run ${runId} is not waiting for an event`, 409);
  const events = parked.filter((s) => !isTimerWait(s.waitingTopic));
  if (events.length === 0) {
    const wakes = parked.map((s) => s.waitingTimeoutAt?.getTime() ?? Infinity);
    const first = Math.min(...wakes);
    return parkedTimerRefusal(runId, Number.isFinite(first) ? new Date(first) : null);
  }
  if (isTimerWait(topic)) return timerTopicRefusal(topic);
  if (stepKey !== undefined && !events.some((s) => s.stepKey === stepKey)) {
    return new DomainError(`Run ${runId} is no longer waiting at step "${stepKey}"`, 409);
  }
  const topics = [...new Set(events.map((s) => `"${s.waitingTopic}"`))];
  const on = topics.length === 1 ? `topic ${topics[0]}` : `topics ${topics.join(', ')}`;
  return new DomainError(`Run ${runId} is waiting on ${on}, not "${topic}"`, 409);
}

interface Claim {
  claimedAt: Date;
  decidedBy: string;
  decidedAt: Date;
  before: { decidedBy: string | null; decidedAt: Date | null };
}

// The wait stays parked until the run takes the event; the claim only keeps every other event off it.
async function claimWait(
  em: EntityManager,
  scoped: string,
  wait: RuntimeRunStepEntity,
  deciderId: string,
): Promise<Claim | null> {
  const [claimed]: [Array<{ claimed_at: Date }>, number] = await em.query(
    `UPDATE runtime_run_steps s SET claimed_at = date_trunc('milliseconds', now())
      WHERE s.run_id = $1 AND s.step_key = $2 AND s.waiting_topic = $3
        AND (s.waiting_timeout_at IS NULL OR s.waiting_timeout_at > now())
        AND (s.claimed_at IS NULL OR s.claimed_at < now() - make_interval(secs => $4))
        AND EXISTS (SELECT 1 FROM runtime_runs r WHERE r.id = s.run_id AND r.status = 'waiting')
      RETURNING s.claimed_at`,
    [scoped, wait.stepKey, wait.waitingTopic, CLAIM_LEASE_SECONDS],
  );
  const claimedAt = claimed[0]?.claimed_at;
  if (!claimedAt) return null;
  const run = await em.findOneByOrFail(RuntimeRunEntity, { id: scoped });
  const claim = {
    claimedAt,
    decidedBy: deciderId,
    decidedAt: new Date(),
    before: { decidedBy: run.decidedBy, decidedAt: run.decidedAt },
  };
  await em.update(
    RuntimeRunEntity,
    { id: scoped },
    { decidedBy: claim.decidedBy, decidedAt: claim.decidedAt },
  );
  return claim;
}

async function unclaimWait(
  em: EntityManager,
  scoped: string,
  wait: RuntimeRunStepEntity,
  claim: Claim,
): Promise<void> {
  await em.query(
    `UPDATE runtime_run_steps SET claimed_at = NULL WHERE run_id = $1 AND step_key = $2 AND claimed_at = $3`,
    [scoped, wait.stepKey, claim.claimedAt],
  );
  await em.query(
    `UPDATE runtime_runs SET decided_by = $2, decided_at = $3 WHERE id = $1 AND decided_by = $4 AND decided_at = $5`,
    [scoped, claim.before.decidedBy, claim.before.decidedAt, claim.decidedBy, claim.decidedAt],
  );
}

function isTerminal(status: string): status is 'completed' | 'error' | 'cancelled' {
  return status === 'completed' || status === 'error' || status === 'cancelled';
}

function runLink(row: SubWorkflowRunRow): SubWorkflowRunLink {
  return {
    run_id: row.run_id,
    step_key: row.parent_step_key,
    workflow_id: row.workflow_id,
    workflow_name: row.workflow_name,
    status: row.status,
  };
}

/** A run's detail shape: status + provenance + the per-step log. */
export type RunDetail = RunStatus & {
  /** The run that called this one, when a sub-workflow call started it. */
  called_by: SubWorkflowRunLink | null;
  /** The runs this one started by calling other workflows. */
  calls: SubWorkflowRunLink[];
  workflow_id: string | null;
  workflow_name: string | null;
  /** The exact version this run executed (env-pointer resolution) — null for raw plans. */
  workflow_version_id: string | null;
  /** The env the run executed under (historical name snapshot) — null = Default. */
  environment: string | null;
  environment_id: string | null;
  source: string | null;
  /** Dry run (preview): this run fired no state-changing external call. */
  dry_run: boolean;
  duration_ms: number | null;
  /** Who resolved a waitForEvent (approve/reject), and when — null if none. */
  decided_by: { id: string; name: string | null; email: string | null } | null;
  decided_at: string | null;
  /** Set while the run is `waiting`: what it waits for, and until when. */
  waiting: RunWaiting | null;
};

/**
 * Front door for executing a RunPlan: durably via DBOS when `DBOS_ENABLED`, else directly
 * through the interpreter (approvals then pause in-memory and die with the process).
 */
@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);
  private readonly dbosEnabled: boolean;
  /** Direct-path runs in flight: scoped run id → the step substrate `sendEvent` delivers to. */
  private readonly waiters = new Map<string, PassThroughDurableStep>();

  constructor(
    private readonly interpreter: DagInterpreter,
    private readonly compiler: RuntimeCompiler,
    private readonly dbos: DbosRuntime,
    config: ConfigService<{ env: EnvConfig }, true>,
    @InjectDataSource() @Optional() private readonly dataSource?: DataSource,
    @Optional() private readonly recorder?: RunRecorderService,
    @Optional() private readonly agentStepBus?: AgentStepBus,
  ) {
    this.dbosEnabled = config.get('env', { infer: true }).dbosEnabled;
  }

  /** Run a raw client-supplied `RunPlan` (POST /runs), lowered to a `DagPlan` for the one engine. */
  async run(plan: RunPlan, opts: RunDispatchOptions): Promise<RunResult> {
    const runId = opts.runId ?? randomUUID();
    return this.runExecutable(await this.compile({ plan }, opts, runId), { ...opts, runId });
  }

  /** Dispatch a COMPILED `DagPlan`: record the run, then execute via DBOS or the interpreter. Every entry point funnels here. */
  async runExecutable(plan: DagPlan, opts: RunDispatchOptions): Promise<RunResult> {
    const runId = opts.runId ?? randomUUID();
    const scoped = this.scopedRunId(opts.externalUserId, runId);
    await this.recorder?.runStarted(scoped, runId, opts.externalUserId, plan, {
      workflowId: opts.workflowId ?? null,
      workflowVersionId: opts.workflowVersionId ?? null,
      source: opts.source ?? 'api',
      environment: opts.environment ?? null,
      environmentId: opts.environmentId ?? null,
      reviewId: opts.reviewId ?? null,
      dryRun: opts.dryRun ?? false,
      orgId: opts.orgId ?? null,
    });
    try {
      const result = await this.execute(plan, scoped, opts);
      return { ...result, run_id: runId };
    } catch (err) {
      // A step failing is a RUN outcome, not a server fault → structured 422, never a 500 — and it
      // carries the handle + failing node + step log, so the failure is debuggable from itself.
      const details = await this.failureDetails(scoped, runId);
      if (err instanceof DomainError) {
        throw new DomainError(err.message, err.status, { ...details, ...(err.details ?? {}) });
      }
      if (isDurableCancellation(err)) {
        throw new DomainError(`Run ${runId} was cancelled`, 409, { code: 'run_cancelled', ...details });
      }
      throw new DomainError(`Run ${runId} failed: ${errorMessage(err)}`, 422, {
        code: 'run_failed',
        ...details,
      });
    }
  }

  /** The two rails a compiled plan runs on: DBOS durable, or the in-process interpreter. */
  private async execute(plan: DagPlan, scoped: string, opts: RunDispatchOptions): Promise<RunResult> {
    // DBOS can't inject our dry-run http client, so a dry run must take the in-process path.
    if (this.dbosEnabled && !opts.dryRun) {
      return this.dbos.runDurably(plan, {
        externalUserId: opts.externalUserId,
        runId: scoped,
        initialScope: opts.initialScope,
        pins: opts.pins,
        environment: opts.environment,
        environmentId: opts.environmentId,
        orgId: opts.orgId,
        chatChannelKey: opts.chatChannelKey,
      });
    }
    // Direct path: hold the run's step substrate so POST /runs/:id/events can resume a waitForEvent pause.
    const durable = new PassThroughDurableStep();
    this.waiters.set(scoped, durable);
    try {
      return await this.interpreter.run(plan, {
        externalUserId: opts.externalUserId,
        runId: scoped,
        durable,
        recorder: this.recorder,
        initialScope: opts.initialScope,
        pins: opts.pins,
        environment: opts.environment,
        environmentId: opts.environmentId,
        orgId: opts.orgId,
        dryRun: opts.dryRun,
        chatChannelKey: opts.chatChannelKey,
      });
    } finally {
      this.waiters.delete(scoped);
    }
  }

  /** Read the failed run's step log for its own error payload; payloads are withheld to keep the body bounded. */
  private async failureDetails(scoped: string, runId: string): Promise<RunFailureDetails> {
    const em = this.dataSource?.manager;
    if (!em) return { run_id: runId, failed_node_id: null, steps: [] };
    try {
      const rows = await em.find(RuntimeRunStepEntity, {
        where: { runId: scoped },
        order: { startedAt: 'ASC' },
      });
      const steps = rows.map((s) => stepLog(s, false));
      return { run_id: runId, failed_node_id: failedNodeIdOf(steps), steps };
    } catch (err) {
      // A history read must never replace the run's own failure with a server fault.
      this.logger.warn(`Run ${runId}: reading the step log for its failure failed: ${errorMessage(err)}`);
      return { run_id: runId, failed_node_id: null, steps: [] };
    }
  }

  /** Bind the sub-workflow runner onto the ONE interpreter — a setter, since the runner sits above us and a constructor dep would cycle. */
  bindSubWorkflowRunner(runner: SubWorkflowRunner): void {
    this.interpreter.setSubWorkflowRunner(runner);
  }

  /** Bind the sub-workflow tool CONTRACT source onto the same interpreter. */
  bindWorkflowToolCatalog(catalog: AgentWorkflowCatalog): void {
    this.interpreter.setAgentWorkflowCatalog(catalog);
  }

  /**
   * Run a COMPILED sub-workflow NESTED inside the caller's durable run: one parent
   * checkpoint, so inner steps get no per-step memoization — a mid-run crash re-runs the whole sub-workflow.
   */
  async runSubWorkflowNested(
    plan: DagPlan,
    opts: {
      externalUserId: string;
      /** Deterministic child run id — stable across a crash-replay, so step idempotency keys repeat. */
      runId: string;
      /** The CHILD's workflow and version: the run is recorded under what actually executed. */
      workflowId: string;
      workflowVersionId: string;
      parentRunId: string;
      parentStepKey: string;
      initialScope?: Record<string, unknown>;
      environment?: string | null;
      environmentId?: string | null;
      orgId?: string | null;
      dryRun?: boolean;
      subWorkflowDepth: number;
      subWorkflowBudget: { remaining: number };
    },
  ): Promise<RunResult> {
    const scoped = this.scopedRunId(opts.externalUserId, opts.runId);
    await this.recorder?.runStarted(scoped, opts.runId, opts.externalUserId, plan, {
      workflowId: opts.workflowId,
      workflowVersionId: opts.workflowVersionId,
      source: 'sub_workflow',
      environment: opts.environment ?? null,
      environmentId: opts.environmentId ?? null,
      dryRun: opts.dryRun ?? false,
      parentRunId: opts.parentRunId,
      parentStepKey: opts.parentStepKey,
      orgId: opts.orgId ?? null,
    });
    return this.interpreter.run(plan, {
      externalUserId: opts.externalUserId,
      runId: scoped,
      // The child's steps land in ITS run, so a failure inside is readable instead of showing
      // only as whatever the call returned to the caller.
      recorder: this.recorder,
      durable: new PassThroughDurableStep(),
      initialScope: opts.initialScope,
      environment: opts.environment,
      environmentId: opts.environmentId,
      orgId: opts.orgId,
      dryRun: opts.dryRun,
      subWorkflowDepth: opts.subWorkflowDepth,
      subWorkflowBudget: opts.subWorkflowBudget,
    });
  }

  /** Compile a WorkflowIR (from generation) to a RunPlan and run it (sync). */
  async runFromIr(ir: WorkflowIR, opts: IrRunOptions): Promise<RunResult> {
    return (await this.startIr(ir, opts)).pending;
  }

  /**
   * Run a WorkflowIR with a BOUNDED wait: the full result when it settles inside
   * `awaitMs`, else a handle — the run goes on, and `GET /api/runs/:run_id` reports it.
   */
  async runFromIrBounded(ir: WorkflowIR, opts: IrRunOptions & { awaitMs: number }): Promise<RunOutcome> {
    const { runId, pending } = await this.startIr(ir, opts);
    return this.settleWithin(pending, runId, opts.awaitMs);
  }

  /** Guard, compile and dispatch a WorkflowIR; the caller decides how long to wait on the run. */
  private async startIr(
    ir: WorkflowIR,
    opts: IrRunOptions,
  ): Promise<{ runId: string; pending: Promise<RunResult> }> {
    if (opts.workflowId) await this.assertWorkflowRunnable(opts.workflowId, opts.activeOrgId ?? null);
    const runId = opts.runId ?? randomUUID();
    const plan = await this.compile({ ir }, opts, runId);
    return {
      runId,
      pending: this.runExecutable(plan, {
        ...opts,
        runId,
        orgId: opts.orgId ?? opts.activeOrgId ?? null,
      }),
    };
  }

  /** Compile what a run start was given; one that can't compile is answered 400 before any step runs, and recorded as refused unless its id already holds a run. */
  private async compile(source: PlanSource, opts: IrRunOptions, runId: string): Promise<DagPlan> {
    try {
      // The workflow id arms the compiler's direct-self-reference guard on `orchestr:call_workflow`.
      return 'ir' in source
        ? this.compiler.compile(source.ir, opts.workflowId ?? undefined)
        : this.compiler.fromRunPlan(source.plan);
    } catch (err) {
      const message = `${REFUSED_RUN_ERROR_PREFIX}${errorMessage(err)}`;
      // Carry the SAME provenance the happy path records — a compile-failed run must still link to its review / env.
      await this.recorder?.runRefused(
        this.scopedRunId(opts.externalUserId, runId),
        runId,
        opts.externalUserId,
        message,
        {
          workflowId: opts.workflowId ?? null,
          source: opts.source ?? 'api',
          environment: opts.environment ?? null,
          environmentId: opts.environmentId ?? null,
          workflowVersionId: opts.workflowVersionId ?? null,
          reviewId: opts.reviewId ?? null,
          dryRun: opts.dryRun ?? false,
          orgId: opts.orgId ?? opts.activeOrgId ?? null,
        },
      );
      throw new DomainError(message, 400, {
        code: 'compile_failed',
        run_id: runId,
        failed_node_id: null,
        steps: [],
      });
    }
  }

  /**
   * Await a run for at most `awaitMs`. Past that the caller takes a handle and the run continues
   * unattended — its outcome lands on the run row, which is what the poll reads.
   */
  private async settleWithin(
    pending: Promise<RunResult>,
    runId: string,
    awaitMs: number,
  ): Promise<RunOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const elapsed = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), awaitMs);
    });
    try {
      const settled = await Promise.race([pending.then((result) => ({ result })), elapsed]);
      if (settled) return settled.result;
    } finally {
      clearTimeout(timer);
    }
    pending.catch((err: unknown) => {
      this.logger.warn(`Run ${runId} failed after its bounded wait elapsed: ${errorMessage(err)}`);
    });
    return { run_id: runId, status: 'running' };
  }

  /** Test ONE step in isolation: compile the single node, seed the caller's upstream samples, run it. Transient — never recorded in run history. */
  async testStep(
    node: { id: string; node_type: string; name?: string; parameters?: Record<string, unknown> },
    sampleScope: Record<string, unknown>,
    opts: { externalUserId: string },
  ): Promise<RunResult> {
    const ir = {
      version: '1',
      name: 'test-step',
      nodes: [
        {
          id: node.id,
          name: node.name ?? node.id,
          node_type: node.node_type,
          type_version: 1,
          parameters: node.parameters ?? {},
          position: { x: 0, y: 0 },
          credentials: null,
          metadata: {},
        },
      ],
      edges: [],
      settings: {},
      metadata: { engine: 'orchestr' },
    } as unknown as WorkflowIR;

    let plan: DagPlan;
    try {
      plan = this.compiler.compile(ir);
    } catch (err) {
      throw new DomainError(`Step can't run: ${errorMessage(err)}`, 400);
    }

    const durable = new PassThroughDurableStep();
    try {
      // No recorder → the test run is transient and never written to run history.
      return await this.interpreter.run(plan, {
        externalUserId: opts.externalUserId,
        runId: this.scopedRunId(opts.externalUserId, randomUUID()),
        durable,
        initialScope: sampleScope,
      });
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError(`Test step failed: ${errorMessage(err)}`, 422);
    }
  }

  /**
   * Test ONE agent node with its real tools: compile the FULL document (tool edges are peeled at
   * compile, invariant #14) and lift the agent's own step into a one-step plan. Transient — never recorded.
   */
  async testAgent(
    ir: WorkflowIR,
    nodeId: string,
    opts: {
      externalUserId: string;
      input?: string;
      sampleScope?: Record<string, unknown>;
      chatChannelKey?: string | null;
    },
  ): Promise<RunResult> {
    let plan: DagPlan;
    try {
      plan = this.compiler.compile(ir);
    } catch (err) {
      this.closeAgentChannel(opts.chatChannelKey);
      throw new DomainError(`Workflow can't compile: ${errorMessage(err)}`, 400);
    }
    const step = findAgentNode(plan, nodeId);
    if (!step) {
      this.closeAgentChannel(opts.chatChannelKey);
      throw new DomainError(`"${nodeId}" isn't an AI Agent node in this workflow`, 400);
    }
    const input = opts.input?.trim();
    // An isolated test runs unconditionally and must never fire the workflow's real error lane;
    // the input override rides as a literal so a typed "{{…}}" task reaches the model instead of throwing.
    const bare: DagAgentNode = { ...step, guards: [] };
    delete bare.onErrorBranch;
    const agent: DagAgentNode = {
      ...bare,
      ...(input ? { input, inputLiteral: true } : {}),
    };
    const initialScope = { ...(opts.sampleScope ?? {}) };
    delete initialScope[nodeId]; // a prior run's own-output sample must not collide with the plan node
    try {
      return await this.interpreter.run(
        { id: `${plan.id}:agent-test`, nodes: [agent] },
        {
          externalUserId: opts.externalUserId,
          runId: this.scopedRunId(opts.externalUserId, randomUUID()),
          durable: new PassThroughDurableStep(),
          initialScope,
          chatChannelKey: opts.chatChannelKey ?? null,
        },
      );
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError(`Agent test failed: ${errorMessage(err)}`, 422);
    } finally {
      this.closeAgentChannel(opts.chatChannelKey);
    }
  }

  /** End a test-agent step stream so its subscribers' SSE close with the run (never leaks). */
  private closeAgentChannel(channelKey: string | null | undefined): void {
    if (channelKey) this.agentStepBus?.close(channelKey);
  }

  /**
   * Start a run without waiting (long-running / human-in-the-loop). Requires DBOS — an unattended
   * run has to survive a restart. A plan or a WorkflowIR takes the SAME compile seam as the sync routes.
   */
  async startRun(source: PlanSource, opts: IrRunOptions): Promise<{ runId: string }> {
    this.requireDbos();
    const runId = opts.runId ?? randomUUID();
    const scoped = this.scopedRunId(opts.externalUserId, runId);
    if (opts.workflowId) await this.assertWorkflowRunnable(opts.workflowId, opts.activeOrgId ?? null);
    const dag = await this.compile(source, opts, runId);
    await this.recorder?.runStarted(scoped, runId, opts.externalUserId, dag, {
      workflowId: opts.workflowId ?? null,
      source: opts.source ?? 'api',
      environment: opts.environment ?? null,
      environmentId: opts.environmentId ?? null,
      orgId: opts.orgId ?? opts.activeOrgId ?? null,
    });
    await this.dbos.startDurably(dag, {
      externalUserId: opts.externalUserId,
      runId: scoped,
      initialScope: opts.initialScope,
      environment: opts.environment,
      environmentId: opts.environmentId,
      orgId: opts.orgId ?? opts.activeOrgId ?? null,
    });
    return { runId };
  }

  /** A run's status + step log from the history tables; a still-`running` durable run is overlaid with live DBOS status. */
  async getRun(runId: string, access: RunAccess, opts: GetRunOptions = {}): Promise<RunDetail> {
    const em = this.dataSource?.manager;
    const { row, recorded } = em
      ? await this.resolveActionableRun(em, runId, access)
      : { row: null, recorded: false };
    // Key downstream lookups off the run's REAL (owner-scoped) id so an org-wide approver reads the same run.
    const scoped = row?.id ?? this.scopedRunId(access.userId, runId);

    if (!row) {
      // No record: a durable run can still answer from DBOS. A record that was refused must not.
      const live =
        this.dbosEnabled && !recorded
          ? await this.dbos.getRunStatus(scoped)
          : ({ status: 'not_found' } as const);
      return {
        ...live,
        runId,
        workflow_id: null,
        workflow_name: null,
        workflow_version_id: null,
        environment: null,
        environment_id: null,
        source: null,
        dry_run: false,
        duration_ms: null,
        decided_by: null,
        decided_at: null,
        waiting: null,
        called_by: null,
        calls: [],
      };
    }

    let status: RunStatus = {
      runId,
      status: row.status,
      outputs: row.outputs ?? undefined,
      error: row.error ?? undefined,
    };
    if (row.status === 'running' && this.dbosEnabled) {
      const live = await this.dbos.getRunStatus(scoped);
      if (live.status !== 'not_found') status = { ...live, runId };
    }

    const workflow =
      row.workflowId && em ? await em.findOne(WorkflowEntity, { where: { id: row.workflowId } }) : null;
    const deciderRows =
      row.decidedBy && em
        ? await em.query<Array<{ id: string; name: string | null; email: string | null }>>(
            `SELECT id, name, email FROM users WHERE id = $1`,
            [row.decidedBy],
          )
        : [];
    const decider = deciderRows[0];
    const steps = em
      ? await em.find(RuntimeRunStepEntity, { where: { runId: scoped }, order: { startedAt: 'ASC' } })
      : [];
    return {
      ...status,
      decided_by: decider ? { id: decider.id, name: decider.name, email: decider.email } : null,
      decided_at: row.decidedAt?.toISOString() ?? null,
      waiting: runWaitingOf(row.status, steps),
      steps: steps.map((s) => stepLog(s, opts.includeStepOutputs !== false)),
      ...(em ? await this.subWorkflowLinks(em, row, scoped, access) : { called_by: null, calls: [] }),
      started_at: row.startedAt?.toISOString() ?? null,
      finished_at: row.finishedAt?.toISOString() ?? null,
      workflow_id: row.workflowId,
      workflow_name: workflow?.name ?? null,
      workflow_version_id: row.workflowVersionId,
      environment: row.environment,
      environment_id: row.environmentId,
      source: row.source,
      dry_run: row.dryRun,
      duration_ms: durationMs(row.startedAt, row.finishedAt),
    };
  }

  /**
   * Both ends of a sub-workflow call: the run that called this one, and the runs it
   * called. Without them a nested failure is only readable if you already know where to look.
   */
  private async subWorkflowLinks(
    em: EntityManager,
    run: { parentRunId: string | null; parentStepKey: string | null },
    scoped: string,
    access: RunAccess,
  ): Promise<{ called_by: SubWorkflowRunLink | null; calls: SubWorkflowRunLink[] }> {
    const select = `SELECT r.run_id, r.parent_step_key, r.workflow_id, r.status, w.name AS workflow_name
                      FROM runtime_runs r LEFT JOIN workflows w ON w.id = r.workflow_id`;
    const reach = [access.orgIds, access.pinned];
    const [parents, children] = await Promise.all([
      run.parentRunId
        ? rawQuery<SubWorkflowRunRow>(em, `${select} WHERE r.id = $1 AND ${runReachSql(2, 3)}`, [
            run.parentRunId,
            ...reach,
          ])
        : Promise.resolve([]),
      rawQuery<SubWorkflowRunRow>(
        em,
        `${select} WHERE r.parent_run_id = $1 AND ${runReachSql(2, 3)} ORDER BY r.started_at`,
        [scoped, ...reach],
      ),
    ]);
    const parentRow = parents[0];
    return {
      // The linking step key is recorded on the CHILD, so looking UP it comes from this run's own
      // row — the parent's would be its own caller's, or null.
      called_by: parentRow ? { ...runLink(parentRow), step_key: run.parentStepKey } : null,
      calls: children.map(runLink),
    };
  }

  /** The caller's most recent COMPLETED run of a workflow, as the editor's sample data. User-scoped: one member's payloads aren't another's. */
  async latestRunOutputs(
    externalUserId: string,
    workflowId: string,
  ): Promise<Record<string, unknown> | null> {
    if (!this.dataSource) return null;
    const rows: Array<{ run_id: string; outputs: Record<string, unknown>; finished_at: Date | null }> =
      await this.dataSource.query(
        `SELECT run_id, outputs, finished_at
           FROM runtime_runs
          WHERE user_id = $1 AND workflow_id = $2 AND status = 'completed' AND outputs IS NOT NULL
          ORDER BY finished_at DESC NULLS LAST
          LIMIT 1`,
        [externalUserId, workflowId],
      );
    const row = rows[0];
    if (!row) return null;
    return {
      run_id: row.run_id,
      finished_at: row.finished_at?.toISOString() ?? null,
      outputs: row.outputs,
    };
  }

  /** {@link latestRunOutputs} for a caller who must still be able to reach the workflow's runs. */
  async sampleFor(access: RunAccess, workflowId: string): Promise<Record<string, unknown> | null> {
    if (!this.dataSource) return null;
    const rows: Array<{ org_id: string | null }> = await this.dataSource.query(
      `SELECT org_id FROM workflows WHERE id = $1`,
      [workflowId],
    );
    if (!reachesRun(access, { orgId: rows[0]?.org_id ?? null, hasWorkflow: true })) return null;
    return this.latestRunOutputs(access.userId, workflowId);
  }

  /** The caller's run history, newest first (optionally per workflow). */
  async listRuns(
    access: RunAccess,
    opts: { limit?: number; workflowId?: string } = {},
  ): Promise<Array<Record<string, unknown>>> {
    if (!this.dataSource) return [];
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const params: unknown[] = [access.userId, access.orgIds, access.pinned];
    let where = `r.user_id = $1 AND ${runReachSql(2, 3)}`;
    if (opts.workflowId) {
      params.push(opts.workflowId);
      where += ` AND r.workflow_id = $${params.length}`;
    }
    params.push(limit);
    const rows: Array<{
      run_id: string;
      plan_id: string;
      workflow_id: string | null;
      workflow_name: string | null;
      workflow_version_id: string | null;
      version_number: number | null;
      environment: string | null;
      environment_id: string | null;
      status: string;
      error: string | null;
      source: string | null;
      dry_run: boolean;
      started_at: Date | null;
      finished_at: Date | null;
    }> = await this.dataSource.query(
      `SELECT r.run_id, r.plan_id, r.workflow_id, w.name AS workflow_name, r.status, r.error,
              r.source, r.dry_run, r.started_at, r.finished_at, r.environment, r.environment_id,
              r.workflow_version_id, v.version_number
         FROM runtime_runs r
         LEFT JOIN workflows w ON w.id = r.workflow_id
         LEFT JOIN workflow_versions v ON v.id = r.workflow_version_id
        WHERE ${where}
        ORDER BY r.started_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      run_id: r.run_id,
      plan_id: r.plan_id,
      workflow_id: r.workflow_id,
      workflow_name: r.workflow_name,
      workflow_version_id: r.workflow_version_id,
      version_number: r.version_number,
      environment: r.environment,
      environment_id: r.environment_id,
      status: r.status,
      error: r.error,
      source: r.source,
      dry_run: r.dry_run,
      started_at: r.started_at?.toISOString() ?? null,
      finished_at: r.finished_at?.toISOString() ?? null,
      duration_ms: durationMs(r.started_at, r.finished_at),
    }));
  }

  /** One entry per step parked on a `waitForEvent` (approvals inbox); a wait already answered or past its timeout is left out. */
  async listWaitingRuns(access: RunAccess, workflowId?: string): Promise<Array<Record<string, unknown>>> {
    if (!this.dataSource) return [];
    // Org-wide approvals: own runs plus every run parked in the ACTIVE org. A non-interactive
    // caller (and a personal scope, where `w.org_id = $2` is a NULL compare) sees only its own.
    const params: unknown[] = [
      access.userId,
      access.orgWide ? access.activeOrgId : null,
      access.orgIds,
      access.pinned,
      TIMER_TOPIC_SQL_PREFIX,
      CLAIM_LEASE_SECONDS,
    ];
    let where = `r.status = 'waiting'
        AND s.waiting_topic NOT LIKE $5 || '%'
        AND (s.waiting_timeout_at IS NULL OR s.waiting_timeout_at > now())
        AND (s.claimed_at IS NULL OR s.claimed_at < now() - make_interval(secs => $6))
        AND (r.user_id = $1 OR w.org_id = $2)
        AND ${runReachSql(3, 4)}`;
    if (workflowId) {
      params.push(workflowId);
      where += ` AND r.workflow_id = $${params.length}`;
    }
    const rows: Array<{
      id: string;
      run_id: string;
      workflow_id: string | null;
      workflow_name: string | null;
      step_key: string;
      node_id: string;
      waiting_topic: string;
      waiting_since: Date | null;
      waiting_timeout_at: Date | null;
      triggered_by: string;
      triggered_by_email: string | null;
      triggered_by_name: string | null;
    }> = await this.dataSource.query(
      `SELECT r.id, r.run_id, r.workflow_id, w.name AS workflow_name, s.step_key, s.node_id, s.waiting_topic,
              s.waiting_since, s.waiting_timeout_at,
              r.user_id AS triggered_by, u.email AS triggered_by_email, u.name AS triggered_by_name
         FROM runtime_run_steps s
         JOIN runtime_runs r ON r.id = s.run_id
         LEFT JOIN workflows w ON w.id = r.workflow_id
         LEFT JOIN users u ON u.id = r.user_id
        WHERE ${where}
        ORDER BY s.waiting_since ASC, s.step_key ASC`,
      params,
    );
    return rows.map((r) => ({
      // The UNIQUE run handle the client echoes back to resume/view — unlike the caller-suppliable run_id.
      id: r.id,
      run_id: r.run_id,
      workflow_id: r.workflow_id,
      workflow_name: r.workflow_name,
      step_key: r.step_key,
      node_id: r.node_id,
      topic: r.waiting_topic,
      waiting_since: r.waiting_since?.toISOString() ?? null,
      timeout_at: r.waiting_timeout_at?.toISOString() ?? null,
      triggered_by: { id: r.triggered_by, email: r.triggered_by_email, name: r.triggered_by_name },
    }));
  }

  /** Answer one parked wait: the step named, else the one on `topic` that has waited longest. */
  async sendEvent(
    runId: string,
    topic: string,
    payload: unknown,
    access: RunAccess,
    stepKey?: string,
  ): Promise<void> {
    const em = this.dataSource?.manager;
    if (!em) {
      // Bare embedding (no history tables): DBOS buffers sends itself, and without the
      // runtime_runs row the caller may only resume their own run.
      if (isTimerWait(topic)) throw timerTopicRefusal(topic);
      this.requireDbos();
      return this.dbos.sendEvent(this.scopedRunId(access.userId, runId), topic, payload);
    }
    const { row } = await this.resolveActionableRun(em, runId, access);
    if (!row) throw new DomainError(`Run ${runId} not found`, 404);
    const scoped = row.id;
    const parked =
      row.status === 'waiting'
        ? await em.find(RuntimeRunStepEntity, { where: { runId: scoped, waitingTopic: Not(IsNull()) } })
        : [];
    const wait = waitFor(parked, topic, stepKey);
    if (!wait) throw noWaitOn(runId, topic, stepKey, parked);
    if (wait.waitingTimeoutAt && wait.waitingTimeoutAt.getTime() <= Date.now()) {
      throw new DomainError(`Run ${runId} is no longer waiting — the wait timed out`, 409);
    }
    const claim = await withWaitLock(em, scoped, (tx) => claimWait(tx, scoped, wait, access.userId));
    if (!claim) {
      const where = stepKey === undefined ? `on topic "${topic}"` : `at step "${stepKey}"`;
      throw new DomainError(`Run ${runId} is no longer waiting ${where}`, 409);
    }
    try {
      await this.deliver(em, runId, scoped, wait, payload);
    } catch (err) {
      await withWaitLock(em, scoped, (tx) => unclaimWait(tx, scoped, wait, claim));
      throw err;
    }
  }

  private async deliver(
    em: EntityManager,
    runId: string,
    scoped: string,
    wait: RuntimeRunStepEntity,
    payload: unknown,
  ): Promise<void> {
    const topic = eventTopicFor(wait.stepKey);
    if (this.dbosEnabled) {
      // Keyed to this one parked wait, so no resend can ever decide it twice.
      const key = `${scoped}|${wait.stepKey}|${wait.waitingSince?.toISOString()}`;
      await this.dbos.sendEvent(scoped, topic, payload, key);
      return;
    }
    if (this.waiters.get(scoped)?.deliver(topic, payload)) return;
    const run = await em.findOneBy(RuntimeRunEntity, { id: scoped });
    if (run?.status === 'cancelled') throw new DomainError(`Run ${runId} was cancelled`, 409);
    throw new DomainError(
      `Run ${runId} is no longer waiting (the run did not survive a restart; re-run the workflow)`,
      409,
    );
  }

  /**
   * Cancel a run: DBOS interrupts at the next step boundary; the direct path can only drop a
   * HITL waiter (best-effort). Idempotent — an already-terminal run returns its status unchanged.
   */
  async cancelRun(runId: string, access: RunAccess): Promise<RunStatus> {
    const em = this.dataSource?.manager;
    if (!em) {
      // Bare embedding (no history tables): only durable runs are addressable.
      this.requireDbos();
      await this.dbos.cancelWorkflow(this.scopedRunId(access.userId, runId));
      return { runId, status: 'cancelled' };
    }
    const { row } = await this.resolveActionableRun(em, runId, access);
    if (!row) throw new DomainError(`Run ${runId} not found`, 404);
    if (isTerminal(row.status)) return { runId, status: row.status };
    // Under the run's lock, so an event either lands before the cancel or finds its wait ended — never both.
    return withWaitLock(em, row.id, async (tx): Promise<RunStatus> => {
      const fresh = await tx.findOne(RuntimeRunEntity, { where: { id: row.id } });
      if (fresh && isTerminal(fresh.status)) return { runId, status: fresh.status };
      if (this.dbosEnabled) {
        await this.dbos.cancelWorkflow(row.id);
      } else {
        // Direct path: forget any HITL waiter (the in-process run can't be interrupted).
        this.waiters.delete(row.id);
      }
      await recordCancel(tx, row.id);
      return { runId, status: 'cancelled' };
    });
  }

  /** Linkage guard: the workflow must exist AND live in the caller's active org — anything else is an indistinguishable 404. */
  private async assertWorkflowRunnable(workflowId: string, activeOrgId: string | null): Promise<void> {
    const notFound = new DomainError(`Workflow ${workflowId} not found`, 404);
    if (!isIdShape(workflowId)) throw notFound;
    const em = this.dataSource?.manager;
    if (!em) throw notFound;
    const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
    if (!wf || wf.orgId !== activeOrgId) throw notFound;
  }

  /** The DBOS workflow id is namespaced per user, so a client-supplied `run_id` can never resolve or collide outside the caller's namespace. */
  private scopedRunId(externalUserId: string, runId: string): string {
    return `${externalUserId}:${runId}`;
  }

  /**
   * Resolve a run the caller may see/act on: their own, else — for an INTERACTIVE session only — any run in
   * their active org (the X-Org-Id guard already proved membership). A bearer credential never reaches another
   * member's run: org-wide reach exists for the human approvals inbox and consults no policy.
   */
  private async resolveActionableRun(
    em: EntityManager,
    runRef: string,
    access: RunAccess,
  ): Promise<{ row: RuntimeRunEntity | null; recorded: boolean }> {
    // Resolve the inbox's UNIQUE row id (`<owner>:<run>`) EXACTLY — the PK allows the same
    // run_id across users, so matching on run_id could pick the wrong run.
    const exact =
      (await em.findOne(RuntimeRunEntity, { where: { id: runRef } })) ??
      // Back-compat: a bare run_id, scoped to the caller so it can never resolve another user's run.
      (await em.findOne(RuntimeRunEntity, { where: { id: this.scopedRunId(access.userId, runRef) } }));
    if (exact) {
      const orgId = exact.orgId ?? (exact.workflowId ? await this.workflowOrgOf(em, exact.workflowId) : null);
      if (!reachesRun(access, { orgId, hasWorkflow: exact.workflowId !== null })) {
        return { row: null, recorded: true };
      }
      if (exact.userId === access.userId) return { row: exact, recorded: true };
      if (access.orgWide && access.activeOrgId && exact.workflowId) {
        const inOrg: unknown[] = await em.query(
          `SELECT 1 FROM workflows WHERE id = $1 AND org_id = $2 LIMIT 1`,
          [exact.workflowId, access.activeOrgId],
        );
        if (inOrg.length > 0) return { row: exact, recorded: true };
      }
      return { row: null, recorded: true }; // exists but not the caller's to touch → indistinguishable 404
    }
    return { row: null, recorded: false };
  }

  /** The org of a run's workflow, for a run recorded before runs kept their own; null when org-less or gone. */
  private async workflowOrgOf(em: EntityManager, workflowId: string): Promise<string | null> {
    const rows: Array<{ org_id: string | null }> = await em.query(
      `SELECT org_id FROM workflows WHERE id = $1`,
      [workflowId],
    );
    return rows[0]?.org_id ?? null;
  }

  private requireDbos(): void {
    if (!this.dbosEnabled) {
      throw new DomainError('Asynchronous runs require DBOS (set DBOS_ENABLED=true)', 409);
    }
  }
}

function durationMs(started: Date | null, finished: Date | null): number | null {
  if (!started || !finished) return null;
  return Math.max(0, finished.getTime() - started.getTime());
}

/** Find the compiled AGENT step for `nodeId` anywhere in the plan, including nested sub-plans (loop body, branch, error lane). */
function findAgentNode(plan: DagPlan, nodeId: string): DagAgentNode | null {
  for (const node of plan.nodes) {
    if (node.kind === 'agent' && node.id === nodeId) return node;
    const nested: DagPlan[] = [];
    if ('body' in node && node.body) nested.push(node.body);
    if ('branches' in node && Array.isArray(node.branches)) nested.push(...node.branches);
    if ('onErrorBranch' in node && node.onErrorBranch) nested.push(node.onErrorBranch);
    for (const sub of nested) {
      const found = findAgentNode(sub, nodeId);
      if (found) return found;
    }
  }
  return null;
}

/** One step of the run log; payload fields are WITHHELD, never blanked, when the read asked for no outputs. */
function stepLog(s: RuntimeRunStepEntity, includeOutputs: boolean): Record<string, unknown> {
  return {
    step_key: s.stepKey,
    node_id: s.nodeId,
    kind: s.kind,
    status: s.status,
    // Replayed (pinned) steps skipped the provider — the panel says "replayed".
    pinned: s.pinned,
    // Errored-but-tolerated (continue-on-fail): 'error' status, run went on.
    continued: s.continued,
    // How many provider calls this step took (retry-on-fail) — 1 unless retried.
    attempts: s.attempts,
    ...(includeOutputs
      ? {
          output: s.output ?? null,
          output_preview: previewOf(s.output),
          // Too large to store whole: `output_preview` is the head, and this says what was cut.
          output_truncated: truncationOf(s.output),
        }
      : {}),
    error: s.error,
    // Non-fatal reference warnings: full-string `{{ref}}`s that resolved to nothing on this step.
    warnings: s.warnings ?? null,
    waiting: stepWaitingOf(s),
    started_at: s.startedAt?.toISOString() ?? null,
    finished_at: s.finishedAt?.toISOString() ?? null,
  };
}

/** The stored step output, serialized and capped (~2KB) for list/detail rendering. */
function previewOf(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  // An oversized value was stored as its head — preview THAT, not the marker wrapping it.
  const stored = truncatedValueOf(output);
  const raw = stored ? stored.preview : JSON.stringify(output);
  return raw.length > OUTPUT_PREVIEW_CHARS ? `${raw.slice(0, OUTPUT_PREVIEW_CHARS)}…` : raw;
}

/** What was cut from an oversized step output, or null when the value was stored whole. */
function truncationOf(output: unknown): { size_chars: number; max_chars: number } | null {
  const stored = truncatedValueOf(output);
  return stored ? { size_chars: stored.size_chars, max_chars: stored.max_chars } : null;
}
