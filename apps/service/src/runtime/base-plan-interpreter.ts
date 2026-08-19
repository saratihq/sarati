import { Logger } from '@nestjs/common';

import { errorMessage } from '../common/error-message';
import { PassThroughDurableStep, type DurableStep } from '../providers/durable-step';
import type { ManagedIntegrationProvider } from '../providers/managed-integration-provider';
import {
  AgentStepsExhausted,
  type AgentMessage,
  type AgentModelAuth,
  type AgentModelPort,
  type AgentProvider,
  type AgentResult,
  type AgentStep,
  type AgentStepSink,
  type AgentToolCatalog,
  type AgentWorkflowCatalog,
  type DagAgentTool,
  type JsonSchema,
  type ToolSchema,
  type Usage,
} from './agent';
import type { BlobStore } from './blob-store';
import { CodeRunner, type CodeInput } from './code-runner';
import { evaluateCondition, type Condition } from './conditions';
import { resolveReference, resolveReferences } from './reference-resolver';
import type { RuntimeStepKind } from '../database/entities/runtime-run.entity';
import type { RunRecorder } from './run-recorder.service';
import type { RunResult, TraceEntry } from './run-plan';
import type { SubWorkflowRunner } from './sub-workflow-runner';

export interface RunOptions {
  /** Our end-user identity — scopes connections/accounts per tenant. */
  externalUserId: string;
  /** Durability substrate each action runs under; defaults to the non-durable pass-through. */
  durable?: DurableStep;
  /** Scoped run id for history recording — both or neither with `recorder`, else recording is off. */
  runId?: string;
  /** Run-history recorder — both or neither with `runId`, else recording is off. */
  recorder?: RunRecorder;
  /** Seed values for the run scope; triggers put the firing event here as `trigger`. */
  initialScope?: Record<string, unknown>;
  /** Execution-time output overrides keyed by node id — a pinned node replays instead
   *  of executing. Ephemeral run input: never enters the doc, IR, diff, merge, or `irContentKey`. */
  pins?: Record<string, unknown>;
  /** Display-name snapshot of the run's env (with `orgId`, the legacy pre-006 resolution key). */
  environment?: string | null;
  /** Env-scoped run → steps resolve their account through the env's slots; unset = personal pool. */
  environmentId?: string | null;
  /** Org scope for legacy pre-006 env resolution. */
  orgId?: string | null;
  /** Dry run (preview): no state-changing external call fires; delays/waits skip. Default false. */
  dryRun?: boolean;
  /** Scoped `workflow:env:session` channel agent steps stream to; absent → publishes nothing. */
  chatChannelKey?: string | null;
  /** Sub-workflow-as-tool call depth; bounded by {@link MAX_SUB_WORKFLOW_DEPTH}. Absent → 0. */
  subWorkflowDepth?: number;
  /** The ONE tree-wide sub-workflow invocation budget; absent at a top level → a fresh one. */
  subWorkflowBudget?: { remaining: number };
}

/** Threaded through the recursion so nested action ids stay durable-key-unique. */
export interface RunContext {
  durable: DurableStep;
  externalUserId: string;
  environment: string | null;
  environmentId: string | null;
  orgId: string | null;
  planId: string;
  /** Scope key for this run's file blobs (the scoped run id, else the plan id). */
  runId: string;
  trace: TraceEntry[];
  /** Non-fatal per-step honesty notes keyed by step key, folded onto the matching {@link TraceEntry}. */
  stepWarnings: Map<string, string[]>;
  /** Set only when recording is active (runId + recorder both provided). */
  record: { runId: string; recorder: RunRecorder } | null;
  /** Execution-time node overrides; null when the run carries none. */
  pins: Map<string, unknown> | null;
  /** Dry run (preview): no state-changing external call fires; delays/waits skip. */
  dryRun: boolean;
  /** The scoped `workflow:env:session` channel agent steps stream to; null on non-chat runs. */
  chatChannelKey: string | null;
  /** Sub-workflow call depth — 0 at the top level, +1 per nested entry. */
  subWorkflowDepth: number;
  /** ONE mutable invocation counter shared by reference across the whole run tree —
   *  bounds total sub-workflow WORK, which the per-branch depth cap cannot. */
  subWorkflowBudget: { remaining: number };
}

/** Run-time recursion bound on sub-workflow-as-tool nesting depth; exceeding it is a tool error. */
export const MAX_SUB_WORKFLOW_DEPTH = 8;

/** Tree-wide cap on total sub-workflow invocations per root run — the breadth guard depth can't give. */
export const MAX_SUB_WORKFLOW_INVOCATIONS = 64;

/** The action-payload subset the executor needs — shared by `ActionNode` and `DagActionNode`, minus the error lane. */
export interface ExecutableAction {
  id: string;
  actionId: string;
  props: Record<string, unknown>;
  auth?: unknown;
  onError?: 'continue';
  retry?: { maxAttempts: number; backoffMs: number };
}

/** The code-node fields the executor needs — the subset `DagCodeNode` carries (minus the error lane). */
export interface ExecutableCode {
  id: string;
  /** Runnable JavaScript (already transpiled at compile time). */
  code: string;
  onError?: 'continue';
  retry?: { maxAttempts: number; backoffMs: number };
}

