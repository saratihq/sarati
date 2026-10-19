import { Logger } from '@nestjs/common';

import {
  FEATURES,
  FUZZ_ACTION,
  FUZZ_WORKFLOW,
  randomDagPlan,
  seeded,
  type Feature,
  type FuzzPlan,
} from '../runtime/random-dag-plan.testkit';
import { resumability } from '../runtime/recovery-exposure';
import { audit, crashAndReplay, type ReplayVerdict } from './replay-fuzz.testkit';
import { SLEEP, type OpRow } from './sim-dbos.testkit';

const SEEDS = 400;

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
    const judged = resumability(plan.plan, verdict.atCrash);
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
      const judged = resumability(fuzz.plan, verdict.atCrash);
      if (judged.resumable || judged.cause !== 'refused-call') missed.push(seed);
    }
    expect(wrong.length).toBeGreaterThan(0);
    expect(missed).toEqual([]);
  }, 120_000);

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
