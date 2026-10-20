import { isDeepStrictEqual } from 'node:util';

import { Error as DbosErrors } from '@dbos-inc/dbos-sdk';

import type { RuntimeRunStatus, RuntimeStepKind } from '../database/entities/runtime-run.entity';
import { DeterminismError } from '../providers/durable-step';
import type {
  ManagedIntegrationProvider,
  RunActionInput,
  RunActionResult,
} from '../providers/managed-integration-provider';
import type { AgentModelPort, ModelCallRequest, ModelTurn } from '../runtime/agent';
import { DagInterpreter } from '../runtime/dag-interpreter';
import type { DagNode, DagPlan } from '../runtime/dag-plan';
import { fuzzValue, seeded, type FuzzActionProps, type FuzzPlan } from '../runtime/random-dag-plan.testkit';
import { MODEL_TURN, type RecordedOp, type RecordedStep } from '../runtime/recovery-exposure';
import type { RunRecorder } from '../runtime/run-recorder.service';
import type { SubWorkflowContext, SubWorkflowRunner } from '../runtime/sub-workflow-runner';
import { isTimerWait } from '../runtime/timer-wait';
import { RowGatedDurableStep } from './dbos-durable-step';
import type { SequencedOps } from './run-sequencer';
import { SequencedDurableStep } from './sequenced-durable-step';
import {
  RECV,
  SLEEP,
  SimDbFault,
  SimDbosDurableStep,
  SimExecution,
  SimWorkflow,
  VirtualClock,
  simOps,
  type FaultSlot,
  type OpRow,
  type RowlessSlot,
} from './sim-dbos.testkit';

/**
 * What runs the plan: the interpreter as `orchestr.runPlan` runs it; as `orchestr.runPlan.v2` runs it, over the
 * sequencer; the same over today's shared sub-workflow budget, which shows what the recorded budget adds; or the v2
 * options over plain lanes with no turn, which shows what the sequencer adds.
 */
export type Engine = 'legacy' | 'sequenced' | 'sequenced-shared' | 'unsequenced';

/** The errors a lane engine treats as fatal: raised outside step bodies, tested on the live throw. */
export function isFuzzFatal(error: unknown): boolean {
  return (
    error instanceof DeterminismError ||
    error instanceof DbosErrors.DBOSWorkflowCancelledError ||
    error instanceof DbosErrors.DBOSUnexpectedStepError
  );
}

/**
 * Test support, not in the production bundle: runs a fuzz plan durably over SimDBOS, kills it part-way, replays it on
 * different latencies, and reports every way the replay went wrong — the ones DBOS raises and the ones it lets through.
 */

/** Everything one crash-and-replay of a plan got wrong, by kind. */
export interface ReplayVerdict {
  /** The uninterrupted run reached its end, completed or failed; one left hanging is a harness fault. */
  firstSettled: boolean;
  /** Op-log audit violations of the uninterrupted run. */
  firstAudit: string[];
  /** Op-log audit violations of the replay, when it reached its end. */
  replayAudit: string[];
  /** `DBOSUnexpectedStepError`s raised during the replay. */
  loud: number;
  /** Replayed sleep and recv slots handed to a caller that did not record them. */
  silent: number;
  /** Steps recorded once and then executed again. */
  reruns: number;
  /** Waits whose payload was meant for another wait. */
  misdelivered: number;
  /** A run that ended successfully although a step threw a fatal failure in it — in the first run or the replay. */
  fatalLost: boolean;
  /** The replay stopped making progress with nothing left to wake it. */
  stuck: boolean;
  /** Sub-workflow calls an agent was refused because the run's budget ran out. */
  budgetRefusals: number;
  /** Ops still in flight when a run ended, across the uninterrupted run and the replay; audited once they land. */
  inFlightAtEnd: number;
  /** The same, counting only runs that did not end on a fatal error, which ends a run without waiting for its ops. */
  inFlightAtHealthyEnd: number;
  /** Runs, of the uninterrupted one and the replay, that ended on a {@link DeterminismError}. */
  diverged: number;
  /** Steps whose recorded output names another step: a result handed to the wrong lane. */
  wrongLane: number;
  /** Steps the killed execution finished with an output that its replay finished with another. */
  drifted: number;
  /** Waits answered in time that finished as if nobody had answered. */
  answeredNull: number;
  /** What the killed execution had committed when it died: its op rows, and the step rows as their writes had left them. */
  atCrash: { ops: RecordedOp[]; steps: RecordedStep[] };
  /** Step ops still in flight when a run ended: a body running, its row still to be written. */
  stepsInFlightAtEnd: number;
  /** Step writes to the run's history issued after its terminal write. */
  writesAfterEnd: number;
}

