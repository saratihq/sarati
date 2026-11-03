import { DomainError } from '../common/domain-error';
import { stepLimitReached } from '../entitlements/run-limits';
import { SequencedDurableStep } from '../dbos/sequenced-durable-step';
import { SimExecution, SimWorkflow, VirtualClock, simOps } from '../dbos/sim-dbos.testkit';
import { InMemoryRunMeter, MeteredDurableStep, type RunMeter } from './run-meter';

const clock = new VirtualClock();

// One execution of a two-op run on `wf` under `meter`, driven to its end: what it resolved or rejected with.
async function execute(
  wf: SimWorkflow,
  meter: RunMeter,
): Promise<{ durable: MeteredDurableStep; error?: unknown }> {
  const durable = new MeteredDurableStep(
    new SequencedDurableStep(simOps(new SimExecution(wf, () => 5), clock)),
    meter,
    false,
  );
  let settled: { error?: unknown } | undefined;
  void durable
    .root(async () => {
      await durable.run('a', () => Promise.resolve('a'));
      await durable.run('b', () => Promise.resolve('b'));
    })
    .then(
      () => (settled = {}),
      (error: unknown) => (settled = { error }),
    );
  await clock.drive(() => settled !== undefined);
  return { durable, ...settled };
}

describe('MeteredDurableStep', () => {
  it('charges inside the step body, never on a memoized replay', async () => {
    const wf = new SimWorkflow('charged', clock);
    let charges = 0;
    const meter: RunMeter = {
      charge: () => {
        charges += 1;
        return Promise.resolve();
      },
      resuming: () => Promise.resolve(),
    };

    await execute(wf, meter);
    await execute(wf, meter);

    expect(charges).toBe(2);
  });

  it('a refusal stays fatal after a round trip through StepBodyError and through DBOS’s error serialization', async () => {
    const wf = new SimWorkflow('refused', clock);
    const refusing: RunMeter = {
      charge: () => Promise.reject(stepLimitReached(1)),
      resuming: () => Promise.resolve(),
    };

    const live = await execute(wf, refusing);
    const replay = await execute(wf, { charge: () => Promise.resolve(), resuming: () => Promise.resolve() });

    for (const { durable, error } of [live, replay]) {
      expect(error).toBeInstanceOf(DomainError);
      expect(durable.isFatal(error)).toBe(true);
    }
    expect(replay.error).toMatchObject({
      status: 422,
      details: { code: 'run_limit_reached', limit: 'run.steps' },
    });
    const deserialized = Object.assign(new Error(stepLimitReached(1).message), {
      name: 'DomainError',
      details: stepLimitReached(1).details,
    });
    expect(live.durable.isFatal(deserialized)).toBe(true);
    expect(live.durable.isFatal(new Error('an ordinary failure'))).toBe(false);
  });
});

describe('InMemoryRunMeter', () => {
  it('takes one step per charge and refuses the one past its limit, and none counts nothing', async () => {
    const meter = new InMemoryRunMeter(2);
    await meter.charge(false);
    await meter.charge(false);
    await expect(meter.charge(false)).rejects.toMatchObject({
      details: { code: 'run_limit_reached', max: 2 },
    });
    const unlimited = new InMemoryRunMeter(null);
    for (let i = 0; i < 10; i++) await unlimited.charge(false);
  });
});
