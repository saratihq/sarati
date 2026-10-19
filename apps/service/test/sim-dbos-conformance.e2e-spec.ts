import { randomBytes } from 'node:crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { Client } from 'pg';

import {
  SimExecution,
  SimWorkflow,
  VirtualClock,
  type FaultSlot,
  type OpRow,
} from '../src/dbos/sim-dbos.testkit';
import { launchThrowawayDbos, type ThrowawayDbos } from './support/dbos-system-db';

/** One scripted op; a group of them is issued together, in order, before any of them is awaited. */
type Op =
  | { op: 'step'; name: string; ms?: number; fails?: true }
  | { op: 'sleep'; ms: number }
  | { op: 'recv'; topic: string; timeout: number | 'due'; poll?: number };
type Script = Array<Op | Op[]>;

/** A sleep also says whether it woke before its own length — what a replayed deadline does. */
type OpResult = { value: unknown; early?: boolean } | { error: { name: string; message: string } };

/** An op's result the moment it settled: its place in the script, and how long after the start. */
interface Settled {
  index: number;
  result: OpResult;
  at: number;
}

/** What a backend gives a script to call, and how it lets time pass inside a step. */
interface OpPort {
  step(name: string, fn: () => Promise<unknown>): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  recv(topic: string, timeout: number | 'due', poll?: number): Promise<unknown>;
  pause(ms: number): Promise<void>;
  now(): number;
}

/** A row as both backends normalise it: a sleep's deadline is a time, so only its presence is compared. */
interface Row {
  id: number;
  name: string;
  value?: unknown;
  error?: string;
}

/** One started workflow, driven the same way on either backend. */
interface Run {
  /** Lets time pass until `ms` after the run started. */
  until(ms: number): Promise<void>;
  send(topic: string, message: unknown): Promise<void>;
  recorded(): Promise<number[]>;
  result(): Promise<OpResult[]>;
  rows(): Promise<Row[]>;
  cancel(): Promise<void>;
  /** Every op settled so far — readable after a cancel, when the workflow has no result to give. */
  progress(): Settled[];
}

interface Backend {
  start(id: string, script: Script): Run;
  /** Replays `id`'s rows below `startStep` as the new workflow `as`. */
  fork(id: string, startStep: number, script: Script, as?: string): Run;
  /** How often each step body ran, across every run of this backend. */
  invocations: Map<string, number>;
}

function runScript(
  script: Script,
  port: OpPort,
  invocations: Map<string, number>,
  settled: Settled[],
): Promise<OpResult[]> {
  const begun = port.now();
  let issued = 0;
  const issue = (op: Op): Promise<OpResult> => {
    const index = issued++;
    return outcome(op).then((result) => {
      settled.push({ index, result, at: port.now() - begun });
      return result;
    });
  };
  const outcome = (op: Op): Promise<OpResult> => {
    let call: Promise<unknown>;
    if (op.op === 'step') {
      call = port.step(op.name, async () => {
        invocations.set(op.name, (invocations.get(op.name) ?? 0) + 1);
        await port.pause(op.ms ?? 0);
        if (op.fails) throw new Error(`boom in ${op.name}`);
        return { from: op.name };
      });
    } else if (op.op === 'sleep') {
      const began = port.now();
      return port.sleep(op.ms).then(
        () => ({ value: null, early: port.now() - began + 100 < op.ms }),
        (err: Error) => ({ error: { name: err.name, message: err.message } }),
      );
    } else {
      call = port.recv(op.topic, op.timeout, op.poll);
    }
    return call.then(
      (value) => ({ value: value ?? null }),
      (err: Error) => ({ error: { name: err.name, message: err.message } }),
    );
  };
  return (async () => {
    const results: OpResult[] = [];
    for (const entry of script)
      results.push(...(await Promise.all((Array.isArray(entry) ? entry : [entry]).map(issue))));
    return results;
  })();
}

const realInvocations = new Map<string, number>();
const scripts = new Map<string, Script>();
const realProgress = new Map<string, Settled[]>();