const RESTART_AFTER_MS = 500;

/** The scope every fuzz run starts from, as its workflow checkpoints it. */
export const FUZZ_SCOPE: Readonly<Record<string, unknown>> = { trigger: { items: [1, 2] } };

/** Marks each execution's scope with which it is, `first`, `crashed` or `replay`; no reference can read it. */
export const EXECUTION = Symbol('fuzz execution');

/**
 * Runs `fuzz` once to its end on `engine`, then again killed at a seeded moment, or at `crashAt` (a share of the first
 * run's length), and replayed, and judges the replay.
 */
export async function crashAndReplay(
  fuzz: FuzzPlan,
  seed: number,
  engine: Engine = 'legacy',
  crashAt?: number,
): Promise<ReplayVerdict> {
  const probe = new World(fuzz, seed, engine);
  const first = probe.start(seeded(seed * 7 + 1), 'first');
  await probe.clock.drive(() => first.settled);
  const firstEnd = probe.clock.now();
  const firstInFlight = first.execution.inFlight;
  const firstSteps = first.execution.stepsInFlight;
  const firstHealthy = !isFuzzFatal(first.error);
  await probe.clock.drive();
  const firstAudit = first.settled ? audit(fuzz.plan, probe.wf.rows, first.execution, engine) : [];

  const world = new World(fuzz, seed, engine);
  const killAt = Math.floor((crashAt ?? seeded(seed * 7 + 3)()) * Math.max(1, firstEnd));
  const crashed = world.start(seeded(seed * 7 + 1), 'crashed');
  let replay: Execution | undefined;
  let atCrash: ReplayVerdict['atCrash'] = { steps: [], ops: [] };
  world.clock.at(killAt, () => {
    atCrash = {
      steps: [...world.recorder.rows.values()],
      ops: [...world.wf.rows.values()].sort((a, b) => a.id - b.id).map(recordedOp),
    };
    crashed.execution.crash();
    world.clock.at(world.clock.now() + RESTART_AFTER_MS, () => {
      replay = world.start(seeded(seed * 7 + 4), 'replay');
    });
  });
  await world.clock.drive(() => replay?.settled === true);
  const replayInFlight = replay?.settled ? replay.execution.inFlight : 0;
  const replaySteps = replay?.settled ? replay.execution.stepsInFlight : 0;
  const replayHealthy = !isFuzzFatal(replay?.error);
  await world.clock.drive();
  const replayAudit = replay?.settled ? audit(fuzz.plan, world.wf.rows, replay.execution, engine) : [];
  return {
    firstSettled: first.settled,
    firstAudit,
    replayAudit,
    loud: world.wf.stats.loud,
    silent: world.wf.stats.silent.length,
    reruns: world.wf.stats.reruns.length,
    misdelivered: world.recorder.misdelivered.size,
    fatalLost:
      (first.completed && probe.fatalRaised > 0) ||
      (replay?.completed === true && (world.fatalRaised > 0 || world.wf.stats.loud > 0)),
    stuck: replay?.settled !== true,
    budgetRefusals: world.recorder.budgetRefusals,
    inFlightAtEnd: firstInFlight + replayInFlight,
    inFlightAtHealthyEnd: (firstHealthy ? firstInFlight : 0) + (replayHealthy ? replayInFlight : 0),
    diverged: [first.error, replay?.error].filter((error) => error instanceof DeterminismError).length,
    wrongLane: probe.recorder.wrongLane.size + world.recorder.wrongLane.size,
    drifted: drifted(world.recorder.finished),
    answeredNull: probe.recorder.answeredNull.size + world.recorder.answeredNull.size,
    atCrash,
    stepsInFlightAtEnd: firstSteps + replaySteps,
    writesAfterEnd: probe.recorder.writesAfterEnd + world.recorder.writesAfterEnd,
  };
}