/** The agent fields the executor needs — the subset `DagAgentNode` carries (its tools + model config). */
export interface ExecutableAgent {
  id: string;
  systemPrompt: string;
  model: { provider: AgentProvider; model: string };
  maxSteps: number;
  input?: string;
  /** Test-run override (B5): `input` is a verbatim message, never resolved. */
  inputLiteral?: boolean;
  auth?: unknown;
  tools: DagAgentTool[];
}

/** The call-workflow fields the executor needs — the subset `DagCallWorkflowNode` carries. */
export interface ExecutableCallWorkflow {
  id: string;
  workflowId: string;
  input: Record<string, unknown>;
  onError?: 'continue';
}

/** The per-node failure-policy fields shared by every leaf (action, code, agent, call-workflow). */
interface LeafPolicy {
  id: string;
  onError?: 'continue';
}

/** Permissive open-object fallback tool `parameters`; `additionalProperties` is omitted deliberately
 *  (open is the JSON Schema default, and Gemini's OpenAPI-subset Schema has no such key). */
const OPEN_TOOL_SCHEMA: JsonSchema = { type: 'object', properties: {} };

/** First argument that is a non-blank string, else undefined — `''`/whitespace counts as absent. */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) if (value !== undefined && value.trim() !== '') return value;
  return undefined;
}

/** Durable-delay fields shared by `DelayNode` / `DagDelayNode`. */
export interface ExecutableDelay {
  id: string;
  ms: number;
}

/** Human-in-the-loop wait fields shared by `WaitForEventNode` / `DagWaitForEventNode`. */
export interface ExecutableWait {
  id: string;
  topic: string;
  timeoutMs: number;
}

/** Iteration fields shared by `ForEachNode` / `DagForEachNode` (the body is run by the caller). */
export interface ExecutableForEach {
  id: string;
  items: string;
  itemVar: string;
}

/** Condition-loop fields the executor needs — the subset `DagWhileNode` carries (the body is run by the caller). */
export interface ExecutableWhile {
  id: string;
  condition: Condition;
  maxIterations: number;
}

/** Control sentinel: thrown after a node's error lane runs to unwind the plan walk —
 *  `runProgram()` catches it and finishes the run `completed`. Not a real error. */
export class ErrorLaneHalt extends Error {
  constructor() {
    super('error lane completed');
    this.name = 'ErrorLaneHalt';
  }
}

/**
 * The per-node execution core beneath the gating-scheduler `DagInterpreter`: run
 * lifecycle, the durable provider seam, pin replay, and retry/continue-on-fail/error-lane
 * . Subclasses inject ONLY scheduling — per-node semantics live here alone.
 */
export abstract class BasePlanInterpreter {
  protected readonly logger = new Logger(this.constructor.name);
  protected readonly provider: ManagedIntegrationProvider;
  /** Sandbox for `orchestr:code` leaves; default-constructed when unwired. */
  protected readonly codeRunner: CodeRunner;
  /** Tool-aware model call for `orchestr:agent`; unbound → an agent step fails loudly. */
  protected readonly agentModel?: AgentModelPort;
  /** Describes an action tool's JSON-schema/description from its prop schema; optional. */
  protected readonly agentToolCatalog?: AgentToolCatalog;
  /** Live step-stream sink for `orchestr:agent`; unbound → the loop streams nothing. */
  protected readonly agentStepSink?: AgentStepSink;
  /** Sub-workflow runner, shared by the agent tool and the authored step; setter-injected
   *  because a constructor dep would be a module cycle. */
  protected subWorkflowRunner?: SubWorkflowRunner;
  /** Declared contract for a sub-workflow tool; setter-injected for the same cycle. */
  protected agentWorkflowCatalog?: AgentWorkflowCatalog;

  constructor(
    provider: ManagedIntegrationProvider,
    private readonly blobStore?: BlobStore,
    codeRunner?: CodeRunner,
    agentModel?: AgentModelPort,
    agentToolCatalog?: AgentToolCatalog,
    agentStepSink?: AgentStepSink,
  ) {
    this.provider = provider;
    this.codeRunner = codeRunner ?? new CodeRunner();
    this.agentModel = agentModel;
    this.agentToolCatalog = agentToolCatalog;
    this.agentStepSink = agentStepSink;
  }

  /** Bind the sub-workflow runner — called once by `RunsService`. */
  setSubWorkflowRunner(runner: SubWorkflowRunner): void {
    this.subWorkflowRunner = runner;
  }

  /** Bind the sub-workflow tool contract source — called once by `RunsService`. */
  setAgentWorkflowCatalog(catalog: AgentWorkflowCatalog): void {
    this.agentWorkflowCatalog = catalog;
  }