const scriptWorkflow = DBOS.registerWorkflow(
  async (): Promise<OpResult[]> => {
    const script = scripts.get(DBOS.workflowID ?? '') ?? [];
    return runScript(
      script,
      {
        step: (name, fn) => DBOS.runStep(fn, { name }),
        sleep: (ms) => DBOS.sleepms(ms),
        recv: (topic, timeout, poll) =>
          DBOS.recv(
            topic,
            timeout === 'due'
              ? { deadlineEpochMS: Date.now() - 1 }
              : { timeoutSeconds: timeout, pollingIntervalMs: poll },
          ),
        pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
      },
      realInvocations,
      realProgress.get(DBOS.workflowID ?? '') ?? [],
    );
  },
  { name: 'conformance.script' },
);

// DBOS stores outputs as superjson, `{ __dbos_serializer: 'superjson', json }`.
function unwrap(stored: unknown): unknown {
  const wrapped = stored as { __dbos_serializer?: string; json?: unknown } | null;
  return wrapped?.__dbos_serializer === 'superjson' ? wrapped.json : stored;
}

function normalise(row: { id: number; name: string; output?: unknown; error?: string }): Row {
  if (row.name === 'DBOS.sleep') return { id: row.id, name: row.name };
  return {
    id: row.id,
    name: row.name,
    ...(row.error !== undefined ? { error: row.error } : { value: row.output ?? null }),
  };
}

function realBackend(db: Client): Backend {
  const begun = new Map<string, number>();
  const run = (id: string, start: () => Promise<{ getResult: () => Promise<OpResult[]> }>): Run => {
    begun.set(id, Date.now());
    realProgress.set(id, []);
    const handle = start();
    return {
      cancel: () => DBOS.cancelWorkflow(id),
      progress: () => realProgress.get(id)!,
      until: async (ms) => {
        const wait = begun.get(id)! + ms - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      },
      send: (topic, message) => DBOS.send(id, message, topic),
      recorded: async () =>
        (
          await db.query<{ function_id: number }>(
            `SELECT function_id FROM dbos.operation_outputs WHERE workflow_uuid = $1 ORDER BY function_id`,
            [id],
          )
        ).rows.map((r) => r.function_id),
      result: async () => (await handle).getResult(),
      rows: async () =>
        (
          await db.query<{
            function_id: number;
            function_name: string;
            output: string | null;
            error: string | null;
          }>(
            `SELECT function_id, function_name, output, error FROM dbos.operation_outputs
              WHERE workflow_uuid = $1 ORDER BY function_id`,
            [id],
          )
        ).rows.map((r) =>
          normalise({
            id: r.function_id,
            name: r.function_name,
            output: r.output === null ? null : unwrap(JSON.parse(r.output) as unknown),
            error: r.error === null ? undefined : (JSON.parse(r.error) as { message: string }).message,
          }),
        ),
    };
  };
  return {
    invocations: realInvocations,
    start: (id, script) => {
      scripts.set(id, script);
      return run(id, () => DBOS.startWorkflow(scriptWorkflow, { workflowID: id })());
    },
    fork: (id, startStep, script, as = `${id}:replay`) => {
      const forked = as;
      scripts.set(forked, script);
      return run(forked, () => DBOS.forkWorkflow<OpResult[]>(id, startStep, { newWorkflowID: forked }));
    },
  };
}

// What the real backend's triggers refuse: the consume of a message on this topic, and the record of this step.
const REFUSED_TOPIC = 'refused';
const REFUSED_STEP = 'refused-step';
const refusedHere = (slot: FaultSlot): boolean => slot.topic === REFUSED_TOPIC || slot.name === REFUSED_STEP;

