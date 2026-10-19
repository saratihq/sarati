import { Logger } from '@nestjs/common';

import * as conditions from '../runtime/conditions';
import type { DagNode } from '../runtime/dag-plan';

import {
  FEATURES,
  FUZZ_ACTION,
  FUZZ_WORKFLOW,
  ROUTED_MIX,
  randomDagPlan,
  seeded,
  type Feature,
  type FuzzPlan,
  type Yield,
} from '../runtime/random-dag-plan.testkit';
import { replayRoutes, verdict as guardVerdict } from '../runtime/recovery-exposure';
import { EXECUTION, FUZZ_SCOPE, audit, crashAndReplay, type ReplayVerdict } from './replay-fuzz.testkit';
import { SLEEP, type OpRow } from './sim-dbos.testkit';

const SEEDS = 400;
const ROUTED_SEEDS = 200;
const CRASH_POINTS = [0.1, 0.3, 0.5, 0.7, 0.9];

interface Totals {
  loud: number;
  silent: number;
  reruns: number;
  misdelivered: number;
  fatalLost: number;
  stuck: number;
  budgetRefusals: number;
  inFlightAtEnd: number;
  wrongLane: number;
  drifted: number;
  answeredNull: number;
  hanging: number[];
  /** Audit violations of runs that did not diverge. */
  badLogs: string[];
  /** Audit violations of every run, diverged or not. */
  anyBadLog: number;
  /** Seeds whose replay went wrong in any way. */
  mispaired: number[];
  /** Seeds the recovery guard refuses, judged on what the killed execution had committed. */
  refused: number[];
  /** How many refusals gave each kind of reason. */
  reasons: Record<string, number>;
}

const wentWrong = (verdict: ReplayVerdict): boolean =>
  verdict.stuck ||
  verdict.loud +
    verdict.silent +
    verdict.reruns +
    verdict.misdelivered +
    verdict.wrongLane +
    verdict.drifted +
    verdict.answeredNull >
    0;

// The guard's own verdict on what the crash left, from what the run checkpointed.
const judgedAtCrash = (fuzz: FuzzPlan, replayed: ReplayVerdict) =>
  guardVerdict(
    { plan: fuzz.plan, pins: fuzz.pins, initialScope: FUZZ_SCOPE },
    replayed.atCrash.ops,
    replayed.atCrash.steps,
    fuzz.budget,
  );

// A fuzz action after `guards`, answering in `latencyMs`, its output carrying `yields` as `v`.
const step = (id: string, guards: DagNode['guards'], latencyMs = 50, yields?: Yield): DagNode => ({
  kind: 'action',
  id,
  actionId: FUZZ_ACTION,
  props: { latencyMs, behaviour: 'ok', ...(yields ? { yields } : {}) },
  guards,
});

const REASONS: Array<[RegExp, string]> = [
  [/could run beside another step/, 'beside another'],
  [/matches no node/, 'matches no node'],
  [/matches \d+ nodes/, 'ambiguous'],
  [/receive or a sleep/, 'unexplained receive or sleep'],
  [/refused a sub-workflow call/, 'refused sub-workflow call'],
  [/can't be read/, 'unreadable model turn'],
];

/** Every plan, uninterrupted, then killed and replayed on today's engine, summed. */
async function fuzz(): Promise<Totals> {
  const totals: Totals = {
    loud: 0,
    silent: 0,
    reruns: 0,
    misdelivered: 0,
    fatalLost: 0,
    stuck: 0,
    budgetRefusals: 0,
    inFlightAtEnd: 0,
    wrongLane: 0,
    drifted: 0,
    answeredNull: 0,
    hanging: [],
    badLogs: [],
    anyBadLog: 0,
    mispaired: [],
    refused: [],
    reasons: {},
  };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const plan = randomDagPlan(seeded(seed));
    const verdict = await crashAndReplay(plan, seed);
    if (!verdict.firstSettled) totals.hanging.push(seed);
    const diverged = verdict.loud + verdict.silent + verdict.reruns + verdict.misdelivered > 0;
    const logs = diverged ? verdict.firstAudit : [...verdict.firstAudit, ...verdict.replayAudit];
    totals.badLogs.push(...logs.map((violation) => `seed ${seed}: ${violation}`));
    totals.anyBadLog += verdict.firstAudit.length + verdict.replayAudit.length;
    totals.loud += verdict.loud;
    totals.silent += verdict.silent;
    totals.reruns += verdict.reruns;
    totals.misdelivered += verdict.misdelivered;
    totals.fatalLost += verdict.fatalLost ? 1 : 0;
    totals.stuck += verdict.stuck ? 1 : 0;
    totals.budgetRefusals += verdict.budgetRefusals;
    totals.inFlightAtEnd += verdict.inFlightAtEnd;
    totals.wrongLane += verdict.wrongLane;
    totals.drifted += verdict.drifted;
    totals.answeredNull += verdict.answeredNull;
    if (wentWrong(verdict)) totals.mispaired.push(seed);
    const judged = judgedAtCrash(plan, verdict);
    if (!judged.resumable) {
      totals.refused.push(seed);
      const kind = REASONS.find(([pattern]) => pattern.test(judged.reason))?.[1] ?? judged.reason;
      totals.reasons[kind] = (totals.reasons[kind] ?? 0) + 1;
    }
  }
  const { hanging, badLogs, mispaired, refused, reasons, ...counts } = totals;
  const safeRefused = refused.filter((seed) => !mispaired.includes(seed)).length;
  process.stdout.write(
    `today's engine over ${SEEDS} plans: ${JSON.stringify({ ...counts, hanging: hanging.length, badLogs: badLogs.length })}\n` +
      `the recovery guard: ${mispaired.length} replays went wrong, ${refused.length} refused ` +
      `(${refused.length - safeRefused} of them went wrong, ${safeRefused} would have replayed safely), ` +
      `by reason ${JSON.stringify(reasons)}\n`,
  );
  return totals;
}