  /** Run a whole plan under the shared lifecycle envelope: context, scope, `schedule`, terminal record, blob cleanup. */
  protected async runProgram<N>(
    plan: { id: string; nodes: N[] },
    opts: RunOptions,
    schedule: (nodes: N[], scope: Record<string, unknown>, path: string, ctx: RunContext) => Promise<void>,
  ): Promise<RunResult> {
    const ctx: RunContext = {
      durable: opts.durable ?? new PassThroughDurableStep(),
      externalUserId: opts.externalUserId,
      environment: opts.environment ?? null,
      environmentId: opts.environmentId ?? null,
      orgId: opts.orgId ?? null,
      planId: plan.id,
      runId: opts.runId ?? plan.id,
      trace: [],
      stepWarnings: new Map(),
      record: opts.runId && opts.recorder ? { runId: opts.runId, recorder: opts.recorder } : null,
      // A Map so membership survives a pinned `undefined`/`null` and a node id like "constructor".
      pins: opts.pins && Object.keys(opts.pins).length > 0 ? new Map(Object.entries(opts.pins)) : null,
      dryRun: opts.dryRun ?? false,
      chatChannelKey: opts.chatChannelKey ?? null,
      subWorkflowDepth: opts.subWorkflowDepth ?? 0,
      // A nested run inherits the root's counter by reference; a top-level run mints a fresh one.
      subWorkflowBudget: opts.subWorkflowBudget ?? { remaining: MAX_SUB_WORKFLOW_INVOCATIONS },
    };
    const scope: Record<string, unknown> = { ...(opts.initialScope ?? {}) };
    this.logger.log(`run plan ${plan.id}: ${plan.nodes.length} node(s)`);
    try {
      try {
        await schedule(plan.nodes, scope, '', ctx);
      } catch (err) {
        // An error lane ran to completion — the run is DONE and SUCCESSFUL.
        if (err instanceof ErrorLaneHalt) {
          await ctx.record?.recorder.runFinished(ctx.record.runId, scope, null);
          return { planId: plan.id, outputs: scope, trace: ctx.trace };
        }
        // Terminal state is written HERE, not by the caller, so a DBOS crash-resume
        // that finishes the workflow also finishes the record.
        await ctx.record?.recorder.runFinished(ctx.record.runId, null, errorMessage(err));
        throw err;
      }
      await ctx.record?.recorder.runFinished(ctx.record.runId, scope, null);
      return { planId: plan.id, outputs: scope, trace: ctx.trace };
    } finally {
      // Only reached at true completion: a `waitForEvent` pause is still awaiting inside
      // `schedule`, and a crash never runs `finally`, so a durable resume still finds the blobs.
      await this.cleanupBlobs(ctx.runId);
    }
  }

  /** Best-effort removal of a run's file blobs; a cleanup failure never fails the run. */
  private async cleanupBlobs(runId: string): Promise<void> {
    if (!this.blobStore) return;
    try {
      const removed = await this.blobStore.deleteRun(runId);
      if (removed > 0) this.logger.log(`run ${runId}: cleaned up ${removed} file blob(s)`);
    } catch (err) {
      this.logger.warn(`run ${runId}: file-blob cleanup failed: ${errorMessage(err)}`);
    }
  }

  /** Execute ONE action leaf — resolve refs / pin-replay / run through the durable provider seam. */
  protected executeAction(
    node: ExecutableAction,
    scope: Record<string, unknown>,
    path: string,
    ctx: RunContext,
    runErrorLane: (() => Promise<void>) | null,
  ): Promise<void> {
    return this.executeLeaf(node, scope, path, ctx, 'action', runErrorLane, (stepKey) =>
      this.runAction(node, scope, stepKey, ctx),
    );
  }

  /** Execute ONE code leaf — run the snippet in the sandbox with the run scope as input. */
  protected executeCode(
    node: ExecutableCode,
    scope: Record<string, unknown>,
    path: string,
    ctx: RunContext,
    runErrorLane: (() => Promise<void>) | null,
  ): Promise<void> {
    return this.executeLeaf(node, scope, path, ctx, 'code', runErrorLane, (stepKey) =>
      this.runCode(node, scope, stepKey, ctx),
    );
  }

  /** Execute ONE agent leaf — run the durable tool-calling loop, writing `{ text, steps, usage }` to scope. */
  protected executeAgent(
    node: ExecutableAgent,
    scope: Record<string, unknown>,
    path: string,
    ctx: RunContext,
    runErrorLane: (() => Promise<void>) | null,
  ): Promise<void> {
    // A truncated result hands off to the error lane if there is one, else returns as a truncated success.
    const hasErrorLane = runErrorLane !== null;
    return this.executeLeaf(node, scope, path, ctx, 'agent', runErrorLane, (stepKey) =>
      this.runAgentLoop(node, scope, stepKey, ctx, hasErrorLane),
    );
  }

  /**
   * Execute ONE call-workflow leaf — run the child nested and write its terminal output
   * to scope, so `{{<node id>}}` reads it exactly like any other step's result.
   */
  protected executeCallWorkflow(
    node: ExecutableCallWorkflow,
    scope: Record<string, unknown>,
    path: string,
    ctx: RunContext,
    runErrorLane: (() => Promise<void>) | null,
  ): Promise<void> {
    return this.executeLeaf(node, scope, path, ctx, 'callWorkflow', runErrorLane, (stepKey) =>
      this.runSubWorkflow(node, scope, stepKey, ctx),
    );
  }