function simBackend(): Backend {
  const clock = new VirtualClock();
  const workflows = new Map<string, SimWorkflow>();
  const invocations = new Map<string, number>();
  const run = (wf: SimWorkflow, script: Script): Run => {
    const begun = clock.now();
    const execution = new SimExecution(wf, () => 1, refusedHere);
    const progress: Settled[] = [];
    let settled: OpResult[] | undefined;
    void runScript(
      script,
      {
        step: (name, fn) => execution.runStep(fn, name),
        sleep: (ms) => execution.sleepms(ms),
        recv: (topic, timeout, poll) =>
          execution.recv(
            topic,
            timeout === 'due'
              ? { deadlineEpochMS: clock.now() - 1 }
              : { timeoutSeconds: timeout, pollingIntervalMs: poll },
          ),
        pause: (ms) => clock.sleep(ms),
        now: () => clock.now(),
      },
      invocations,
      progress,
    ).then((results) => {
      settled = results;
    });
    return {
      cancel: () => {
        wf.cancelled = true;
        return Promise.resolve();
      },
      progress: () => progress,
      until: async (ms) => {
        let reached = false;
        clock.at(begun + ms, () => {
          reached = true;
        });
        await clock.drive(() => reached);
      },
      send: (topic, message) => {
        wf.send(message, topic);
        return Promise.resolve();
      },
      recorded: () => Promise.resolve([...wf.rows.keys()].sort((a, b) => a - b)),
      result: async () => {
        await clock.drive(() => settled !== undefined);
        return settled!;
      },
      rows: () =>
        Promise.resolve(
          [...wf.rows.values()]
            .sort((a, b) => a.id - b.id)
            .map((r: OpRow) =>
              normalise({ id: r.id, name: r.name, output: r.output, error: r.error?.message }),
            ),
        ),
    };
  };
  return {
    invocations,
    start: (id, script) => {
      const wf = new SimWorkflow(id, clock);
      workflows.set(id, wf);
      return run(wf, script);
    },
    fork: (id, startStep, script, as = `${id}:replay`) => {
      const forked = workflows.get(id)!.fork(as, startStep);
      workflows.set(forked.id, forked);
      return run(forked, script);
    },
  };
}

// A step mismatch, as DBOS words it; its error is named plain `Error`, so only `instanceof` can tell it apart.
function mismatch(result: OpResult): string {
  if (!('error' in result)) return 'no error';
  const said = / (step \d+), function (.+) was recorded when (.+) was expected/.exec(result.error.message);
  return said && result.error.name === 'Error'
    ? `${said[1]}: function ${said[2]} was recorded when ${said[3]} was expected`
    : result.error.message;
}