function recordedOp(row: OpRow): RecordedOp {
  const op: RecordedOp = { name: row.name, output: row.output, failed: row.error !== undefined };
  if (!MODEL_TURN.test(row.name)) return op;
  const turn = row.error ? { toolCalls: [] } : (row.output as ModelTurn);
  return { ...op, toolCalls: turn.toolCalls.map(({ id, name }) => ({ id, name })) };
}

function drifted([killed, replay]: Array<Map<string, unknown>>): number {
  if (!killed || !replay) return 0;
  return [...killed].filter(([key, output]) => replay.has(key) && !isDeepStrictEqual(replay.get(key), output))
    .length;
}

interface Execution {
  execution: SimExecution;
  settled: boolean;
  completed: boolean;
  error?: unknown;
}

/** Cancels a sequenced run at a seeded moment and says how long it took to end, and how. */
export async function cancelDuring(
  fuzz: FuzzPlan,
  seed: number,
): Promise<{ latencyMs: number; cancelled: boolean; how: string } | null> {
  const probe = new World(fuzz, seed, 'sequenced');
  const first = probe.start(seeded(seed * 7 + 1), 'first');
  await probe.clock.drive(() => first.settled);
  const end = probe.clock.now();
  if (end === 0) return null;
  const world = new World(fuzz, seed, 'sequenced');
  const cancelAt = Math.floor(seeded(seed * 7 + 6)() * end);
  const run = world.start(seeded(seed * 7 + 1), 'first');
  world.clock.at(cancelAt, () => {
    world.wf.cancelled = true;
  });
  await world.clock.drive(() => run.settled);
  if (!run.settled) return { latencyMs: Infinity, cancelled: false, how: 'hanging' };
  const cancelled = run.error instanceof DbosErrors.DBOSWorkflowCancelledError;
  const how = run.completed ? 'completed' : run.error instanceof Error ? run.error.name : String(run.error);
  return { latencyMs: world.clock.now() - cancelAt, cancelled, how };
}

/** Runs `fuzz` with one database write refused at a seeded point; `absorbed` when that refusal did not end the run. */
export async function faultDuring(
  fuzz: FuzzPlan,
  seed: number,
  engine: Engine,
): Promise<{ injected: boolean; absorbed: boolean }> {
  let writes = 0;
  const probe = new World(fuzz, seed, engine);
  const first = probe.start(seeded(seed * 7 + 1), 'first', () => {
    writes += 1;
    return false;
  });
  await probe.clock.drive(() => first.settled);
  const at = 1 + Math.floor(seeded(seed * 7 + 8)() * writes);
  let seen = 0;
  let fatalBefore = 0;
  const world = new World(fuzz, seed, engine);
  const run = world.start(seeded(seed * 7 + 1), 'first', () => {
    if (++seen !== at) return false;
    fatalBefore = world.fatalRaised;
    return true;
  });
  await world.clock.drive(() => run.settled);
  const injected = writes > 0 && seen >= at;
  // A run already unwinding on a fatal error ends on that, as every fatal error wins: it never went past the fault.
  const unwinding = fatalBefore > 0 && world.fatalRaised === fatalBefore && run.error !== undefined;
  return { injected, absorbed: injected && !(run.error instanceof SimDbFault) && !unwinding };
}

/** One durable workflow and the outside world its plan talks to, on one virtual clock. */
class World {
  readonly clock = new VirtualClock();
  readonly wf: SimWorkflow;
  readonly provider: FuzzProvider;
  readonly recorder: FuzzRecorder;
  fatalRaised = 0;
  private readonly model: FuzzModel;
  private readonly runner: FuzzRunner;