  /**
   * Run ONE sub-workflow as the parent's single durable checkpoint. No invocation budget is passed:
   * an authored step's fan-out is bounded by the loop the author wrote, unlike an agent's, which is
   * the model's choice. Depth still applies, and is what bounds an indirect cycle.
   */
  private async runSubWorkflow(
    node: ExecutableCallWorkflow,
    scope: Record<string, unknown>,
    stepKey: string,
    ctx: RunContext,
  ): Promise<unknown> {
    const runner = this.subWorkflowRunner;
    if (!runner) throw new Error('Sub-workflow steps are not available in this runtime');
    const unresolved = new Set<string>();
    const input = resolveReferences(node.input, scope, (ref) => unresolved.add(ref));
    await this.warn(ctx, stepKey, [...unresolved].map(unresolvedNote));
    return ctx.durable.run(`${ctx.planId}:${stepKey}`, () =>
      runner.run(
        { workflowId: node.workflowId, input },
        {
          externalUserId: ctx.externalUserId,
          environment: ctx.environment,
          environmentId: ctx.environmentId,
          orgId: ctx.orgId,
          parentRunId: ctx.runId,
          callKey: stepKey,
          depth: ctx.subWorkflowDepth,
          budget: ctx.subWorkflowBudget,
          dryRun: ctx.dryRun,
        },
      ),
    );
  }

  /**
   * The shared leaf execution core for every work-bearing leaf: duplicate-id guard, pin replay
   * , recording, and the failure policy (error lane > `onError` > halt).
   */
  private async executeLeaf(
    node: LeafPolicy,
    scope: Record<string, unknown>,
    path: string,
    ctx: RunContext,
    kind: 'action' | 'code' | 'agent' | 'callWorkflow',
    runErrorLane: (() => Promise<void>) | null,
    run: (stepKey: string) => Promise<unknown>,
  ): Promise<void> {
    if (Object.prototype.hasOwnProperty.call(scope, node.id)) {
      throw new Error(`Duplicate node id "${node.id}" in plan ${ctx.planId}`);
    }
    const stepKey = `${path}${node.id}`;
    // A pinned node REPLAYS its captured output — the work never runs (no side
    // effects, no API hit), but the step is still recorded so downstream refs resolve.
    const isPinned = ctx.pins?.has(node.id) ?? false;
    try {
      const output = await this.recorded(
        ctx,
        stepKey,
        node.id,
        kind,
        () => (isPinned ? Promise.resolve(ctx.pins!.get(node.id)) : run(stepKey)),
        isPinned,
      );
      scope[node.id] = output;
      const warnings = ctx.stepWarnings.get(stepKey);
      ctx.trace.push({ nodeId: stepKey, output, ...(warnings?.length ? { warnings } : {}) });
    } catch (err) {
      // Capture the error into scope so `{{node.error.message}}` resolves. An agent that
      // exhausted `max_steps` carries its partial result — merge it so the lane can still
      // read `{{node.text}}` (the partial answer is never discarded).
      const partial = err instanceof AgentStepsExhausted ? err.result : undefined;
      const captured = {
        ...(partial ?? {}),
        error: { message: errorMessage(err) },
        __errored: true,
      };
      // An error lane WINS over `onError` — it replaces the node's main
      // successors and then ends the run. Never both lanes.
      if (runErrorLane) {
        scope[node.id] = captured;
        ctx.trace.push({ nodeId: stepKey, output: captured });
        if (ctx.record) await ctx.record.recorder.stepContinued(ctx.record.runId, stepKey);
        await runErrorLane();
        throw new ErrorLaneHalt();
      }
      // Continue-on-fail: tolerate the throw; any other node halts the run.
      if (node.onError !== 'continue') throw err;
      scope[node.id] = captured;
      ctx.trace.push({ nodeId: stepKey, output: captured });
      if (ctx.record) await ctx.record.recorder.stepContinued(ctx.record.runId, stepKey);
    }
  }

  /** Durable delay leaf (produces no scope output) — identical across interpreters. */
  protected async executeDelay(
    node: ExecutableDelay,
    _scope: Record<string, unknown>,
    path: string,
    ctx: RunContext,
  ): Promise<void> {
    const stepKey = `${path}${node.id}`;
    await this.recorded(ctx, stepKey, node.id, 'delay', async () => {
      // Dry run: don't actually make the preview wait.
      if (ctx.dryRun) return { dry_run: true, skipped_delay_ms: node.ms };
      await ctx.durable.sleep(`${ctx.planId}:${stepKey}`, node.ms);
      return null;
    });
  }

  /** Human-in-the-loop wait leaf — identical across interpreters. */
  protected async executeWaitForEvent(
    node: ExecutableWait,
    scope: Record<string, unknown>,
    path: string,
    ctx: RunContext,
  ): Promise<void> {
    if (Object.prototype.hasOwnProperty.call(scope, node.id)) {
      throw new Error(`Duplicate node id "${node.id}" in plan ${ctx.planId}`);
    }
    const stepKey = `${path}${node.id}`;
    const record = ctx.record;
    const payload = await this.recorded(ctx, stepKey, node.id, 'waitForEvent', async () => {
      // Dry run: don't park the preview waiting for a human — return a stub.
      if (ctx.dryRun) return { dry_run: true, skipped: 'wait-for-event (dry run)' };
      // Register the receiver BEFORE persisting the pause, so anyone who observes the
      // waiting row is guaranteed a receiver already exists to deliver to.
      const wait = ctx.durable.waitForEvent(`${ctx.planId}:${stepKey}`, node.topic, node.timeoutMs);
      await record?.recorder.runWaiting(
        record.runId,
        node.id,
        node.topic,
        new Date(Date.now() + node.timeoutMs),
      );
      try {
        return await wait;
      } finally {
        await record?.recorder.runResumed(record.runId);
      }
    });
    scope[node.id] = payload;
    ctx.trace.push({ nodeId: stepKey, output: payload });
  }

