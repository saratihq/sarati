import { Logger } from '@nestjs/common';

import { FEATURES, randomDagPlan, seeded, type Feature } from '../runtime/random-dag-plan.testkit';
import { audit, crashAndReplay } from './replay-fuzz.testkit';
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
}

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
  };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const verdict = await crashAndReplay(randomDagPlan(seeded(seed)), seed);
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
  }
  const { hanging, badLogs, ...counts } = totals;
  process.stdout.write(
    `today's engine over ${SEEDS} plans: ${JSON.stringify({ ...counts, hanging: hanging.length, badLogs: badLogs.length })}\n`,
  );
  return totals;
}

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
    const legacy = await fuzz();
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