  constructor(
    private readonly fuzz: FuzzPlan,
    seed: number,
    private readonly engine: Engine,
  ) {
    this.wf = new SimWorkflow(`fuzz-${seed}`, this.clock);
    const latency = seeded(seed * 7 + 2);
    this.provider = new FuzzProvider(this.clock);
    this.model = new FuzzModel(this.clock, latency);
    this.recorder = new FuzzRecorder(
      this.clock,
      latency,
      seeded(seed * 7 + 5),
      (topic, payload, key) => this.wf.send(payload, topic, key),
      fuzz.budget,
    );
    this.runner = new FuzzRunner(this.clock, latency, (root, key) =>
      this.recorder.chargeSubWorkflowCall(root, key, fuzz.budget),
    );
  }

  start(
    dbLatency: () => number,
    label: 'first' | 'crashed' | 'replay',
    refuses?: (slot: FaultSlot) => boolean,
  ): Execution {
    this.recorder.nextExecution();
    const execution = new SimExecution(this.wf, () => 1 + Math.floor(dbLatency() * 30), refuses);
    const run: Execution = { execution, settled: false, completed: false };
    this.execute(execution, label).then(
      () => {
        run.completed = true;
        run.settled = true;
      },
      (error: unknown) => {
        run.error = error;
        run.settled = true;
      },
    );
    return run;
  }

  private execute(execution: SimExecution, label: string): Promise<unknown> {
    const raised = (): void => {
      this.fatalRaised += 1;
    };
    const plain = this.engine === 'legacy' || this.engine === 'unsequenced';
    const substrate = plain
      ? new FatalAtLookup(execution, this.clock, this.fuzz.fatal, raised)
      : new SimSequencedStep(fatalAtLookupOps(execution, this.clock, this.fuzz.fatal, raised), this.clock);
    const interpreter = new DagInterpreter(this.provider, undefined, undefined, undefined, this.model);
    interpreter.setSubWorkflowRunner(this.runner);
    return interpreter.run(this.fuzz.plan, {
      externalUserId: 'fuzz',
      durable: new RowGatedDurableStep(substrate, () => this.recorder.runStatus()),
      runId: this.wf.id,
      recorder: this.recorder,
      pins: this.fuzz.pins,
      initialScope: { ...FUZZ_SCOPE, [EXECUTION]: label },
      subWorkflowBudget: { remaining: this.fuzz.budget },
      everyWaitByStep: this.engine !== 'legacy',
      budgetCharged: this.engine === 'sequenced' || this.engine === 'unsequenced',
      ownErrorLanePaths: this.engine !== 'legacy',
    });
  }
}

const isFatalStep = (fatal: ReadonlySet<string>, name: string): boolean =>
  fatal.has(/[:/]([^:/]+)$/.exec(name)?.[1] ?? '');

const fatalAtLookup = (name: string): Error =>
  new DbosErrors.DBOSUnexpectedStepError(name, -1, name, 'a fatal fuzz step');

/** Today's substrate, raising a fatal error at a `fatal` action's step lookup, before the body, as DBOS raises them. */
class FatalAtLookup extends SimDbosDurableStep {
  constructor(
    execution: SimExecution,
    clock: VirtualClock,
    private readonly fatal: ReadonlySet<string>,
    private readonly raised: () => void,
  ) {
    super(execution, clock);
  }

  override run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (!isFatalStep(this.fatal, name)) return super.run(name, fn);
    this.raised();
    return this.execution.failStepAtLookup(name, fatalAtLookup(name));
  }
}

// The model's ops for the sequenced engine, a `fatal` action's step failing at its lookup as DBOS fails it.
function fatalAtLookupOps(
  execution: SimExecution,
  clock: VirtualClock,
  fatal: ReadonlySet<string>,
  raised: () => void,
): SequencedOps {
  const ops = simOps(execution, clock);
  return {
    ...ops,
    runStep: (fn, name) => {
      if (!isFatalStep(fatal, name)) return ops.runStep(fn, name);
      raised();
      return execution.failStepAtLookup(name, fatalAtLookup(name));
    },
  };
}

