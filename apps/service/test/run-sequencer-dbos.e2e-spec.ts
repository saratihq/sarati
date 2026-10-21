import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { DBOS, Error as DbosErrors } from '@dbos-inc/dbos-sdk';
import { Client } from 'pg';

import { runPlanToDag } from '../src/compiler/run-plan-to-dag';
import { DbosDurableStep, RowGatedDurableStep } from '../src/dbos/dbos-durable-step';
import { RECV_DELAY_ABOVE_MS, type SequencedOps } from '../src/dbos/run-sequencer';
import { SequencedDurableStep } from '../src/dbos/sequenced-durable-step';
import type { DurableStep, Lane, Outcome } from '../src/providers/durable-step';
import type {
  ManagedIntegrationProvider,
  RunActionInput,
  RunActionResult,
} from '../src/providers/managed-integration-provider';
import { DagInterpreter } from '../src/runtime/dag-interpreter';
import type { DagPlan } from '../src/runtime/dag-plan';
import { eventTopicFor } from '../src/runtime/event-wait';
import type { RunNode, RunResult } from '../src/runtime/run-plan';
import type { RunRecorder } from '../src/runtime/run-recorder.service';
import { launchThrowawayDbos, type ThrowawayDbos } from './support/dbos-system-db';

type Engine = 'sequenced' | 'unsequenced';

/** One execution of a trial's workflow: the step bodies it ran, the DBOS ops still settling, and how it ended. */
interface Execution {
  ran: string[];
  pending: Set<Promise<unknown>>;
  /** Set at the crash instant: from then on the execution writes nothing, as if its process had died. */
  dead: boolean;
  /** Concurrent branches started, and those that have ended. */
  lanes: number;
  lanesEnded: number;
  kill?: () => void;
  /** Settles once the workflow function has returned to DBOS, crashed or not. */
  returned?: Promise<void>;
  ended?: Promise<Outcome<RunResult>>;
  endedAt?: number;
  /** Branches still running when the run ended. */
  lanesOpenAtEnd?: number;
}

interface Trial {
  engine: Engine;
  plan: DagPlan;
  executions: Execution[];
  /** Kills the first execution as it issues a recv: after a wait's head row, before its timeout row. */
  killOnRecv: boolean;
}

interface Row {
  id: number;
  name: string;
}

// Each execution of a trial times its step bodies by its own profile, so a resumed run settles in another order.
const PROFILES: Array<Record<string, number>> = [
  { start: 5, a1: 80, a2: 10, c1: 40, c2: 30, b2: 5, end: 5 },
  { start: 5, a1: 10, a2: 60, c1: 5, c2: 5, b2: 40, end: 5 },
];

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const act = (id: string, props: Record<string, unknown> = {}): RunNode => ({
  kind: 'action',
  id,
  actionId: 'trial.body',
  props: { from: id, ...props },
});
const wait = (id: string, timeoutMs: number): RunNode => ({
  kind: 'waitForEvent',
  id,
  topic: 'approval',
  timeoutMs,
});
const delay = (id: string, ms: number): RunNode => ({ kind: 'delay', id, ms });
const plan = (...nodes: RunNode[]): DagPlan => runPlanToDag({ id: 'trial', nodes });

/** Nested branches, two waits on one topic, a delay and step chains: every op kind a branch can have in flight. */
const CRASH_PLAN = plan(
  act('start'),
  {
    kind: 'parallel',
    id: 'fork',
    branches: [
      [act('a1'), act('a2')],
      [{ kind: 'parallel', id: 'inner', branches: [[act('c1')], [delay('d', 150), act('c2')]] }],
      [wait('w1', 5_000), act('b2', { got: '{{w1.for}}' })],
      [wait('w2', 5_000)],
    ],
  },
  act('end'),
);
const W1 = eventTopicFor('fork|2/w1');
const W2 = eventTopicFor('fork|3/w2');

