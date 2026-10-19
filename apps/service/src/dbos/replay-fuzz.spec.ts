import { Logger } from '@nestjs/common';

import { FEATURES, randomDagPlan, seeded, type Feature } from '../runtime/random-dag-plan.testkit';
import { audit, crashAndReplay } from './replay-fuzz.testkit';
import { SLEEP, type OpRow } from './sim-dbos.testkit';

const SEEDS = 400;

describe('crash-and-replay fuzz over SimDBOS', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('generates every shape a replay has to survive, many times over', () => {
    const seen = new Map<Feature, number>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const feature of randomDagPlan(seeded(seed)).features)
        seen.set(feature, (seen.get(feature) ?? 0) + 1);
    }
    expect(FEATURES.filter((feature) => (seen.get(feature) ?? 0) < 10)).toEqual([]);
  });

  it("mis-pairs on today's engine in every way DBOS lets through, while every log that did not diverge passes the audit", async () => {
    const totals = {
      loud: 0,
      silent: 0,
      reruns: 0,
      misdelivered: 0,
      fatalLost: 0,
      stuck: 0,
      budgetRefusals: 0,
      inFlightAtEnd: 0,
    };
    const hanging: number[] = [];
    const badLogs: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const verdict = await crashAndReplay(randomDagPlan(seeded(seed)), seed);
      if (!verdict.firstSettled) hanging.push(seed);
      const diverged = verdict.loud + verdict.silent + verdict.reruns + verdict.misdelivered > 0;
      const logs = diverged ? verdict.firstAudit : [...verdict.firstAudit, ...verdict.replayAudit];
      badLogs.push(...logs.map((violation) => `seed ${seed}: ${violation}`));
      totals.loud += verdict.loud;
      totals.silent += verdict.silent;
      totals.reruns += verdict.reruns;
      totals.misdelivered += verdict.misdelivered;
      totals.fatalLost += verdict.fatalLost ? 1 : 0;
      totals.stuck += verdict.stuck ? 1 : 0;
      totals.budgetRefusals += verdict.budgetRefusals;
      totals.inFlightAtEnd += verdict.inFlightAtEnd;
    }
    process.stdout.write(`legacy control over ${SEEDS} plans: ${JSON.stringify(totals)}\n`);

    expect(hanging).toEqual([]);
    expect(badLogs).toEqual([]);
    expect(totals.loud).toBeGreaterThan(0);
    expect(totals.silent).toBeGreaterThan(0);
    expect(totals.reruns).toBeGreaterThan(0);
    expect(totals.misdelivered).toBeGreaterThan(0);
    expect(totals.fatalLost).toBeGreaterThan(0);
    expect(totals.budgetRefusals).toBeGreaterThan(0);
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