/** The sequenced engine's substrate over the model, waiting inside a step on the model's clock. */
class SimSequencedStep extends SequencedDurableStep {
  constructor(
    ops: SequencedOps,
    private readonly clock: VirtualClock,
  ) {
    super(ops);
  }

  override waitInStep(ms: number): Promise<void> {
    return this.clock.sleep(ms);
  }
}

/** Actions answer after their own latency, carrying the step that asked; failures follow their props. */
class FuzzProvider implements ManagedIntegrationProvider {
  readonly key = 'fuzz';
  private readonly attempts = new Map<string, number>();

  constructor(private readonly clock: VirtualClock) {}

  async runAction(input: RunActionInput): Promise<RunActionResult> {
    const props = input.props as unknown as FuzzActionProps;
    const key = input.idempotencyKey ?? '';
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    await this.clock.sleep(props.latencyMs);
    if (props.behaviour === 'fails' || (props.behaviour === 'fails-once' && attempt === 1)) {
      throw new Error(`failure in ${key}`);
    }
    return { output: { from: key, ...(props.yields ? { v: fuzzValue(props.yields) } : {}) } };
  }

  enableTrigger(): Promise<void> {
    return Promise.resolve();
  }

  pollTrigger(): Promise<never[]> {
    return Promise.resolve([]);
  }

  disableTrigger(): Promise<void> {
    return Promise.resolve();
  }
}

/** Plays the script in the agent's system prompt: `rounds` rounds of `calls` tool calls, then a final answer. */
class FuzzModel implements AgentModelPort {
  constructor(
    private readonly clock: VirtualClock,
    private readonly latency: () => number,
  ) {}

  async call(req: ModelCallRequest): Promise<ModelTurn> {
    await this.clock.sleep(1 + Math.floor(this.latency() * 200));
    const node = /node=(\S+)/.exec(req.system)?.[1] ?? '';
    const [, rounds = 0, calls = 0] = /rounds=(\d+) calls=(\d+)/.exec(req.system)?.map(Number) ?? [];
    const round = req.messages.filter((m) => m.role === 'assistant').length;
    const text = `${node}#${round}`;
    if (round >= rounds || req.tools.length === 0) return { text, toolCalls: [] };
    return {
      text,
      toolCalls: Array.from({ length: calls }, (_, k) => ({
        id: `r${round}c${k}`,
        name: req.tools[(round + k) % req.tools.length]!.name,
        input: {},
      })),
    };
  }
}

class FuzzRunner implements SubWorkflowRunner {
  constructor(
    private readonly clock: VirtualClock,
    private readonly latency: () => number,
    private readonly charge: (root: string, callKey: string) => Promise<boolean>,
  ) {}

  async run(_call: unknown, ctx: SubWorkflowContext): Promise<unknown> {
    await this.clock.sleep(1 + Math.floor(this.latency() * 300));
    // The child's own sub-workflow calls, as a real child run makes them: charged to its tree, or spent from the counter.
    const calls = [...ctx.callKey].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 3;
    for (let k = 0; k < calls; k++) {
      if (ctx.budgetCharged) await this.charge(ctx.rootRunId, `${ctx.callKey}/${k}`);
      else if (ctx.budget.remaining > 0) ctx.budget.remaining -= 1;
    }
    return { child: ctx.callKey };
  }
}

/** Run history with write latency, answering most waits it sees park with a payload naming that wait. */
class FuzzRecorder implements RunRecorder {
  readonly misdelivered = new Set<string>();
  readonly wrongLane = new Set<string>();
  readonly answeredNull = new Set<string>();
  readonly finished: Array<Map<string, unknown>> = [];
  /** The step rows written so far, by step key. */
  readonly rows = new Map<string, RecordedStep>();
  private readonly startedAt = new Map<string, number>();
  budgetRefusals = 0;
  /** Step writes issued once the run's terminal write was. */
  writesAfterEnd = 0;
  private ended = false;
  private readonly kinds = new Map<string, RuntimeStepKind>();
  private readonly answered = new Set<string>();
  private readonly decidedInTime = new Set<string>();

