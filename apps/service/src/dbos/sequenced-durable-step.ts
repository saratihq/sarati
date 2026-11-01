import { DBOS } from '@dbos-inc/dbos-sdk';

import {
  RunCancelledError,
  type EventWait,
  type Lane,
  type Outcome,
  type ParkHooks,
  type Pause,
} from '../providers/durable-step';
import { PARK_DELAY_ABOVE_MS, timerTopicFor } from '../runtime/timer-wait';
import { DbosDurableStep } from './dbos-durable-step';
import { RunSequencer, type SequencedOps } from './run-sequencer';

/** The sequencer's DBOS calls, made directly: nothing may await between an op's call and DBOS reserving its ids. */
export function dbosOps(): SequencedOps {
  return {
    runStep: (fn, name) => DBOS.runStep(fn, { name }),
    sleepms: (ms) => DBOS.sleepms(ms),
    recv: (topic, options) => DBOS.recv(topic, options),
    now: () => Date.now(),
  };
}

/** The sequenced engine's substrate: every op goes through one {@link RunSequencer}, so a replay issues them in recorded order. */
export class SequencedDurableStep extends DbosDurableStep {
  private readonly sequencer: RunSequencer;

  constructor(ops: SequencedOps) {
    super();
    // The row gate's cancel too, which ends a run as a DBOS cancel does.
    this.sequencer = new RunSequencer(ops, (err) => this.isFatal(err) || err instanceof RunCancelledError);
  }

  override run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.sequencer.step(name, fn);
  }

  override root<T>(fn: () => Promise<T>): Promise<T> {
    return this.sequencer.run(fn);
  }

  override spawn(fn: () => Promise<unknown>): Lane {
    return this.sequencer.spawn(fn);
  }

  override joinAny(lanes: readonly Lane[]): Promise<{ lane: Lane; outcome: Outcome }> {
    return this.sequencer.joinAny(lanes);
  }

  override joinAll(lanes: readonly Lane[]): Promise<Outcome[]> {
    return this.sequencer.joinAll(lanes);
  }

  override async delay(pause: Pause, hooks: ParkHooks): Promise<Date | null> {
    const deadline = await this.sequencer.delay(pause.stepKey, pause.ms, {
      parked: async (due) => {
        await hooks.parked({
          topic: timerTopicFor(pause.stepKey),
          deliveryTopic: null,
          durationMs: pause.ms,
          due: new Date(due),
        });
      },
      resumed: () => hooks.resumed(false),
    });
    // The deadline its head recorded, which every replay keeps: the one it woke at.
    return pause.ms > PARK_DELAY_ABOVE_MS ? new Date(deadline) : null;
  }

  override async waitForEvent<T = unknown>(wait: EventWait, hooks: ParkHooks): Promise<T | null> {
    // An event with no payload arrives as `undefined`: answered, and bound as null.
    const payload = await this.sequencer.wait<T>(
      wait.stepKey,
      wait.deliveryTopic ?? wait.topic,
      wait.timeoutMs,
      {
        parked: async () => {
          await hooks.parked({
            topic: wait.topic,
            deliveryTopic: wait.deliveryTopic,
            durationMs: wait.timeoutMs,
            due: null,
          });
        },
        resumed: (answered) => hooks.resumed(answered),
      },
    );
    return payload ?? null;
  }
}
