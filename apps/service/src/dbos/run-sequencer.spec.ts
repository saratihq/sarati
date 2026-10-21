import { Error as DbosErrors } from '@dbos-inc/dbos-sdk';
import { Logger } from '@nestjs/common';

import { DomainError } from '../common/domain-error';
import { eventTopicFor } from '../runtime/event-wait';
import { DeterminismError, type Outcome } from '../providers/durable-step';
import { RunSequencer, type SequencedOps } from './run-sequencer';
import { SimExecution, SimWorkflow, VirtualClock, simOps } from './sim-dbos.testkit';

const fatal = (error: unknown): boolean =>
  error instanceof DeterminismError ||
  error instanceof DbosErrors.DBOSWorkflowCancelledError ||
  error instanceof DbosErrors.DBOSUnexpectedStepError;

interface Execution {
  execution: SimExecution;
  outcome?: Outcome;
  settledAt?: number;
}

/** One durable workflow on a virtual clock, executed and re-executed by a {@link RunSequencer}. */
class Rig {
  readonly clock = new VirtualClock();
  readonly wf = new SimWorkflow('wf', this.clock);

  start(
    program: (seq: RunSequencer) => Promise<unknown>,
    latency: () => number = () => 1,
    wrap: (ops: SequencedOps) => SequencedOps = (ops) => ops,
  ): Execution {
    const execution = new SimExecution(this.wf, latency);
    const seq = new RunSequencer(wrap(simOps(execution, this.clock)), fatal);
    const run: Execution = { execution };
    seq
      .run(() => program(seq))
      .then(
        (value) => this.end(run, { ok: true, value }),
        (error: unknown) => this.end(run, { ok: false, error }),
      );
    return run;
  }

  async finish(run: Execution): Promise<Outcome> {
    await this.clock.drive(() => run.outcome !== undefined);
    return run.outcome!;
  }

  sched(): Array<{ inFlight: string[]; settled: number[] }> {
    return [...this.wf.rows.values()]
      .filter((row) => row.name.startsWith('sched|'))
      .map((row) => row.output as { inFlight: string[]; settled: number[] });
  }

  private end(run: Execution, outcome: Outcome): void {
    run.outcome = outcome;
    run.settledAt = this.clock.now();
  }
}

// A latency profile replayed in order, then 1 ms for every call after it.
const profile =
  (...ms: number[]): (() => number) =>
  () =>
    ms.shift() ?? 1;