  /** Each sub-workflow call charged to the run tree, and whether it was allowed: the charges table, which a crash keeps. */
  private readonly charges = new Map<string, boolean>();

  constructor(
    private readonly clock: VirtualClock,
    private readonly latency: () => number,
    private readonly decide: () => number,
    private readonly send: (topic: string, payload: unknown, key: string) => void,
    private readonly cap: number,
  ) {}

  // A fuzz child's calls are keyed by its call, so a child that runs again repeats them: there is nothing to forget.
  forgetSubWorkflowCharges(): Promise<void> {
    return Promise.resolve();
  }

  // The fuzz caps a tree at its plan's own small budget, so that calls are refused often.
  async chargeSubWorkflowCall(_root: string, callKey: string, max: number): Promise<boolean> {
    await this.write();
    if (!this.charges.has(callKey)) {
      const allowed = [...this.charges.values()].filter(Boolean).length;
      this.charges.set(callKey, allowed < Math.min(max, this.cap));
    }
    return this.charges.get(callKey)!;
  }

  private write(): Promise<void> {
    return this.clock.sleep(1 + Math.floor(this.latency() * 40));
  }

  private stepWrite(): Promise<void> {
    if (this.ended) this.writesAfterEnd += 1;
    return this.write();
  }

  private endWrite(): Promise<void> {
    this.ended = true;
    return this.write();
  }

  runStarted(): Promise<void> {
    return this.write();
  }

  async stepStarted(
    _runId: string,
    stepKey: string,
    _nodeId: string,
    kind: RuntimeStepKind,
    pinned = false,
  ): Promise<void> {
    this.kinds.set(stepKey, kind);
    await this.stepWrite();
    this.rows.set(stepKey, { stepKey, kind, pinned });
    if (!this.startedAt.has(stepKey)) this.startedAt.set(stepKey, this.clock.now());
  }

  /** Starts a new execution's record of what each step finished with. */
  nextExecution(): void {
    this.finished.push(new Map());
    this.ended = false;
  }

  async stepFinished(runId: string, stepKey: string, output: unknown, error: string | null): Promise<void> {
    await this.stepWrite();
    // A step a failed run aborted was never recorded, so its replay is free to finish it otherwise.
    if (error === null) this.finished.at(-1)?.set(stepKey, structuredClone(output));
    const kind = this.kinds.get(stepKey);
    if (kind === 'waitForEvent' && output !== null && (output as { for?: string }).for !== stepKey) {
      this.misdelivered.add(stepKey);
    }
    if (kind === 'waitForEvent' && output === null && error === null && this.decidedInTime.has(stepKey)) {
      this.answeredNull.add(stepKey);
    }
    if (namesAnotherStep(output, stepKey, runId)) this.wrongLane.add(stepKey);
    if (kind === 'agent') this.budgetRefusals += refusals(output);
  }

  async stepWaiting(
    _runId: string,
    stepKey: string,
    topic: string,
    durationMs: number,
    deliveryTopic?: string | null,
  ): Promise<Date> {
    await this.stepWrite();
    if (!isTimerWait(topic) && !this.answered.has(stepKey)) {
      this.answered.add(stepKey);
      if (this.decide() < 0.75) {
        const at = this.clock.now() + 10 + Math.floor(this.decide() * 3_000);
        this.clock.at(at, () => this.send(deliveryTopic ?? topic, { for: stepKey }, stepKey));
        // The receive began a few writes before this park was written, so its deadline is a little earlier.
        if (at < this.clock.now() + durationMs - 500) this.decidedInTime.add(stepKey);
      }
    }
    // Anchored on the step row's first start, which a replay's upsert keeps, as the real recorder answers.
    return new Date((this.startedAt.get(stepKey) ?? this.clock.now()) + durationMs);
  }

  stepResumed(): Promise<void> {
    return this.stepWrite();
  }

  stepContinued(): Promise<void> {
    return this.stepWrite();
  }

  stepAttempts(): Promise<void> {
    return this.stepWrite();
  }