/** Real DBOS 4.23.6 against SimDBOS on the same scripted op sequences: the fuzz is only as true as this. */
describe('SimDBOS conforms to DBOS 4.23.6 (e2e, real DBOS, throwaway system DB)', () => {
  let dbos: ThrowawayDbos;
  let db: Client;
  let real: Backend;

  beforeAll(async () => {
    dbos = await launchThrowawayDbos('conformance');
    db = new Client({ connectionString: dbos.url });
    await db.connect();
    real = realBackend(db);
    await db.query(`CREATE FUNCTION dbos.refuse_consume() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.topic = '${REFUSED_TOPIC}' THEN RAISE EXCEPTION 'lock not available' USING ERRCODE = '55P03'; END IF;
        RETURN NEW;
      END $$`);
    await db.query(`CREATE FUNCTION dbos.refuse_record() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.function_name = '${REFUSED_STEP}' THEN RAISE EXCEPTION 'lock not available' USING ERRCODE = '55P03'; END IF;
        RETURN NEW;
      END $$`);
    await db.query(
      `CREATE TRIGGER refuse_consume BEFORE UPDATE ON dbos.notifications FOR EACH ROW EXECUTE FUNCTION dbos.refuse_consume()`,
    );
    await db.query(
      `CREATE TRIGGER refuse_record BEFORE INSERT ON dbos.operation_outputs FOR EACH ROW EXECUTE FUNCTION dbos.refuse_record()`,
    );
  }, 60_000);

  afterAll(async () => {
    await db.end();
    await dbos.shutdown();
  }, 60_000);

  const id = (): string => `conf-${randomBytes(4).toString('hex')}`;
  const both = async <T>(scenario: (backend: Backend, id: string) => Promise<T>): Promise<T> => {
    const name = id();
    const [onReal, onSim] = [await scenario(real, name), await scenario(simBackend(), name)];
    expect(onSim).toEqual(onReal);
    return onReal;
  };

  it('takes every id at call time, two for a recv, and records each op when DBOS does', async () => {
    const seen = await both(async (backend, name) => {
      const run = backend.start(name, [
        [
          { op: 'step', name: 'slow', ms: 300 },
          { op: 'step', name: 'fast', ms: 20 },
          { op: 'recv', topic: 'answer', timeout: 1.5 },
          { op: 'sleep', ms: 600 },
        ],
      ]);
      await run.until(150);
      const early = await run.recorded();
      await run.until(450);
      const later = await run.recorded();
      await run.until(800);
      await run.send('answer', { decided: 'yes' });
      return { early, later, result: await run.result(), rows: await run.rows() };
    });
    expect(seen).toEqual({
      early: [1, 3, 4],
      later: [0, 1, 3, 4],
      result: [
        { value: { from: 'slow' } },
        { value: { from: 'fast' } },
        { value: { decided: 'yes' } },
        { value: null, early: false },
      ],
      rows: [
        { id: 0, name: 'slow', value: { from: 'slow' } },
        { id: 1, name: 'fast', value: { from: 'fast' } },
        { id: 2, name: 'DBOS.recv', value: { decided: 'yes' } },
        { id: 3, name: 'DBOS.sleep' },
        { id: 4, name: 'DBOS.sleep' },
      ],
    });
  }, 30_000);

  it('gives a sleep of zero or less an id and no row, and lets a recv already due take a waiting message', async () => {
    const seen = await both(async (backend, name) => {
      const run = backend.start(name, [
        { op: 'sleep', ms: 0 },
        { op: 'sleep', ms: -5 },
        { op: 'step', name: 'gate', ms: 250 },
        { op: 'recv', topic: 'waiting', timeout: 'due' },
        { op: 'recv', topic: 'empty', timeout: 'due' },
        { op: 'step', name: 'end' },
      ]);
      await run.until(100);
      await run.send('waiting', { early: true });
      return { result: await run.result(), rows: await run.rows() };
    });
    expect(seen.rows).toEqual([
      { id: 2, name: 'gate', value: { from: 'gate' } },
      { id: 3, name: 'DBOS.recv', value: { early: true } },
      { id: 5, name: 'DBOS.recv', value: null },
      { id: 7, name: 'end', value: { from: 'end' } },
    ]);
  }, 30_000);

  it('records a step error and rethrows it, and a replay rethrows it without running the step again', async () => {
    const seen = await both(async (backend, name) => {
      const script: Script = [
        { op: 'step', name: `${name}-boom`, fails: true },
        { op: 'step', name: `${name}-after` },
      ];
      const first = await backend.start(name, script).result();
      const replay = await backend.fork(name, 2, script).result();
      return {
        first,
        replay,
        runs: [backend.invocations.get(`${name}-boom`), backend.invocations.get(`${name}-after`)],
      };
    });
    expect(seen.replay).toEqual(seen.first);
    expect(seen.runs).toEqual([1, 1]);
  }, 30_000);

  it('fails a replay loudly when another step reaches a recorded step slot', async () => {
    const seen = await both(async (backend, name) => {
      await backend
        .start(name, [
          { op: 'step', name: 'a' },
          { op: 'step', name: 'b' },
        ])
        .result();
      return backend
        .fork(name, 2, [
          { op: 'step', name: 'b' },
          { op: 'step', name: 'a' },
        ])
        .result();
    });
    expect(seen.map(mismatch)).toEqual([
      'step 0: function a was recorded when b was expected',
      'step 1: function b was recorded when a was expected',
    ]);
  }, 30_000);

  it('lets a replay take a recv on another topic and a sleep of another length without a word', async () => {
    const seen = await both(async (backend, name) => {
      const run = backend.start(name, [
        { op: 'recv', topic: 'first', timeout: 1 },
        { op: 'sleep', ms: 150 },
      ]);
      await run.until(100);
      await run.send('first', { meant: 'first' });
      await run.result();
      return backend
        .fork(name, 3, [
          { op: 'recv', topic: 'second', timeout: 1 },
          { op: 'sleep', ms: 5_000 },
        ])
        .result();
    });
    expect(seen).toEqual([{ value: { meant: 'first' } }, { value: null, early: true }]);
  }, 30_000);

  it("lets a zero sleep slip a sleep onto a recv's timeout slot, and fails a step or a recv at another kind's slot", async () => {
    const seen = await both(async (backend, name) => {
      await backend
        .start(name, [
          { op: 'recv', topic: 'none', timeout: 0.2 },
          { op: 'step', name: 'b' },
        ])
        .result();
      const slipped = await backend
        .fork(name, 3, [
          { op: 'sleep', ms: 0 },
          { op: 'sleep', ms: 5_000 },
          { op: 'step', name: 'b' },
        ])
        .result();
      const stepAtRecv = await backend.fork(name, 3, [{ op: 'step', name: 'x' }], `${name}:step`).result();
      await backend.start(`${name}-s`, [{ op: 'step', name: 'a' }]).result();
      const recvAtStep = await backend
        .fork(`${name}-s`, 1, [{ op: 'recv', topic: 'none', timeout: 0.2 }])
        .result();
      return { slipped, stepAtRecv, recvAtStep };
    });
    expect(seen.slipped).toEqual([
      { value: null, early: false },
      { value: null, early: true },
      { value: { from: 'b' } },
    ]);
    expect([...seen.stepAtRecv, ...seen.recvAtStep].map(mismatch)).toEqual([
      'step 0: function DBOS.recv was recorded when x was expected',
      'step 0: function a was recorded when DBOS.recv was expected',
    ]);
  }, 30_000);

  it('rejects a recv whose consume the database refuses and a step whose record it refuses, recording neither', async () => {
    const seen = await both(async (backend, name) => {
      const run = backend.start(name, [
        { op: 'recv', topic: REFUSED_TOPIC, timeout: 3 },
        { op: 'step', name: REFUSED_STEP },
        { op: 'step', name: `${name}-after` },
      ]);
      await run.until(100);
      await run.send(REFUSED_TOPIC, { d: 'kept' });
      const results = await run.result();
      return {
        results: results.map((r) => ('error' in r ? { rejected: r.error.message } : r)),
        rows: await run.rows(),
        bodyRuns: backend.invocations.get(REFUSED_STEP),
      };
    });
    expect(seen).toEqual({
      results: [{ rejected: 'lock not available' }, { rejected: 'lock not available' }, expect.anything()],
      rows: [
        { id: 1, name: 'DBOS.sleep' },
        expect.objectContaining({
          id: 3,
          value: expect.objectContaining({ from: expect.stringMatching(/-after$/) }),
        }),
      ],
      bodyRuns: 1,
    });
  }, 30_000);

  it('stops a parked recv within its poll interval once cancelled, and refuses every op after it', async () => {
    const seen = await both(async (backend, name) => {
      const run = backend.start(name, [
        { op: 'recv', topic: 'never', timeout: 5, poll: 200 },
        { op: 'step', name: `${name}-after` },
      ]);
      await run.until(100);
      await run.cancel();
      await run.until(700);
      return {
        settled: run
          .progress()
          .map(({ index, result, at }) => ({ index, result, withinPoll: at < 100 + 200 + 150 })),
        ran: backend.invocations.get(`${name}-after`) ?? 0,
      };
    });
    expect(
      seen.settled.map((s) => [s.index, s.withinPoll, 'error' in s.result && s.result.error.message]),
    ).toEqual([
      [0, true, expect.stringMatching(/has been cancelled$/)],
      [1, true, expect.stringMatching(/has been cancelled$/)],
    ]);
    expect(seen.ran).toBe(0);
  }, 30_000);

  it('lets a sleep run to its end once cancelled, then throws', async () => {
    const seen = await both(async (backend, name) => {
      const run = backend.start(name, [{ op: 'sleep', ms: 700 }]);
      await run.until(100);
      await run.cancel();
      await run.until(1_000);
      return run.progress().map(({ result, at }) => ({ result, atItsEnd: at >= 650 }));
    });
    expect(seen).toEqual([{ result: { error: expect.objectContaining({ name: 'Error' }) }, atItsEnd: true }]);
  }, 30_000);

  it('runs a step again on replay when its slot was never recorded', async () => {
    const seen = await both(async (backend, name) => {
      const script: Script = [
        { op: 'step', name: `${name}-kept` },
        { op: 'step', name: `${name}-lost` },
      ];
      await backend.start(name, script).result();
      await backend.fork(name, 1, script).result();
      return [backend.invocations.get(`${name}-kept`), backend.invocations.get(`${name}-lost`)];
    });
    expect(seen).toEqual([1, 2]);
  }, 30_000);
});