const EXPECTED = {
  start: { from: 'start' },
  a1: { from: 'a1' },
  a2: { from: 'a2' },
  c1: { from: 'c1' },
  c2: { from: 'c2' },
  w1: { for: 'w1' },
  b2: { from: 'b2', got: 'w1' },
  w2: { for: 'w2' },
  end: { from: 'end' },
};

// A step's op names the step it ran: `step|trial:<key>` sequenced, `trial:<key>` unsequenced.
const stepOf = (name: string): string | undefined => /^(?:step\|)?trial:(?:.*\/)?([^/]+)$/.exec(name)?.[1];

const trials = new Map<string, Trial>();

/** Counts each op an execution issues until it settles; once the execution is dead, a body that ends never returns. */
class Tracker {
  constructor(private readonly execution: Execution) {}

  track<T>(op: Promise<T>): Promise<T> {
    this.execution.pending.add(op);
    const settled = (): void => void this.execution.pending.delete(op);
    op.then(settled, settled);
    return op;
  }

  step<T>(fn: () => Promise<T>, issue: (body: () => Promise<T>) => Promise<T>): Promise<T> {
    const op = this.track(
      issue(async () => {
        const value = await fn();
        if (!this.execution.dead) return value;
        // A body finishing after the crash never returns, so DBOS never records it.
        this.execution.pending.delete(op);
        return new Promise<never>(() => undefined);
      }),
    );
    return op;
  }

  recv<T>(killOnRecv: boolean, issue: () => Promise<T>): Promise<T> {
    if (!killOnRecv) return this.track(issue());
    this.execution.kill!();
    return new Promise<never>(() => undefined);
  }

  lane(fn: () => Promise<unknown>): () => Promise<unknown> {
    this.execution.lanes += 1;
    return () =>
      fn().finally(() => {
        this.execution.lanesEnded += 1;
      });
  }
}

/** `orchestr.runPlan.v2`'s substrate over DBOS calls the tracker sees. */
class TrackedSequencedStep extends SequencedDurableStep {
  constructor(
    private readonly tracker: Tracker,
    killOnRecv: boolean,
  ) {
    super({
      runStep: (fn, name) => tracker.step(fn, (body) => DBOS.runStep(body, { name })),
      sleepms: (ms) => tracker.track(DBOS.sleepms(ms)),
      recv: (topic, options) => tracker.recv(killOnRecv, () => DBOS.recv(topic, options)),
      now: () => Date.now(),
    } satisfies SequencedOps);
  }

  override spawn(fn: () => Promise<unknown>): Lane {
    return super.spawn(this.tracker.lane(fn));
  }
}

/** Today's plain-promise branches over the same tracked calls: what the sequencer adds is the difference. */
class TrackedUnsequencedStep extends DbosDurableStep {
  constructor(
    private readonly tracker: Tracker,
    private readonly killOnRecv: boolean,
  ) {
    super();
  }

  override run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.tracker.step(fn, (body) => DBOS.runStep(body, { name }));
  }

  override sleep(_name: string, ms: number): Promise<void> {
    return this.tracker.track(DBOS.sleepms(ms));
  }

  override receive<T = unknown>(_name: string, topic: string, timeoutMs: number): Promise<T | null> {
    return this.tracker.recv(this.killOnRecv, () => DBOS.recv<T>(topic, timeoutMs / 1000));
  }

  override spawn(fn: () => Promise<unknown>): Lane {
    return super.spawn(this.tracker.lane(fn));
  }
}

/** Each step answers with its props after the time its execution's profile gives it. */
class TrialBodies implements ManagedIntegrationProvider {
  readonly key = 'trial';

  constructor(
    private readonly execution: Execution,
    private readonly profile: Record<string, number>,
  ) {}