let legacy: Promise<Totals> | undefined;
const fuzzOnce = (): Promise<Totals> => (legacy ??= fuzz());

describe('crash-and-replay fuzz over SimDBOS', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  beforeAll(() => Logger.overrideLogger(false));
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('generates every shape a replay has to survive, many times over', () => {
    const seen = new Map<Feature, number>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const feature of randomDagPlan(seeded(seed)).features)
        seen.set(feature, (seen.get(feature) ?? 0) + 1);
    }
    expect(FEATURES.filter((feature) => (seen.get(feature) ?? 0) < 10)).toEqual([]);
  });

  it("still mis-pairs on today's engine in every way DBOS lets through, but never past a fatal error or with an op in flight", async () => {
    const legacy = await fuzzOnce();
    expect(legacy.hanging).toEqual([]);
    expect(legacy.badLogs).toEqual([]);
    expect(legacy.loud).toBeGreaterThan(0);
    expect(legacy.silent).toBeGreaterThan(0);
    expect(legacy.reruns).toBeGreaterThan(0);
    expect(legacy.misdelivered).toBeGreaterThan(0);
    expect(legacy.wrongLane).toBeGreaterThan(0);
    expect(legacy.drifted).toBeGreaterThan(0);
    expect(legacy.answeredNull).toBeGreaterThan(0);
    expect(legacy.budgetRefusals).toBeGreaterThan(0);
    expect([legacy.fatalLost, legacy.inFlightAtEnd]).toEqual([0, 0]);
  }, 120_000);

  it('has the recovery guard refuse every run whose replay goes wrong, judged on what the crash left', async () => {
    const { mispaired, refused } = await fuzzOnce();
    expect(mispaired.length).toBeGreaterThan(0);
    expect(mispaired.filter((seed) => !refused.includes(seed))).toEqual([]);
  }, 120_000);

  it("has the recovery guard refuse every replay that goes wrong after a sub-workflow step's child spent the budget an agent is then refused", async () => {
    // `spend`'s child spends the run's one call, so the agent's call is refused; a replay's child spends nothing.
    const fuzz: FuzzPlan = {
      plan: {
        id: 'fuzz',
        nodes: [
          { kind: 'callWorkflow', id: 'spend', workflowId: FUZZ_WORKFLOW, input: {}, guards: [] },
          {
            kind: 'agent',
            id: 'ask',
            systemPrompt: 'fuzz node=ask rounds=2 calls=1',
            model: { provider: 'claude', model: 'fuzz' },
            maxSteps: 3,
            tools: [{ kind: 'workflow', name: 'w0', workflowId: FUZZ_WORKFLOW }],
            guards: [{ source: 'spend', port: 0 }],
          },
          {
            kind: 'action',
            id: 'tail',
            actionId: FUZZ_ACTION,
            props: { latencyMs: 50, behaviour: 'ok' },
            guards: [{ source: 'ask', port: 0 }],
          },
        ],
      },
      pins: {},
      budget: 1,
      features: new Set(),
      fatal: new Set(),
    };
    const wrong: number[] = [];
    const missed: number[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const verdict = await crashAndReplay(fuzz, seed);
      if (!wentWrong(verdict)) continue;
      wrong.push(seed);
      const judged = judgedAtCrash(fuzz, verdict);
      if (judged.resumable || judged.cause !== 'refused-call') missed.push(seed);
    }
    expect(wrong.length).toBeGreaterThan(0);
    expect(missed).toEqual([]);
  }, 120_000);

  it.each([
    [
      'a pinned step the run routed away',
      [
        { kind: 'if', id: 'gate', condition: { left: '{{trigger.items}}', op: 'truthy' }, guards: [] },
        step('pinned', [{ source: 'gate', port: 1 }]),
        step('q', [{ source: 'gate', port: 0 }]),
        step('join', [
          { source: 'pinned', port: 0 },
          { source: 'q', port: 0 },
        ]),
      ] as DagNode[],
      'pinned',
      'join',
      { pinned: { v: true } },
    ],
    [
      'a pin on a wait',
      [{ kind: 'waitForEvent', id: 'pinned', topic: 'approval', timeoutMs: 2_000, guards: [] }] as DagNode[],
      'pinned',
      'pinned',
      { pinned: { v: true } },
    ],
    ['a Date a step answered', [step('prep', [], 50, 'date')], 'prep', 'prep', {}],
  ])(
    'has the recovery guard refuse every replay that goes wrong past a router reading %s',
    async (_, head, read, after, pins) => {
      // What the router reads is false on replay — no pin applies, a Date has no keys — so it takes port 1, where two chains race.
      const fuzz: FuzzPlan = {
        plan: {
          id: 'fuzz',
          nodes: [
            ...head,
            {
              kind: 'if',
              id: 'r',
              condition: { left: `{{${read}.v}}`, op: 'truthy' },
              guards: [{ source: after, port: 0 }],
            },
            step('solo', [{ source: 'r', port: 0 }]),
            step('fast', [{ source: 'r', port: 1 }], 10),
            step('fast2', [{ source: 'fast', port: 0 }]),
            step('slow', [{ source: 'r', port: 1 }], 300),
            step('slow2', [{ source: 'slow', port: 0 }]),
          ],
        },
        pins,
        budget: 64,
        features: new Set(),
        fatal: new Set(),
      };
      const wrong: number[] = [];
      const missed: number[] = [];
      for (let seed = 1; seed <= 60; seed++) {
        const replay = await crashAndReplay(fuzz, seed);
        if (!wentWrong(replay)) continue;
        wrong.push(seed);
        if (judgedAtCrash(fuzz, replay).resumable) missed.push(seed);
      }
      expect(wrong.length).toBeGreaterThan(0);
      expect(missed).toEqual([]);
    },
    120_000,
  );

  it('takes, for every router it judges on a routed plan, the port the replay takes, and refuses every replay that goes wrong', async () => {
    const routedPort = conditions.routedPort;
    const replayed = new Map<string, number>();
    let top = new Set<unknown>();
    const spy = jest.spyOn(conditions, 'routedPort').mockImplementation((router, scope, sink) => {
      const port = routedPort(router, scope, sink);
      if ((scope as Record<symbol, unknown>)[EXECUTION] === 'replay' && top.has(router)) {
        replayed.set((router as DagNode).id, port);
      }
      return port;
    });
    const mismatched: string[] = [];
    const admitted: string[] = [];
    let judged = 0;
    let wrong = 0;
    try {
      for (let seed = 1; seed <= ROUTED_SEEDS; seed++) {
        const fuzz = randomDagPlan(seeded(seed), 'fuzz', ROUTED_MIX);
        top = new Set(fuzz.plan.nodes);
        for (const crashAt of CRASH_POINTS) {
          replayed.clear();
          const replay = await crashAndReplay(fuzz, seed, crashAt);
          const run = { plan: fuzz.plan, pins: fuzz.pins, initialScope: FUZZ_SCOPE };
          for (const [id, port] of replayRoutes(run, replay.atCrash.ops)) {
            if (!replayed.has(id)) continue;
            judged += 1;
            if (replayed.get(id) !== port) {
              mismatched.push(
                `seed ${seed} at ${crashAt}: ${id} judged ${port}, replayed ${replayed.get(id)}`,
              );
            }
          }
          if (!wentWrong(replay)) continue;
          wrong += 1;
          if (judgedAtCrash(fuzz, replay).resumable) admitted.push(`seed ${seed} at ${crashAt}`);
        }
      }
    } finally {
      spy.mockRestore();
    }
    process.stdout.write(
      `routed plans: ${judged} routes judged against their replay, ${wrong} replays went wrong, ${admitted.length} let through\n`,
    );
    expect(mismatched).toEqual([]);
    expect(admitted).toEqual([]);
    expect(judged).toBeGreaterThan(500);
  }, 600_000);

  it('audits a log for a gap, a name the plan never issues, and a row past what the execution reserved', () => {
    const plan = { id: 'p', nodes: [{ kind: 'delay' as const, id: 'pause', ms: 5, guards: [] }] };
    const row = (id: number, name: string): [number, OpRow] => [id, { id, name, recordedAt: 0 }];
    const rows = new Map([row(0, 'p:pause'), row(2, 'p:elsewhere'), row(4, SLEEP)]);
    expect(audit(plan, rows, { reserved: 4, rowless: [{ id: 3, why: 'zero sleep' }] })).toEqual([
      'op 2 is named "p:elsewhere", which the plan never issues',
      'op 4 lies past the 4 ids reserved',
      'op 1 was reserved and never recorded',
    ]);
  });
});