  /**
   * Run ONE loop round and return only the outputs the body NEWLY produced. Shared by both loop
   * drivers; `childScope` is left mutated so a caller can evaluate a post-round condition on it.
   */
  private async runRound(
    childScope: Record<string, unknown>,
    childPath: string,
    runBody: (childScope: Record<string, unknown>, childPath: string) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const inherited = new Set(Object.keys(childScope));
    await runBody(childScope, childPath);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(childScope)) if (!inherited.has(key)) output[key] = childScope[key];
    return output;
  }

  /**
   * Per-item iteration: run `body` once per element in a child scope (item + index bound);
   * the node's output is the array of per-iteration outputs.
   */
  protected async executeForEach(
    node: ExecutableForEach,
    scope: Record<string, unknown>,
    path: string,
    ctx: RunContext,
    runBody: (childScope: Record<string, unknown>, childPath: string) => Promise<void>,
  ): Promise<void> {
    const resolved = resolveReference(node.items, scope);
    if (!Array.isArray(resolved)) {
      throw new Error(`forEach "${node.id}": items "${node.items}" did not resolve to an array`);
    }
    const items: unknown[] = resolved;
    const perIteration: Record<string, unknown>[] = [];
    for (let i = 0; i < items.length; i++) {
      const childScope: Record<string, unknown> = {
        ...scope,
        [node.itemVar]: items[i],
        [`${node.itemVar}Index`]: i,
      };
      perIteration.push(await this.runRound(childScope, `${path}${node.id}#${i}/`, runBody));
    }
    scope[node.id] = perIteration;
  }

  /**
   * DO-WHILE iteration: round 1 always runs, then `condition` is tested after each round
   * against that round's child scope; `maxIterations` is a hard clean stop (the infinite-loop guarantee).
   * Each round's scope is seeded with `{{<loop id>}}` (prior rounds), `{{loopRound}}` and `{{loopPrev}}`.
   */
  protected async executeWhile(
    node: ExecutableWhile,
    scope: Record<string, unknown>,
    path: string,
    ctx: RunContext,
    runBody: (childScope: Record<string, unknown>, childPath: string) => Promise<void>,
  ): Promise<void> {
    const perRound: Record<string, unknown>[] = [];
    for (let round = 0; round < node.maxIterations; round++) {
      const childScope: Record<string, unknown> = {
        ...scope,
        [node.id]: [...perRound],
        loopRound: round,
        loopPrev: round > 0 ? perRound[round - 1] : undefined,
      };
      // `runRound` leaves `childScope` carrying this round's body outputs, so the
      // post-round do-while condition below reads them (e.g. `{{poll.body.ready}}`).
      perRound.push(await this.runRound(childScope, `${path}${node.id}#${round}/`, runBody));
      const unresolved = new Set<string>();
      const again = evaluateCondition(node.condition, childScope, (ref) => unresolved.add(ref));
      await this.recordUndecidableRouting(
        ctx,
        `${path}${node.id}#${round}:condition`,
        node.id,
        'if',
        again ? 0 : 1,
        unresolved,
      );
      if (!again) break;
    }
    scope[node.id] = perRound;
  }

  /** Concurrent branches: each runs on its own scope copy; new outputs merge back afterwards. */
  protected async executeParallel(
    node: { id: string },
    branchCount: number,
    scope: Record<string, unknown>,
    path: string,
    ctx: RunContext,
    runBranch: (branchScope: Record<string, unknown>, index: number, childPath: string) => Promise<void>,
  ): Promise<void> {
    const branchScopes = Array.from({ length: branchCount }, () => ({ ...scope }));
    await Promise.all(
      branchScopes.map((branchScope, i) => runBranch(branchScope, i, `${path}${node.id}|${i}/`)),
    );
    // Merge each branch's new outputs back into the shared scope.
    for (const branchScope of branchScopes) {
      for (const key of Object.keys(branchScope)) {
        if (!Object.prototype.hasOwnProperty.call(scope, key)) scope[key] = branchScope[key];
      }
    }
  }

  /** Run one step with history recording (started → finished/error) when active. */
  private async recorded<T>(
    ctx: RunContext,
    stepKey: string,
    nodeId: string,
    kind: RuntimeStepKind,
    fn: () => Promise<T>,
    pinned = false,
  ): Promise<T> {
    if (!ctx.record) return fn();
    const { runId, recorder } = ctx.record;
    await recorder.stepStarted(runId, stepKey, nodeId, kind, pinned);
    try {
      const output = await fn();
      await recorder.stepFinished(runId, stepKey, output, null);
      return output;
    } catch (err) {
      await recorder.stepFinished(runId, stepKey, null, errorMessage(err));
      throw err;
    }
  }

  /**
   * Execute one (non-pinned) action through the durable provider seam — one checkpoint per action;
   * the path keeps loop iterations distinct so DBOS can't hand iteration N iteration 0's result.
   */
  private async runAction(
    node: ExecutableAction,
    scope: Record<string, unknown>,
    stepKey: string,
    ctx: RunContext,
  ): Promise<unknown> {
    // Honesty: collect full-string `{{ref}}`s that resolved to nothing. Never changes
    // the resolved props or fails the step.
    const unresolved = new Set<string>();
    const props = resolveReferences(node.props, scope, (ref) => unresolved.add(ref));
    // The retry loop lives INSIDE the single durable step body: DBOS
    // keeps one checkpoint per node and never memoises a mid-retry throw.
    const result = await ctx.durable.run(`${ctx.planId}:${stepKey}`, () =>
      this.runWithRetry(node.retry, stepKey, ctx, () =>
        this.provider.runAction({
          externalUserId: ctx.externalUserId,
          actionId: node.actionId,
          props,
          auth: node.auth,
          runId: ctx.runId,
          // Stable across a DBOS crash-replay, so a re-run dedupes side effects.
          idempotencyKey: `${ctx.runId}:${stepKey}`,
          dryRun: ctx.dryRun,
          environment: ctx.environment,
          environmentId: ctx.environmentId,
          orgId: ctx.orgId,
        }),
      ),
    );
    await this.warn(ctx, stepKey, [
      ...[...unresolved].map(unresolvedNote),
      ...(Array.isArray(result.warnings) ? result.warnings : []),
    ]);
    return result.output;
  }

  /**
   * Execute one (non-pinned) code leaf: hand the sandbox the run scope as `steps`
   * (+ a `trigger` alias). The runner JSON-copies the scope, so the snippet cannot mutate it.
   */
  private runCode(
    node: ExecutableCode,
    scope: Record<string, unknown>,
    stepKey: string,
    ctx: RunContext,
  ): Promise<unknown> {
    const input: CodeInput = { steps: scope, trigger: scope.trigger };
    return ctx.durable.run(`${ctx.planId}:${stepKey}`, () =>
      this.runWithRetry(node.retry, stepKey, ctx, () => this.codeRunner.run({ code: node.code, input })),
    );
  }

  /**
   * The durable tool-calling agent loop — model call, then each requested tool, each
   * its own durable step keyed distinctly per round so a crash-resume never re-fires a side effect.
   * A throwing tool is fed back as an error (§7); only exhausting `max_steps` throws
   * {@link AgentStepsExhausted}, which the leaf machinery routes to the error lane.
   */
  private async runAgentLoop(
    node: ExecutableAgent,
    scope: Record<string, unknown>,
    stepKey: string,
    ctx: RunContext,
    hasErrorLane: boolean,
  ): Promise<AgentResult> {
    const model = this.agentModel;
    if (!model) {
      throw new Error(`Agent "${node.id}" cannot run: no tool-aware model call is configured`);
    }
    const tools = await this.buildToolSchemas(node.tools, ctx);
    const buffer: AgentMessage[] = [];
    // First user message: the `input` expression resolved against scope, else the trigger
    // payload; `inputLiteral` (test runs) passes verbatim — a typed task is not an expression.
    const unresolvedInput = new Set<string>();
    const inputValue =
      node.input !== undefined
        ? node.inputLiteral
          ? node.input
          : resolveReference(node.input, scope, (ref) => unresolvedInput.add(ref))
        : scope.trigger;
    await this.warn(ctx, stepKey, [...unresolvedInput].map(unresolvedNote));
    buffer.push({ role: 'user', content: renderAgentContent(inputValue) });

    const steps: AgentStep[] = [];
    const usage: Usage = {};

    // `max_steps` caps the model calls, so an always-tool-calling model provably terminates.
    for (let round = 0; round < node.maxSteps; round++) {
      const turn = await ctx.durable.run(`${ctx.planId}:${stepKey}#${round}:model`, () =>
        model.call(
          {
            provider: node.model.provider,
            model: node.model.model,
            system: node.systemPrompt,
            messages: buffer,
            tools,
          },
          this.agentModelAuth(node, ctx),
        ),
      );
      addUsage(usage, turn.usage);
      this.emitAgentStep(steps, ctx, { kind: 'model', text: turn.text });

      if (turn.toolCalls.length === 0) {
        const text = turn.text ?? '';
        this.emitAgentStep(steps, ctx, { kind: 'final', text });
        return { text, steps, usage };
      }

      buffer.push({ role: 'assistant', content: turn.text ?? '', toolCalls: turn.toolCalls });
      for (const call of turn.toolCalls) {
        let output: unknown;
        try {
          output = await this.invokeAgentTool(node, call, scope, `${stepKey}#${round}`, ctx);
        } catch (err) {
          // §7: a tool error is fed back as its result — the model may recover within the budget.
          output = { error: { message: errorMessage(err) } };
        }
        this.emitAgentStep(steps, ctx, { kind: 'tool', tool: call.name, input: call.input, output });
        buffer.push({ role: 'tool', toolCallId: call.id, content: renderAgentContent(output) });
      }
    }

    // §7 — `max_steps` hit without a final answer: one last model call with NO tools forces a
    // natural-language close-out from the running buffer rather than discarding the partial.
    const synth = await ctx.durable.run(`${ctx.planId}:${stepKey}#final:model`, () =>
      model.call(
        {
          provider: node.model.provider,
          model: node.model.model,
          system: node.systemPrompt,
          messages: buffer,
          tools: [], // force a natural-language close-out, not another tool round
        },
        this.agentModelAuth(node, ctx),
      ),
    );
    addUsage(usage, synth.usage);
    const text = synth.text ?? '';
    this.emitAgentStep(steps, ctx, { kind: 'final', text });
    const result: AgentResult = { text, steps, usage, truncated: true };

    // With a lane present the throw hands off to it CARRYING the partial (§7); with no lane
    // the truncated result is returned as a bounded success.
    if (hasErrorLane) throw new AgentStepsExhausted(node.maxSteps, result);
    return result;
  }

  /**
   * The auth context each model call receives: the node's connection + tenant + the
   * run's env scope. The model port, not the interpreter, owns the env-slot-wins decision.
   */
  private agentModelAuth(node: ExecutableAgent, ctx: RunContext): AgentModelAuth {
    return {
      connection: node.auth,
      externalUserId: ctx.externalUserId,
      environment: ctx.environment,
      environmentId: ctx.environmentId,
      orgId: ctx.orgId,
    };
  }

  /**
   * Record ONE agent step and publish it to the live SSE side-channel. `step_index` is
   * per-invocation, NOT the stream dedup key — the bus stamps its own session-unique `seq`.
   */
  private emitAgentStep(steps: AgentStep[], ctx: RunContext, step: Omit<AgentStep, 'step_index'>): void {
    const recorded: AgentStep = { step_index: steps.length, ...step };
    steps.push(recorded);
    this.publishAgentStep(ctx, recorded);
  }

  /**
   * Publish one recorded step to the run's scoped chat channel — best-effort live UX.
   * A publish failure is swallowed: the durable run's recorded `steps[]` is the source of truth.
   */
  private publishAgentStep(ctx: RunContext, step: AgentStep): void {
    const channelKey = ctx.chatChannelKey;
    if (!channelKey || !this.agentStepSink) return;
    try {
      this.agentStepSink.publish(channelKey, step);
    } catch (err) {
      this.logger.warn(`agent step stream publish failed: ${errorMessage(err)}`);
    }
  }

  /**
   * Resolve + invoke ONE tool the model requested, as a durable step: an action tool through the
   * provider seam, a sub-workflow tool through the injected runner. Throws on an
   * unknown tool name or unbound runner — the loop catches it and feeds it back.
   */
  private async invokeAgentTool(
    node: ExecutableAgent,
    call: { id: string; name: string; input: unknown },
    scope: Record<string, unknown>,
    roundKey: string,
    ctx: RunContext,
  ): Promise<unknown> {
    const tool = node.tools.find((t) => t.name === call.name);
    if (!tool) throw new Error(`Agent requested an unknown tool "${call.name}"`);
    const stepKey = `${roundKey}:tool:${call.id}`;

    if (tool.kind === 'workflow') {
      const runner = this.subWorkflowRunner;
      if (!runner) throw new Error('sub-workflow tools are not available in this runtime');
      // BREADTH guard: charged HERE because this is where unbounded fan-out can come
      // from — how often a MODEL calls is its own choice. One counter for the whole run tree;
      // check-then-decrement with NO await between, so concurrent tool calls can't both slip past.
      if (ctx.subWorkflowBudget.remaining <= 0) {
        throw new Error(
          `Sub-workflow invocation budget (${MAX_SUB_WORKFLOW_INVOCATIONS}) exhausted for this run — too many sub-workflow calls in one run. Reduce how often the agents call sub-workflows.`,
        );
      }
      ctx.subWorkflowBudget.remaining -= 1;
      // The whole sub-run is the parent's single checkpoint and runs AS the caller (same tenant +
      // env scope). `callKey` + `parentRunId` seed a deterministic sub-run id so a crash re-run
      // re-issues the SAME step idempotency keys — the SDK rail dedupes on them, but the
      // Composio rail carries none, so a non-idempotent Composio sub-step is at-least-once.
      return ctx.durable.run(`${ctx.planId}:${stepKey}`, () =>
        runner.run(
          { workflowId: tool.workflowId, input: call.input },
          {
            externalUserId: ctx.externalUserId,
            environment: ctx.environment,
            environmentId: ctx.environmentId,
            orgId: ctx.orgId,
            parentRunId: ctx.runId,
            callKey: stepKey,
            depth: ctx.subWorkflowDepth,
            budget: ctx.subWorkflowBudget,
            dryRun: ctx.dryRun,
          },
        ),
      );
    }

    // Action tool: base props (already ref-translated at compile time) overlaid by the
    // model's structured input, then resolved against the run scope like any action.
    const modelInput =
      call.input !== null && typeof call.input === 'object' && !Array.isArray(call.input)
        ? (call.input as Record<string, unknown>)
        : {};
    const unresolved = new Set<string>();
    const props = resolveReferences({ ...tool.props, ...modelInput }, scope, (ref) => unresolved.add(ref));
    await this.warn(ctx, stepKey, [...unresolved].map(unresolvedNote));
    return ctx.durable
      .run(`${ctx.planId}:${stepKey}`, () =>
        this.provider.runAction({
          externalUserId: ctx.externalUserId,
          actionId: tool.actionId,
          props,
          auth: tool.auth,
          runId: ctx.runId,
          idempotencyKey: `${ctx.runId}:${stepKey}`,
          dryRun: ctx.dryRun,
          environment: ctx.environment,
          environmentId: ctx.environmentId,
          orgId: ctx.orgId,
        }),
      )
      .then((result) => result.output);
  }

  /**
   * Build the tool schemas the model call receives: an action tool's is derived from
   * its prop schema via the optional catalog, a sub-workflow tool's is declared. Author text wins.
   */
  private async buildToolSchemas(tools: DagAgentTool[], ctx: RunContext): Promise<ToolSchema[]> {
    return Promise.all(
      tools.map(async (tool) => {
        if (tool.kind === 'workflow') {
          // What the sub-workflow DECLARES about being called; never inferred from its expressions,
          // which would publish a contract nobody wrote down.
          const declared = await this.agentWorkflowCatalog?.describeWorkflow(
            tool.workflowId,
            ctx.environmentId,
          );
          // Never emit an empty description — it is the top degrader of model tool selection.
          return {
            name: tool.name,
            description:
              firstNonEmpty(tool.description, declared?.description) ?? `Runs the ${tool.name} workflow`,
            parameters: tool.parameters ?? declared?.parameters ?? OPEN_TOOL_SCHEMA,
          };
        }
        const described = this.agentToolCatalog?.describeAction(tool.actionId);
        // Author override → catalog description → the action id as a last-resort non-empty label.
        return {
          name: tool.name,
          description: firstNonEmpty(tool.description, described?.description) ?? tool.actionId,
          parameters: described?.parameters ?? OPEN_TOOL_SCHEMA,
        };
      }),
    );
  }

  /**
   * Run `attempt` under the retry policy: up to `maxAttempts` tries with in-process
   * back-off. A crash re-runs the whole step body from attempt 1 (back-off is not crash-durable).
   */
  private async runWithRetry<T>(
    retry: { maxAttempts: number; backoffMs: number } | undefined,
    stepKey: string,
    ctx: RunContext,
    attempt: () => Promise<T>,
  ): Promise<T> {
    const maxAttempts = retry?.maxAttempts ?? 1;
    const backoffMs = retry?.backoffMs ?? 0;
    let tries = 0;
    for (;;) {
      tries += 1;
      try {
        const result = await attempt();
        if (tries > 1) await this.recordAttempts(ctx, stepKey, tries);
        return result;
      } catch (err) {
        if (tries >= maxAttempts) {
          if (maxAttempts > 1) await this.recordAttempts(ctx, stepKey, tries);
          throw err;
        }
        if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  private async recordAttempts(ctx: RunContext, stepKey: string, attempts: number): Promise<void> {
    if (ctx.record) await ctx.record.recorder.stepAttempts(ctx.record.runId, stepKey, attempts);
  }

  /**
   * Record a routing decision that could NOT fully resolve its condition. `if`/`switch` are pure and
   * settle without a step row, so an unresolvable operand had nowhere to be reported and silently
   * chose a branch. Only the unresolved case is recorded — a healthy branch is not worth a row per
   * loop iteration.
   */
  protected async recordUndecidableRouting(
    ctx: RunContext,
    stepKey: string,
    nodeId: string,
    kind: 'if' | 'switch',
    selectedPort: number,
    refs: ReadonlySet<string>,
  ): Promise<void> {
    if (refs.size === 0) return;
    const output = { selected_port: selectedPort };
    if (ctx.record) {
      const { runId, recorder } = ctx.record;
      await recorder.stepStarted(runId, stepKey, nodeId, kind, false);
      await recorder.stepFinished(runId, stepKey, output, null);
    }
    await this.warn(ctx, stepKey, [...refs].map(unresolvedNote));
    ctx.trace.push({ nodeId: stepKey, output, warnings: ctx.stepWarnings.get(stepKey) ?? [] });
  }

  /**
   * Add non-fatal honesty warnings to a step. The recorder UPSERTs the whole array per step, so a
   * second write must carry the first's — every site funnels through here for that reason.
   */
  private async warn(ctx: RunContext, stepKey: string, notes: string[]): Promise<void> {
    if (notes.length === 0) return;
    const merged = [...(ctx.stepWarnings.get(stepKey) ?? []), ...notes];
    ctx.stepWarnings.set(stepKey, merged);
    if (ctx.record) await ctx.record.recorder.stepWarnings(ctx.record.runId, stepKey, merged);
  }
}

/** The one phrasing for a full-string `{{ref}}` that resolved to nothing. */
const unresolvedNote = (ref: string): string => `Reference {{${ref}}} resolved to nothing.`;

/** Render an agent message's content as text for the model (a string stays verbatim; else JSON). */
function renderAgentContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // Never crash the loop over rendering a circular/BigInt tool result.
    return '[unserializable tool result]';
  }
}

/** Accumulate one model turn's token usage into the run's aggregate (fields are additive, absent = 0). */
function addUsage(total: Usage, turn: Usage | undefined): void {
  if (!turn) return;
  if (turn.inputTokens !== undefined) total.inputTokens = (total.inputTokens ?? 0) + turn.inputTokens;
  if (turn.outputTokens !== undefined) total.outputTokens = (total.outputTokens ?? 0) + turn.outputTokens;
  if (turn.totalTokens !== undefined) total.totalTokens = (total.totalTokens ?? 0) + turn.totalTokens;
}
