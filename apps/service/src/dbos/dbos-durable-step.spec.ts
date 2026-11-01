import type { Park } from '../providers/durable-step';
import { SimDbosDurableStep, SimExecution, SimWorkflow, VirtualClock } from './sim-dbos.testkit';

describe('DbosDurableStep.delay, parked, as a run recovered on the legacy engine', () => {
  it.each([
    ['the one history keeps', new Date('2026-10-20T08:13:34.296Z')],
    ['none, when history keeps none', null],
  ])('reports as its due %s, never one dated from the replay', async (_, kept) => {
    const clock = new VirtualClock();
    const durable = new SimDbosDurableStep(new SimExecution(new SimWorkflow('wf', clock), () => 5), clock);
    const parks: Park[] = [];
    let due: Date | null | undefined;
    void durable
      .root(() =>
        durable.delay(
          { name: 'pause', stepKey: 'pause', ms: 61_000 },
          {
            parked: (park) => {
              parks.push(park);
              return Promise.resolve(kept);
            },
            resumed: () => Promise.resolve(),
          },
        ),
      )
      .then((value) => (due = value));
    await clock.drive(() => due !== undefined);
    expect(due).toEqual(kept);
    expect(parks.map((park) => park.due)).toEqual([null]);
  });
});