  stepWarnings(): Promise<void> {
    return this.stepWrite();
  }

  runFinished(): Promise<void> {
    return this.endWrite();
  }

  runUnwoundByCancel(): Promise<void> {
    return this.endWrite();
  }

  async isCancelled(): Promise<boolean> {
    return (await this.runStatus()) === 'cancelled';
  }

  async runStatus(): Promise<RuntimeRunStatus> {
    await this.write();
    return 'running';
  }
}

// Each step an output names — an action's `from`, a child run's `child`, a decision's `for`, a model turn's text —
// must be the step itself or one of its own sub-steps.
function namesAnotherStep(output: unknown, stepKey: string, runId: string): boolean {
  const node = stepKey.slice(stepKey.lastIndexOf('/') + 1);
  const own = (key: string): boolean => key === stepKey || key.startsWith(`${stepKey}#`);
  const foreign = (field: string, value: string): boolean => {
    if (field === 'from') return !own(value.replace(`${runId}:`, ''));
    if (field === 'child' || field === 'for') return !own(value);
    return field === 'text' && /^n\d+#\d+$/.test(value) && value.split('#')[0] !== node;
  };
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([field, inner]) =>
      typeof inner === 'string' ? foreign(field, inner) : visit(inner),
    );
  };
  return visit(output);
}

function refusals(agentOutput: unknown): number {
  const steps = (agentOutput as { steps?: Array<{ output?: { error?: { message?: string } } }> } | null)
    ?.steps;
  return (steps ?? []).filter((s) => /invocation budget/.test(s.output?.error?.message ?? '')).length;
}

/**
 * The op log of an execution that ran to its end: every name one the plan can issue, and every id it reserved
 * recorded, bar the slots DBOS leaves without a row; nothing recorded past what it reserved.
 */
export function audit(
  plan: DagPlan,
  rows: ReadonlyMap<number, OpRow>,
  execution: { reserved: number; rowless: readonly RowlessSlot[] },
  engine: Engine = 'legacy',
): string[] {
  const issued = stepNames(plan, engine);
  const rowless = new Set(execution.rowless.map((slot) => slot.id));
  const violations: string[] = [];
  for (const row of rows.values()) {
    if (row.name !== SLEEP && row.name !== RECV && !issued.test(row.name)) {
      violations.push(`op ${row.id} is named "${row.name}", which the plan never issues`);
    }
    if (row.id >= execution.reserved)
      violations.push(`op ${row.id} lies past the ${execution.reserved} ids reserved`);
  }
  for (let id = 0; id < execution.reserved; id++) {
    if (!rows.has(id) && !rowless.has(id)) violations.push(`op ${id} was reserved and never recorded`);
  }
  return violations;
}

function stepNames(plan: DagPlan, engine: Engine): RegExp {
  const ids = [...nodeIds(plan.nodes)].map(escapeRegExp).join('|');
  // Every engine but the legacy one runs an error lane under its source's own path.
  const segment = engine === 'legacy' ? '#\\d+|\\|\\d+' : '#\\d+|\\|\\d+|#error';
  const key = `(?:(?:${ids})(?:${segment})/)*(?:${ids})`;
  const step = `${escapeRegExp(plan.id)}:${key}(?:#\\d+:model|#final:model|#\\d+:tool:r\\d+c\\d+)?`;
  if (engine === 'legacy' || engine === 'unsequenced') return new RegExp(`^${step}$`);
  return new RegExp(`^(?:step\\|${step}|wait\\|${key}|deadline\\|${key}|sched\\|\\d+)$`);
}

function nodeIds(nodes: readonly DagNode[], into = new Set<string>()): Set<string> {
  for (const node of nodes) {
    into.add(node.id);
    if (node.kind === 'forEach' || node.kind === 'while') nodeIds(node.body.nodes, into);
    if (node.kind === 'parallel') node.branches.forEach((branch) => nodeIds(branch.nodes, into));
    if ('onErrorBranch' in node && node.onErrorBranch) nodeIds(node.onErrorBranch.nodes, into);
  }
  return into;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
