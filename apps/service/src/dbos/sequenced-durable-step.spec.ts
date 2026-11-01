import type { Park } from '../providers/durable-step';
import { SequencedDurableStep } from './sequenced-durable-step';
import { SimExecution, SimWorkflow, VirtualClock, simOps } from './sim-dbos.testkit';

describe('SequencedDurableStep.delay, parked', () => {
  it('hands history the deadline its head recorded, and reports that one, live and on a replay', async () => {
    const clock = new VirtualClock();
    const wf = new SimWorkflow('wf', clock);
    const parks: Park[] = [];
    const delayed = async (): Promise<Date | null> => {
      const durable = new SequencedDurableStep(simOps(new SimExecution(wf, () => 5), clock));
      let due: Date | null | undefined;
      void durable
        .root(() =>
          durable.delay(
            { name: 'pause', stepKey: 'pause', ms: 61_000 },
            {
              parked: (park) => {
                parks.push(park);
                return clock.sleep(3_000).then(() => null);
              },
              resumed: () => Promise.resolve(),
            },
          ),
        )
        .then((value) => (due = value));
      await clock.drive(() => due !== undefined);
      return due!;
    };

    const live = await delayed();
    const head = [...wf.rows.values()].find((row) => row.name === 'deadline|pause')!.output as {
      deadline: number;
    };
    expect(live).toEqual(new Date(head.deadline));
    expect(await delayed()).toEqual(live);
    expect(parks.map((park) => park.due)).toEqual([live, live]);
  });
});