describe('RunSequencer over SimDBOS', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  const twoChains =
    (rig: Rig) =>
    (seq: RunSequencer): Promise<Outcome[]> => {
      const chain = (name: string, ms: number) =>
        seq.spawn(async () => {
          await seq.step(name, () => rig.clock.sleep(ms).then(() => name));
          return seq.step(`${name}2`, () => Promise.resolve(`${name}2`));
        });
      return seq.joinAll([chain('a', 50), chain('b', 10)]);
    };

  it('replays concurrent ops in the order its history recorded, whatever order they settle in on replay', async () => {
    const rig = new Rig();
    const first = rig.start(twoChains(rig));
    const ran = await rig.finish(first);
    // On replay `a` reads back first: without the recorded order it would issue `a2` where `b2` was.
    const replay = rig.start(twoChains(rig), profile(1, 40));
    expect(await rig.finish(replay)).toEqual(ran);
    expect(replay.execution.issued).toEqual(first.execution.issued);
    expect([rig.wf.stats.loud, rig.wf.stats.silent, rig.wf.stats.reruns]).toEqual([0, [], []]);
  });

  it('records a sched step by issue index, naming a wait by its head, only while two or more ops are in flight', async () => {
    const rig = new Rig();
    const run = rig.start(async (seq) => {
      await seq.step('before', () => Promise.resolve('before'));
      const waiting = seq.spawn(() => seq.wait('w', eventTopicFor('w'), 5_000));
      const stepping = seq.spawn(() => seq.step('a', () => rig.clock.sleep(20).then(() => 'a')));
      await seq.joinAll([waiting, stepping]);
      return seq.step('alone', () => Promise.resolve('alone'));
    });
    rig.clock.at(100, () => rig.wf.send({ decided: true }, eventTopicFor('w')));
    expect(await rig.finish(run)).toMatchObject({ ok: true });
    expect(rig.sched()).toEqual([{ inFlight: ['wait|w', 'step|a'], settled: [2] }]);
  });

  it('starts lanes first in, first out, so their first ops take ids in the order they were spawned', async () => {
    const rig = new Rig();
    const run = rig.start(async (seq) => {
      const lanes = ['l0', 'l1', 'l2', 'l3'].map((name) =>
        seq.spawn(() => seq.step(name, () => Promise.resolve(name))),
      );
      return seq.joinAll(lanes);
    });
    await rig.finish(run);
    expect(run.execution.issued.filter((name) => name.startsWith('step|'))).toEqual([
      'step|l0',
      'step|l1',
      'step|l2',
      'step|l3',
    ]);
  });

  it('keeps one deadline for a wait across a crash between its head and its timeout row', async () => {
    const rig = new Rig();
    const program = (seq: RunSequencer): Promise<unknown> => seq.wait('w', eventTopicFor('w'), 5_000);
    const first = rig.start(program, () => 5);
    await rig.clock.drive(() => rig.wf.rows.has(0));
    expect(rig.wf.rows.has(2)).toBe(false);
    first.execution.crash();
    const recorded = rig.wf.rows.get(0)!.output as { deadline: number };
    let reboot: Execution | undefined;
    rig.clock.at(2_000, () => {
      reboot = rig.start(program, () => 5);
    });
    await rig.clock.drive(() => reboot?.outcome !== undefined);
    expect(reboot!.outcome).toEqual({ ok: true, value: null });
    expect(reboot!.settledAt! - recorded.deadline).toBeLessThan(50);
  });

  it.each([
    ['sleeps', 5_000],
    ['parks on a receive', 30_000],
  ])(
    'keeps one deadline for a delay that %s across a crash between its head and its sleep',
    async (_, ms) => {
      const rig = new Rig();
      const program = (seq: RunSequencer): Promise<unknown> => seq.delay('d', ms);
      const first = rig.start(program, () => 5);
      await rig.clock.drive(() => rig.wf.rows.has(0));
      expect([...rig.wf.rows.keys()]).toEqual([0]);
      first.execution.crash();
      const recorded = rig.wf.rows.get(0)!.output as { deadline: number };
      let reboot: Execution | undefined;
      rig.clock.at(2_000, () => {
        reboot = rig.start(program, () => 5);
      });
      await rig.clock.drive(() => reboot?.outcome !== undefined);
      expect(reboot!.outcome).toEqual({ ok: true, value: recorded.deadline });
      expect(reboot!.settledAt! - recorded.deadline).toBeLessThan(50);
    },
  );

  it('fails a replay that delays for another length than its head recorded', async () => {
    const rig = new Rig();
    await rig.finish(rig.start((seq) => seq.delay('d', 5_000)));
    const replay = await rig.finish(rig.start((seq) => seq.delay('d', 30_000)));
    expect(replay).toMatchObject({ ok: false, error: expect.any(DeterminismError) });
    expect(String((replay as { error: Error }).error.message)).toMatch(/recorded a delay of 5000 ms/);
  });

  it('keeps the issue order when each lane awaits a gate in its glue before it issues, but not when the op awaits it', async () => {
    const gateMs = [30, 1, 15, 5];
    const lanes = (seq: RunSequencer, gate: (i: number) => Promise<void>) =>
      seq.joinAll(
        gateMs.map((_, i) =>
          seq.spawn(async () => {
            await gate(i);
            return seq.step(`l${i}`, () => Promise.resolve(i));
          }),
        ),
      );
    const inGlue = new Rig();
    const glued = inGlue.start((seq) => lanes(seq, (i) => inGlue.clock.sleep(gateMs[i]!)));
    await inGlue.finish(glued);
    const steps = (issued: string[]): string[] => issued.filter((name) => name.startsWith('step|'));
    expect(steps(glued.execution.issued)).toEqual(['step|l0', 'step|l1', 'step|l2', 'step|l3']);

    const inOp = new Rig();
    const afterAwait = (ops: SequencedOps): SequencedOps => ({
      ...ops,
      runStep: async (fn, name) => {
        await inOp.clock.sleep(gateMs[Number(name.slice(-1))]!);
        return ops.runStep(fn, name);
      },
    });
    const opGated = inOp.start(
      (seq) => lanes(seq, () => Promise.resolve()),
      () => 1,
      afterAwait,
    );
    await inOp.finish(opGated);
    expect(steps(opGated.execution.issued)).toEqual(['step|l1', 'step|l3', 'step|l2', 'step|l0']);
  });

  it('refuses to join no lanes at all, rather than waiting forever', async () => {
    const rig = new Rig();
    const run = rig.start(async (seq) => seq.joinAny([]));
    expect(await rig.finish(run)).toMatchObject({
      ok: false,
      error: new Error('joinAny needs at least one lane to wait for'),
    });
  });

  it('warns when one lane holds the turn past the watchdog, as no other lane can run meanwhile', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const clock = new VirtualClock();
      const seq = new RunSequencer(
        simOps(new SimExecution(new SimWorkflow('wf', clock), () => 1), clock),
        fatal,
        20,
      );
      await seq.run(() => new Promise((resolve) => setTimeout(resolve, 60)));
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^lane 0 has held the run's turn for 20 ms/));
    } finally {
      warn.mockRestore();
    }
  });

  it('runs step bodies side by side: the turn holds only the glue between ops', async () => {
    const rig = new Rig();
    const run = rig.start(async (seq) =>
      seq.joinAll(
        ['x', 'y'].map((name) =>
          seq.spawn(() => seq.step(name, () => rig.clock.sleep(500).then(() => name))),
        ),
      ),
    );
    await rig.finish(run);
    expect(run.settledAt).toBeLessThan(600);
  });

  it('refuses an op issued from outside its lane’s turn, and fails the run', async () => {
    const rig = new Rig();
    const run = rig.start((seq) =>
      seq.step('outer', async () => {
        await seq.step('inner', () => Promise.resolve('inner'));
        return 'outer';
      }),
    );
    const outcome = await rig.finish(run);
    expect(outcome).toMatchObject({ ok: false, error: expect.any(DeterminismError) });
    expect(run.execution.issued).not.toContain('step|inner');
  });

  it('ends a run within one poll once cancelled with ops in flight, issuing and recording nothing after', async () => {
    const rig = new Rig();
    let refused: unknown;
    let ended = 0;
    const lane = (seq: RunSequencer, fn: () => Promise<unknown>) =>
      seq.spawn(async () => {
        try {
          return await fn();
        } finally {
          ended += 1;
        }
      });
    const run = rig.start(async (seq) =>
      seq.joinAll([
        lane(seq, () => seq.wait('w', eventTopicFor('w'), 60_000)),
        lane(seq, async () => {
          await seq.step('long', () => rig.clock.sleep(3_000).then(() => 'long'));
          try {
            await seq.step('next', () => Promise.resolve('next'));
          } catch (error) {
            refused = error;
          }
        }),
        lane(seq, () => seq.delay('far', 20_000)),
        lane(seq, () => seq.delay('near', 5_000)),
      ]),
    );
    rig.clock.at(1_000, () => {
      rig.wf.cancelled = true;
    });
    const outcome = await rig.finish(run);
    const [reserved, scheds] = [run.execution.reserved, rig.sched().length];
    await rig.clock.drive();

    expect(outcome).toMatchObject({ ok: false, error: expect.any(DbosErrors.DBOSWorkflowCancelledError) });
    expect(run.settledAt! - 1_000).toBeLessThanOrEqual(10_000 + 100);
    expect(run.execution.reserved).toBe(reserved);
    expect(run.execution.issued).not.toContain('step|next');
    expect(rig.sched().length).toBe(scheds);
    expect(refused).toBeInstanceOf(DbosErrors.DBOSWorkflowCancelledError);
    expect(ended).toBe(4);
  });

  it('ends a failed run once the step bodies it had running have, handing each its result, but never waits out a receive', async () => {
    const rig = new Rig();
    const gluedAt: number[] = [];
    const run = rig.start(async (seq) =>
      seq.joinAll([
        seq.spawn(async () => {
          await seq.step('slow', () => rig.clock.sleep(2_000).then(() => 'slow'));
          gluedAt.push(rig.clock.now());
        }),
        seq.spawn(() => seq.wait('w', eventTopicFor('w'), 60_000)),
        seq.spawn(() =>
          seq.step('boom', () =>
            rig.clock.sleep(100).then(() => Promise.reject(new DeterminismError('boom'))),
          ),
        ),
      ]),
    );
    expect(await rig.finish(run)).toMatchObject({ ok: false, error: new DeterminismError('boom') });
    expect(run.settledAt).toBeGreaterThanOrEqual(2_000);
    expect(run.settledAt).toBeLessThan(2_100);
    expect(gluedAt).toHaveLength(1);
    expect(gluedAt[0]).toBeLessThanOrEqual(run.settledAt!);
  });

  it('ends a run whose only op is a 30 s delay within one poll of a cancel', async () => {
    const rig = new Rig();
    const run = rig.start((seq) => seq.delay('d', 30_000));
    rig.clock.at(1_000, () => {
      rig.wf.cancelled = true;
    });
    const outcome = await rig.finish(run);
    expect(outcome).toMatchObject({ ok: false, error: expect.any(DbosErrors.DBOSWorkflowCancelledError) });
    expect(run.settledAt! - 1_000).toBeLessThanOrEqual(11_000);
  });

  it('issues no op on a settle order before its sched commits, so a crash in that window replays to whichever order comes', async () => {
    const rig = new Rig();
    const slowSched = (ops: SequencedOps): SequencedOps => ({
      ...ops,
      runStep: (fn, name) =>
        name.startsWith('sched|')
          ? ops.runStep(() => rig.clock.sleep(1_000).then(fn), name)
          : ops.runStep(fn, name),
    });
    const first = rig.start(twoChains(rig), () => 1, slowSched);
    await rig.clock.drive(() => rig.clock.now() >= 500);
    // Both bodies are recorded and `b` settled first, but nothing is issued on that order until it is recorded.
    expect([...rig.wf.rows.values()].map((row) => row.name).sort()).toEqual(['step|a', 'step|b']);
    expect(first.execution.issued).toEqual(['step|a', 'step|b', 'sched|0']);
    first.execution.crash();

    // On replay `a` reads back first, the other order: that is the order recorded and followed.
    const replay = rig.start(twoChains(rig), profile(1, 40));
    expect(await rig.finish(replay)).toEqual({
      ok: true,
      value: [
        { ok: true, value: 'a2' },
        { ok: true, value: 'b2' },
      ],
    });
    expect(rig.sched()[0]).toEqual({ inFlight: ['step|a', 'step|b'], settled: [0] });
    expect([rig.wf.stats.loud, rig.wf.stats.silent, rig.wf.stats.reruns]).toEqual([0, [], []]);
  });

  it('ends a failed run only once the sched step it was recording has settled', async () => {
    const rig = new Rig();
    const slowRecord = (ops: SequencedOps): SequencedOps => ({
      ...ops,
      runStep: (fn, name) => {
        if (name.startsWith('sched|')) return ops.runStep(() => rig.clock.sleep(1_000).then(fn), name);
        if (name === 'step|refused') {
          return ops.runStep(
            () => rig.clock.sleep(50).then(() => Promise.reject(new Error('lookup refused'))),
            name,
          );
        }
        return ops.runStep(fn, name);
      },
    });
    const run = rig.start(
      (seq) =>
        seq.joinAll([
          seq.spawn(() => seq.step('fast', () => Promise.resolve('fast'))),
          seq.spawn(() => seq.step('refused', () => Promise.resolve('refused'))),
          seq.spawn(() => seq.step('slow', () => rig.clock.sleep(500).then(() => 'slow'))),
        ]),
      () => 1,
      slowRecord,
    );
    expect(await rig.finish(run)).toMatchObject({ ok: false, error: new Error('lookup refused') });
    expect(run.execution.stepsInFlight).toBe(0);
    expect(run.settledAt).toBeGreaterThanOrEqual(1_000);
  });

  it.each([
    ['wait', (seq: RunSequencer) => seq.wait('w', eventTopicFor('w'), 60_000)],
    ['delay', (seq: RunSequencer) => seq.delay('w', 30_000)],
  ])(
    'issues no receive or sleep for a %s whose head lands after another lane poisoned the run',
    async (_, park) => {
      const rig = new Rig();
      const timed = (ops: SequencedOps): SequencedOps => ({
        ...ops,
        runStep: (fn, name) => {
          if (name.endsWith('|w')) return ops.runStep(() => rig.clock.sleep(100).then(fn), name);
          if (name === 'step|refused') {
            return ops.runStep(
              () => rig.clock.sleep(50).then(() => Promise.reject(new Error('lookup refused'))),
              name,
            );
          }
          return ops.runStep(fn, name);
        },
      });
      const run = rig.start(
        (seq) =>
          seq.joinAll([
            seq.spawn(() => seq.step('refused', () => Promise.resolve('refused'))),
            seq.spawn(() => park(seq)),
          ]),
        () => 1,
        timed,
      );
      expect(await rig.finish(run)).toMatchObject({ ok: false, error: new Error('lookup refused') });
      expect(run.execution.issued.filter((name) => name === 'DBOS.recv' || name === 'DBOS.sleep')).toEqual(
        [],
      );
    },
  );

  it('fails the run when a sched step throws, still handing a settled op’s lane its result for its glue', async () => {
    const rig = new Rig();
    let glueRan = false;
    const broken = (ops: SequencedOps): SequencedOps => ({
      ...ops,
      runStep: (fn, name) =>
        name.startsWith('sched|') ? Promise.reject(new Error('history write failed')) : ops.runStep(fn, name),
    });
    const run = rig.start(
      async (seq) =>
        seq.joinAll([
          seq.spawn(async () => {
            await seq.step('fast', () => Promise.resolve('fast'));
            glueRan = true;
            return seq.step('after', () => Promise.resolve('after'));
          }),
          seq.spawn(() => seq.step('slow', () => rig.clock.sleep(500).then(() => 'slow'))),
        ]),
      () => 1,
      broken,
    );
    const outcome = await rig.finish(run);
    expect(outcome).toMatchObject({ ok: false, error: new Error('history write failed') });
    expect(glueRan).toBe(true);
    expect(run.execution.issued).not.toContain('step|after');
  });

  it.each([
    ['rejected', undefined, { ok: false, error: new DeterminismError('boom') }, []],
    ['handed its answer', 20, { ok: true, value: { decided: true } }, [true]],
  ])(
    'ends a lane that was parking its wait when another lane failed the run: %s',
    async (_, answerAt, waitOutcome, resumed) => {
      const rig = new Rig();
      let waitEnded: Outcome | undefined;
      const resumes: boolean[] = [];
      const hooks = {
        parked: () => rig.clock.sleep(100),
        resumed: (answered: boolean) => Promise.resolve(void resumes.push(answered)),
      };
      const run = rig.start(async (seq) =>
        seq.joinAll([
          seq.spawn(() =>
            seq.step('boom', () =>
              rig.clock.sleep(50).then(() => Promise.reject(new DeterminismError('boom'))),
            ),
          ),
          seq.spawn(() =>
            seq.wait('w', eventTopicFor('w'), 60_000, hooks).then(
              (value) => (waitEnded = { ok: true, value }),
              (error: unknown) => (waitEnded = { ok: false, error }),
            ),
          ),
        ]),
      );
      if (answerAt !== undefined)
        rig.clock.at(answerAt, () => rig.wf.send({ decided: true }, eventTopicFor('w')));
      expect(await rig.finish(run)).toMatchObject({ ok: false, error: new DeterminismError('boom') });
      await rig.clock.drive();
      expect(waitEnded).toEqual(waitOutcome);
      expect(resumes).toEqual(resumed);
    },
  );

  it('fails a replay whose recorded sched names another set of ops in flight', async () => {
    const rig = new Rig();
    await rig.finish(rig.start(twoChains(rig)));
    const row = [...rig.wf.rows.values()].find((r) => r.name === 'sched|0')!;
    row.output = { ...(row.output as object), inFlight: ['step|x', 'step|y'] };
    const outcome = await rig.finish(rig.start(twoChains(rig)));
    expect(outcome).toMatchObject({ ok: false, error: expect.any(DeterminismError) });
    expect(String((outcome as { error: Error }).error.message)).toMatch(
      /recorded \[step\|x, step\|y\] in flight/,
    );
  });

  const unrecorded = (): Error =>
    Object.assign(new Error('cannot execute UPDATE in a read-only transaction'), { code: '25006' });
  it.each([
    ['a wait’s head', 'wait|w', 'runStep'],
    ['a wait’s receive', 'wait|w', 'recv'],
    ['a delay’s sleep', 'deadline|d', 'sleepms'],
    ['a step whose record write failed', 'step|s', 'runStep'],
  ] as const)(
    'fails the run on a rejection DBOS never recorded, from %s, never handing its lane a failure to branch on',
    async (_, name, call) => {
      const rig = new Rig();
      const faulty = (ops: SequencedOps): SequencedOps => ({
        ...ops,
        [call]: (...args: unknown[]) =>
          args.at(-1) === name
            ? Promise.reject(unrecorded())
            : (ops[call] as (...a: unknown[]) => unknown)(...args),
      });
      const run = rig.start(
        async (seq) => {
          try {
            if (name === 'wait|w') await seq.wait('w', eventTopicFor('w'), 5_000);
            else if (name === 'deadline|d') await seq.delay('d', 5_000);
            else await seq.step('s', () => Promise.resolve('s'));
          } catch {
            await seq.step('fallback', () => Promise.resolve('fallback'));
          }
        },
        () => 1,
        faulty,
      );
      expect(await rig.finish(run)).toMatchObject({ ok: false, error: { code: '25006' } });
      expect(run.execution.issued).not.toContain('step|fallback');
    },
  );

  it.each(['wait', 'delay'] as const)(
    'takes a %s’s op even when its park hook throws, then fails its lane with that error instead of hanging',
    async (kind) => {
      const rig = new Rig();
      const hooks = { parked: () => Promise.reject(new Error('park write failed')) };
      const run = rig.start(async (seq) => {
        try {
          if (kind === 'wait') await seq.wait('w', eventTopicFor('w'), 2_000, hooks);
          else await seq.delay('d', 70_000, hooks);
        } catch (error) {
          return (error as Error).message;
        }
        return 'no error';
      });
      expect(await rig.finish(run)).toEqual({ ok: true, value: 'park write failed' });
    },
  );

  it('hands a step body’s own failure to its lane the same way live and on replay', async () => {
    const rig = new Rig();
    const seen: unknown[] = [];
    const program = async (seq: RunSequencer): Promise<string> => {
      try {
        await seq.step('flaky', () => Promise.reject(new TypeError('the call failed')));
      } catch (error) {
        seen.push({ name: (error as Error).name, message: (error as Error).message });
      }
      return seq.step('after', () => Promise.resolve('after'));
    };
    expect(await rig.finish(rig.start(program))).toEqual({ ok: true, value: 'after' });
    expect(await rig.finish(rig.start(program))).toEqual({ ok: true, value: 'after' });
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[0]).toMatchObject({ message: 'the call failed' });
  });

  it('hands a step’s domain refusal to its lane with its status and details, the same live and on replay', async () => {
    const rig = new Rig();
    const seen: unknown[] = [];
    const program = async (seq: RunSequencer): Promise<string> => {
      try {
        await seq.step('account', () =>
          Promise.reject(new DomainError('no account to run as', 428, { code: 'none' })),
        );
      } catch (error) {
        seen.push(error);
      }
      return seq.step('after', () => Promise.resolve('after'));
    };
    expect(await rig.finish(rig.start(program))).toEqual({ ok: true, value: 'after' });
    expect(await rig.finish(rig.start(program))).toEqual({ ok: true, value: 'after' });
    for (const error of seen) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({
        message: 'no account to run as',
        status: 428,
        details: { code: 'none' },
      });
    }
    expect(seen).toHaveLength(2);
  });

  it('ends a lane whose function throws before it returns a promise as a failed lane, never an uncaught exception', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaught);
    try {
      const rig = new Rig();
      const run = rig.start(async (seq) => {
        const [ended] = await seq.joinAll([
          seq.spawn(() => {
            throw new Error('thrown at once');
          }),
        ]);
        if (!ended!.ok) throw ended!.error;
      });
      expect(await rig.finish(run)).toMatchObject({ ok: false, error: new Error('thrown at once') });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught).toEqual([]);
  });

  it('ends the run rejected even when the root lane swallows the failure', async () => {
    const rig = new Rig();
    const run = rig.start(async (seq) => {
      const offender = seq.spawn(() => seq.step('outer', () => seq.step('inner', () => Promise.resolve(1))));
      try {
        await seq.joinAll([offender]);
      } catch {
        return 'swallowed';
      }
      return 'swallowed';
    });
    expect(await rig.finish(run)).toMatchObject({ ok: false, error: expect.any(DeterminismError) });
  });
});