  async runAction(input: RunActionInput): Promise<RunActionResult> {
    const from = String(input.props.from);
    this.execution.ran.push(from);
    await pause(this.profile[from] ?? 0);
    return { output: input.props };
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

/** A run history that keeps nothing, so the run routes each wait by its step and gates each op on its row. */
const NO_HISTORY: RunRecorder = {
  runStarted: () => Promise.resolve(),
  stepStarted: () => Promise.resolve(),
  stepFinished: () => Promise.resolve(),
  stepContinued: () => Promise.resolve(),
  stepAttempts: () => Promise.resolve(),
  stepWarnings: () => Promise.resolve(),
  stepWaiting: () => Promise.resolve(null),
  stepResumed: () => Promise.resolve(),
  runFinished: () => Promise.resolve(),
  runUnwoundByCancel: () => Promise.resolve(),
  isCancelled: () => Promise.resolve(false),
  runStatus: () => Promise.resolve('running'),
  chargeSubWorkflowCall: () => Promise.resolve(true),
  forgetSubWorkflowCharges: () => Promise.resolve(),
};

function execute(trial: Trial, execution: Execution, n: number, id: string): Promise<RunResult> {
  const tracker = new Tracker(execution);
  const killOnRecv = trial.killOnRecv && n === 0;
  const substrate: DurableStep =
    trial.engine === 'sequenced'
      ? new TrackedSequencedStep(tracker, killOnRecv)
      : new TrackedUnsequencedStep(tracker, killOnRecv);
  const interpreter = new DagInterpreter(new TrialBodies(execution, PROFILES[n % PROFILES.length]!));
  return interpreter.run(trial.plan, {
    externalUserId: 'trial',
    durable: new RowGatedDurableStep(substrate, () => NO_HISTORY.runStatus(id)),
    runId: id,
    recorder: NO_HISTORY,
    everyWaitByStep: true,
  });
}

const trialWorkflow = DBOS.registerWorkflow(
  async (): Promise<RunResult> => {
    const id = DBOS.workflowID ?? '';
    const trial = trials.get(id)!;
    const execution: Execution = { ran: [], pending: new Set(), dead: false, lanes: 0, lanesEnded: 0 };
    const n = trial.executions.push(execution) - 1;
    const killed = new Promise<never>((_, reject) => {
      execution.kill = () => {
        execution.dead = true;
        reject(new DbosErrors.DBOSWorkflowCancelledError(id));
      };
    });
    const running = execute(trial, execution, n, id);
    const end = (outcome: Outcome<RunResult>): Outcome<RunResult> => {
      execution.endedAt = Date.now();
      execution.lanesOpenAtEnd = execution.lanes - execution.lanesEnded;
      return outcome;
    };
    execution.ended = running.then(
      (value) => end({ ok: true, value }),
      (error: unknown) => end({ ok: false, error }),
    );
    const returned = Promise.race([running, killed]);
    execution.returned = returned.then(
      () => undefined,
      () => undefined,
    );
    return returned;
  },
  { name: 'sequencer.trial' },
);

// Until its function has returned and every op it issued has settled, an execution can still write a row.
async function drained(execution: Execution): Promise<void> {
  await execution.returned;
  // Polled, since a frozen op leaves the set without ever settling; ops are only issued as another settles.
  while (execution.pending.size > 0) await pause(10);
}

describe('the interpreter on the sequenced substrate, DBOS 4.23.6 (e2e, real DBOS, throwaway system DB)', () => {
  let dbos: ThrowawayDbos;
  let db: Client;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  const rows = async (id: string): Promise<Row[]> =>
    (
      await db.query<{ function_id: number; function_name: string }>(
        `SELECT function_id, function_name FROM dbos.operation_outputs WHERE workflow_uuid = $1 ORDER BY function_id`,
        [id],
      )
    ).rows.map((r) => ({ id: r.function_id, name: r.function_name }));

  // DBOS stores outputs as superjson, `{ __dbos_serializer: 'superjson', json }`.
  const recordedDeadline = async (id: string, name: string): Promise<number> => {
    const { rows: found } = await db.query<{ output: string }>(
      `SELECT output FROM dbos.operation_outputs WHERE workflow_uuid = $1 AND function_name = $2`,
      [id, name],
    );
    return (JSON.parse(found[0]!.output) as { json: { deadline: number } }).json.deadline;
  };

  // Resolves once DBOS holds the workflow, so a send to it is never refused as to a workflow that does not exist.
  const start = async (
    engine: Engine,
    trialPlan: DagPlan,
    killOnRecv = false,
  ): Promise<{ id: string; trial: Trial }> => {
    const id = `seq-${engine}-${randomBytes(4).toString('hex')}`;
    const trial: Trial = { engine, plan: trialPlan, executions: [], killOnRecv };
    trials.set(id, trial);
    await DBOS.startWorkflow(trialWorkflow, { workflowID: id })();
    return { id, trial };
  };

  /** Runs the crash plan, kills it `at` ms in, resumes it from the rows it left, and reports what the replay did. */
  async function crashAt(engine: Engine, at: number) {
    const { id, trial } = await start(engine, CRASH_PLAN);
    const sends = [
      pause(60).then(() => DBOS.send(id, { for: 'w2' }, W2)),
      pause(120).then(() => DBOS.send(id, { for: 'w1' }, W1)),
    ];
    await pause(at);
    while (!trial.executions[0]) await pause(1);
    trial.executions[0].kill!();
    await DBOS.cancelWorkflow(id);
    await Promise.all(sends);
    await drained(trial.executions[0]);
    const atCrash = await rows(id);
    await DBOS.resumeWorkflow(id);
    await DBOS.retrieveWorkflow(id)
      .getResult()
      .catch(() => undefined);
    const last = trial.executions.at(-1)!;
    await drained(last);
    const outcome = (await last.ended)!;
    const replayed = trial.executions.length > 1 ? trial.executions[1]! : undefined;
    const recordedSteps = new Set(atCrash.map((r) => stepOf(r.name)).filter(Boolean));
    const crashIds = new Set(atCrash.map((r) => r.id));
    const highest = Math.max(-1, ...crashIds);
    return {
      at,
      resumed: replayed !== undefined,
      // A step recorded only after a later op was: the crash window a fork cannot reproduce.
      gapped: (await rows(id)).some((r) => stepOf(r.name) && !crashIds.has(r.id) && r.id < highest),
      schedReplayed: atCrash.some((r) => r.name.startsWith('sched|')),
      loud: outcome.ok ? undefined : String(outcome.error),
      silent: outcome.ok && !isDeepStrictEqual(outcome.value.outputs, EXPECTED),
      reruns: (replayed?.ran ?? []).filter((key) => recordedSteps.has(key)),
    };
  }

  beforeAll(async () => {
    dbos = await launchThrowawayDbos('sequencer');
    db = new Client({ connectionString: dbos.url });
    await db.connect();
  }, 60_000);

  afterAll(async () => {
    await db.end();
    await dbos.shutdown();
  }, 60_000);

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('checkpoints every op it issues, its sched steps included, under the names it gives them', async () => {
    const { id, trial } = await start('sequenced', CRASH_PLAN);
    await pause(60).then(() => DBOS.send(id, { for: 'w2' }, W2));
    await pause(60).then(() => DBOS.send(id, { for: 'w1' }, W1));
    await DBOS.retrieveWorkflow(id).getResult();
    expect(await trial.executions[0]!.ended).toMatchObject({ ok: true, value: { outputs: EXPECTED } });
    const names = (await rows(id)).map((r) => r.name);
    expect(
      names.filter(
        (name) =>
          !/^(step\|trial:[\w|/]+|wait\|fork\|[23]\/w[12]|deadline\|fork\|1\/inner\|1\/d|sched\|\d+|DBOS\.(sleep|recv))$/.test(
            name,
          ),
      ),
    ).toEqual([]);
    expect(names.filter((name) => name.startsWith('sched|')).length).toBeGreaterThan(0);
  }, 30_000);

  it('replays a run killed anywhere and resumed under other timings with no mis-pair, where the same branches without it mis-pair', async () => {
    const points = Array.from({ length: 31 }, (_, k) => k * 10);
    const verdicts: Record<Engine, Array<Awaited<ReturnType<typeof crashAt>>>> = {
      sequenced: [],
      unsequenced: [],
    };
    for (let k = 0; k < points.length; k += 8) {
      const batch = points.slice(k, k + 8);
      const settled = await Promise.all(
        batch.flatMap((at) => [crashAt('sequenced', at), crashAt('unsequenced', at)]),
      );
      settled.forEach((verdict, j) => verdicts[j % 2 === 0 ? 'sequenced' : 'unsequenced'].push(verdict));
    }
    const failures = (engine: Engine) =>
      verdicts[engine].filter((v) => v.loud !== undefined || v.silent || v.reruns.length > 0);
    const sequenced = verdicts.sequenced;
    process.stdout.write(
      `real DBOS crash matrix: ${JSON.stringify({
        resumed: sequenced.filter((v) => v.resumed).length,
        gapped: sequenced.filter((v) => v.gapped).length,
        schedReplayed: sequenced.filter((v) => v.schedReplayed).length,
        controlFailures: failures('unsequenced').map((v) => ({
          at: v.at,
          loud: v.loud,
          silent: v.silent,
          reruns: v.reruns,
        })),
      })}\n`,
    );

    expect(failures('sequenced')).toEqual([]);
    expect(sequenced.filter((v) => v.resumed).length).toBeGreaterThan(points.length / 2);
    expect(sequenced.filter((v) => v.gapped).length).toBeGreaterThan(0);
    expect(sequenced.filter((v) => v.schedReplayed).length).toBeGreaterThan(0);
    expect(failures('unsequenced').length).toBeGreaterThan(0);
  }, 240_000);

  it('times a wait out at the deadline its head recorded, across a crash before its timeout row', async () => {
    const { id, trial } = await start('sequenced', plan(wait('w', 3_000)), true);
    while (!trial.executions[0]) await pause(1);
    await drained(trial.executions[0]);
    await DBOS.cancelWorkflow(id);
    expect((await rows(id)).map((r) => r.name)).toEqual(['wait|w']);
    const deadline = await recordedDeadline(id, 'wait|w');
    await pause(1_500);
    await DBOS.resumeWorkflow(id);
    await DBOS.retrieveWorkflow(id).getResult();
    const resumed = trial.executions[1]!;

    expect(await resumed.ended).toMatchObject({ ok: true, value: { outputs: { w: null } } });
    expect(Math.abs(resumed.endedAt! - deadline)).toBeLessThan(500);
  }, 30_000);

  it('ends a run whose only op is a 30 s delay within one poll of a cancel', async () => {
    const { id, trial } = await start('sequenced', plan(delay('lone', 30_000)));
    await pause(1_000);
    const cancelledAt = Date.now();
    await DBOS.cancelWorkflow(id);
    const execution = trial.executions[0]!;
    const outcome = (await execution.ended)!;
    await drained(execution);

    expect(outcome).toMatchObject({ ok: false, error: expect.any(DbosErrors.DBOSWorkflowCancelledError) });
    expect(execution.endedAt! - cancelledAt).toBeLessThanOrEqual(11_000);
  }, 30_000);

  it('ends a parked run within one poll of a cancel once both its branches have, and records nothing after', async () => {
    const parked = plan({
      kind: 'parallel',
      id: 'fork',
      branches: [[wait('w', 60_000)], [delay('far', 20_000)]],
    });
    const { id, trial } = await start('sequenced', parked);
    await pause(1_000);
    const cancelledAt = Date.now();
    await DBOS.cancelWorkflow(id);
    const execution = trial.executions[0]!;
    const outcome = (await execution.ended)!;
    const atEnd = await rows(id);
    await drained(execution);

    expect(outcome).toMatchObject({ ok: false, error: expect.any(DbosErrors.DBOSWorkflowCancelledError) });
    expect(execution.endedAt! - cancelledAt).toBeLessThanOrEqual(RECV_DELAY_ABOVE_MS + 1_000);
    expect(await rows(id)).toEqual(atEnd);
    expect(atEnd.map((r) => r.name)).toEqual([
      'wait|fork|0/w',
      'DBOS.sleep',
      'deadline|fork|1/far',
      'DBOS.sleep',
    ]);
    expect(execution.lanes).toBeGreaterThan(1);
    expect(execution.lanesOpenAtEnd).toBe(0);
  }, 30_000);
});
