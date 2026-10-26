import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { Client } from 'pg';

import { StepBodyError } from '../src/dbos/run-sequencer';
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
  | { op: 'step'; name: string; parked?: true; fails?: true | 'marked' | 'refused' }
  | { op: 'sleep'; ms: number }
  | { op: 'recv'; topic: string; timeout: number | 'due'; poll?: number };
type Script = Array<Op | Op[]>;

/** A sleep also says whether it woke before its own length — what a replayed deadline does. */
type OpResult =
  | { value: unknown; early?: boolean }
  | { error: { name: string; message: string; status?: unknown; details?: unknown } };

/** A wait a recv armed between its polls. */
interface Wait {
  /** How long it asked to wait. */
  ms: number;
  /** Whether it waited all of that, rather than being woken. */
  ranOut: boolean;
}

/** An op's result the moment it settled: its place in the script, and when it was issued and settled after the start. */
interface Settled {
  index: number;
  result: OpResult;
  began: number;
  at: number;
}

// Parked step bodies: each says it has started, then waits until the scenario opens it.
class Gates {
  private readonly started = new Set<string>();
  private readonly gates = new Map<string, { open: () => void; opened: Promise<void> }>();
  private allOpen = false;

  enter(name: string): Promise<void> {
    this.started.add(name);
    return this.gate(name).opened;
  }

  entered(name: string): boolean {
    return this.started.has(name);
  }

  open(name: string): void {
    this.gate(name).open();
  }

  openAll(): void {
    this.allOpen = true;
    for (const gate of this.gates.values()) gate.open();
  }

  private gate(name: string): { open: () => void; opened: Promise<void> } {
    let gate = this.gates.get(name);
    if (!gate) {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      gate = { open, opened };
      this.gates.set(name, gate);
      if (this.allOpen) open();
    }
    return gate;
  }
}

/** What a backend gives a script to call. */
interface OpPort {
  step(name: string, fn: () => Promise<unknown>): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  recv(topic: string, timeout: number | 'due', poll?: number): Promise<unknown>;
  now(): number;
}

/** A row as both backends normalise it: a sleep's deadline is a time, so only its presence is compared. */
interface Row {
  id: number;
  name: string;
  value?: unknown;
  error?: string;
}

/** One started workflow, driven the same way on either backend: every wait is for a state, never for a time. */
interface Run {
  /** Until the parked step `name` has started. */
  entered(name: string): Promise<void>;
  /** Lets the parked step `name` finish. */
  open(name: string): void;
  /** Until each of `ids` has a row. */
  recordedAll(...ids: number[]): Promise<void>;
  /** Until `count` ops have settled — readable after a cancel, when the workflow has no result to give. */
  settled(count: number): Promise<Settled[]>;
  /** Until the run's recvs have armed `count` waits between their polls; each one, in order. */
  waits(count?: number): Promise<Wait[]>;
  /** Whether a message on `topic` is still there, unconsumed. */
  unread(topic: string): Promise<boolean>;
  send(topic: string, message: unknown): Promise<void>;
  recorded(): Promise<number[]>;
  result(): Promise<OpResult[]>;
  rows(): Promise<Row[]>;
  cancel(): Promise<void>;
  /** Opens the parked step `gate` and cancels the run once the sleep `id` after it has begun and before it can end. */
  cancelInSleep(gate: string, id: number): Promise<void>;
  /** Opens the parked step `gate` and cancels the run once the recv after it has checked for a cancel and before it waits. */
  cancelInPoll(gate: string): Promise<void>;
}

interface Backend {
  start(id: string, script: Script): Run;
  /** Replays `id`'s rows below `startStep` as the new workflow `as`. */
  fork(id: string, startStep: number, script: Script, as?: string): Run;
  /** How often each step body ran, across every run of this backend. */
  invocations: Map<string, number>;
}

// A recv timeout, in seconds, and a replayed sleep's length, that no scenario here waits out.
const LONG_S = 600;
const LONG_MS = LONG_S * 1000;

function runScript(
  script: Script,
  port: OpPort,
  gates: Gates,
  invocations: Map<string, number>,
  settled: Settled[],
): Promise<OpResult[]> {
  const begun = port.now();
  let issued = 0;
  const issue = (op: Op): Promise<OpResult> => {
    const index = issued++;
    const began = port.now() - begun;
    return outcome(op).then((result) => {
      settled.push({ index, result, began, at: port.now() - begun });
      return result;
    });
  };
  const outcome = (op: Op): Promise<OpResult> => {
    let call: Promise<unknown>;
    if (op.op === 'step') {
      call = port.step(op.name, async () => {
        invocations.set(op.name, (invocations.get(op.name) ?? 0) + 1);
        if (op.parked) await gates.enter(op.name);
        if (op.fails === 'marked') throw new StepBodyError(`boom in ${op.name}`);
        if (op.fails === 'refused')
          throw new StepBodyError(`refused in ${op.name}`, 428, { code: 'no_account' });
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
      (err: Error & { status?: unknown; details?: unknown }) => ({
        error: {
          name: err.name,
          message: err.message,
          ...(err.status === undefined ? {} : { status: err.status, details: err.details }),
        },
      }),
    );
  };
  return (async () => {
    const results: OpResult[] = [];
    for (const entry of script)
      results.push(...(await Promise.all((Array.isArray(entry) ? entry : [entry]).map(issue))));
    return results;
  })();
}

// A failure bound only: a state a scenario waits for arrives in milliseconds or never.
const STATE_MS = 10_000;

const neverReached = (what: string): Error => new Error(`real DBOS never reached ${what}`);

async function until(what: string, done: () => boolean | Promise<boolean>): Promise<void> {
  const giveUp = Date.now() + STATE_MS;
  while (!(await done())) {
    if (Date.now() >= giveUp) throw neverReached(what);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function within<T>(what: string, pending: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(neverReached(what)), STATE_MS);
  });
  try {
    return await Promise.race([pending, gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}

const realInvocations = new Map<string, number>();
const scripts = new Map<string, Script>();
const realProgress = new Map<string, Settled[]>();
const realGates = new Map<string, Gates>();
const realWaits = new Map<string, Wait[]>();
const startedReal = new Set<string>();
const liveReal = new Set<string>();
const drainedReal = new Set<string>();
const sleepEnders = new Map<string, Set<() => void>>();

function entryOf<T>(map: Map<string, T>, id: string, make: () => T): T {
  let entry = map.get(id);
  if (entry === undefined) {
    entry = make();
    map.set(id, entry);
  }
  return entry;
}

const gatesOf = (id: string): Gates => entryOf(realGates, id, () => new Gates());
const waitsOf = (id: string): Wait[] => entryOf(realWaits, id, () => []);

type Sleep = { promise: Promise<void>; cancel: () => void };
type PollSleep = (ms: number) => Sleep;

// A workflow's DBOS sleep, as one a drain of the workflow can end by rejecting it.
function endable(id: string, sleep: Sleep): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const end = (): void => {
      reject(new Error(`${id} was drained`));
      sleep.cancel();
    };
    if (drainedReal.has(id)) {
      end();
      return;
    }
    const enders = entryOf(sleepEnders, id, () => new Set<() => void>());
    enders.add(end);
    void sleep.promise.then(() => {
      enders.delete(end);
      resolve();
    });
  });
}

// DBOS's own sleeps, called through: each wait a recv arms between its polls is watched, and every sleep in a workflow can be ended.
function watchDbosSleeps(): () => void {
  const utils = jest.requireActual<{ cancellableSleep: PollSleep; sleepms: (ms: number) => Promise<void> }>(
    join(dirname(require.resolve('@dbos-inc/dbos-sdk')), 'utils.js'),
  );
  const { cancellableSleep, sleepms } = utils;
  const polls = jest.spyOn(utils, 'cancellableSleep').mockImplementation((ms) => {
    const id = DBOS.workflowID;
    const slept = cancellableSleep(ms);
    if (id === undefined) return slept;
    const wait: Wait = { ms, ranOut: false };
    waitsOf(id).push(wait);
    let woken = false;
    void slept.promise.then(() => {
      wait.ranOut = !woken;
    });
    const cancel = (): void => {
      woken = true;
      slept.cancel();
    };
    return { promise: endable(id, { promise: slept.promise, cancel }), cancel };
  });
  const sleeps = jest.spyOn(utils, 'sleepms').mockImplementation((ms) => {
    const id = DBOS.workflowID;
    return id === undefined ? sleepms(ms) : endable(id, cancellableSleep(ms));
  });
  return () => {
    polls.mockRestore();
    sleeps.mockRestore();
  };
}

// Ends the runs a failed scenario left waiting: a cancel alone opens no parked step, and a recv or a sleep sees it only once its wait is over.
async function drainReal(): Promise<void> {
  const ids = [...startedReal];
  startedReal.clear();
  for (const id of ids) {
    drainedReal.add(id);
    gatesOf(id).openAll();
    for (const end of sleepEnders.get(id) ?? []) end();
    sleepEnders.delete(id);
  }
  await Promise.all(ids.map((id) => DBOS.cancelWorkflow(id)));
  await until(`the end of ${ids.join(', ')} once drained`, () => ids.every((id) => !liveReal.has(id)));
}

const scriptWorkflow = DBOS.registerWorkflow(
  async (): Promise<OpResult[]> => {
    const id = DBOS.workflowID ?? '';
    liveReal.add(id);
    try {
      return await runScript(
        scripts.get(id) ?? [],
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
          now: () => Date.now(),
        },
        gatesOf(id),
        realInvocations,
        realProgress.get(id) ?? [],
      );
    } finally {
      liveReal.delete(id);
    }
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

function realBackend(db: Client, url: string): Backend {
  const recorded = async (id: string): Promise<number[]> =>
    (
      await db.query<{ function_id: number }>(
        `SELECT function_id FROM dbos.operation_outputs WHERE workflow_uuid = $1 ORDER BY function_id`,
        [id],
      )
    ).rows.map((r) => r.function_id);

  // Opens `gate` with `hold` taken, and cancels once the run's next statement on `table` waits behind it.
  const cancelBehind = async (
    id: string,
    gate: string,
    table: string,
    hold: string,
    params: unknown[] = [],
  ): Promise<void> => {
    const holder = new Client({ connectionString: url, idle_in_transaction_session_timeout: 2 * STATE_MS });
    await holder.connect();
    try {
      const { pid } = (await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!;
      await holder.query('BEGIN');
      await holder.query(hold, params);
      gatesOf(id).open(gate);
      await until(
        `a statement on ${table} waiting behind the hold`,
        async () =>
          (
            await db.query(
              `SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE $2`,
              [pid, `%${table}%`],
            )
          ).rows.length > 0,
      );
      await DBOS.cancelWorkflow(id);
    } finally {
      await holder.end();
    }
  };

  const run = (id: string, start: () => Promise<{ getResult: () => Promise<OpResult[]> }>): Run => {
    const progress: Settled[] = [];
    realProgress.set(id, progress);
    startedReal.add(id);
    const gates = gatesOf(id);
    const handle = start();
    return {
      entered: (name) => until(`${name} started`, () => gates.entered(name)),
      open: (name) => gates.open(name),
      recordedAll: (...ids) =>
        until(`rows ${ids.join(', ')}`, async () => {
          const rows = await recorded(id);
          return ids.every((i) => rows.includes(i));
        }),
      settled: async (count) => {
        await until(`${count} ops settled`, () => progress.length >= count);
        return progress;
      },
      waits: async (count = 0) => {
        await until(`${count} recv waits armed`, () => waitsOf(id).length >= count);
        return [...waitsOf(id)];
      },
      unread: async (topic) =>
        (
          await db.query(
            `SELECT 1 FROM dbos.notifications WHERE destination_uuid = $1 AND topic = $2 AND NOT consumed`,
            [id, topic],
          )
        ).rows.length > 0,
      cancel: () => DBOS.cancelWorkflow(id),
      // The sleep's record waits on an uncommitted row at its id: past its own cancel check, its deadline taken, not yet asleep.
      cancelInSleep: (gate, sleepId) =>
        cancelBehind(
          id,
          gate,
          'operation_outputs',
          `INSERT INTO dbos.operation_outputs (workflow_uuid, function_id, function_name, started_at_epoch_ms, completed_at_epoch_ms)
           VALUES ($1, $2, 'held', 0, 0)`,
          [id, sleepId],
        ),
      // The recv's read of its notifications waits on the table's lock: past its cancel check, not yet waiting.
      cancelInPoll: (gate) =>
        cancelBehind(id, gate, 'notifications', 'LOCK TABLE dbos.notifications IN ACCESS EXCLUSIVE MODE'),
      send: (topic, message) => DBOS.send(id, message, topic),
      recorded: () => recorded(id),
      result: () =>
        within(
          'the script ended',
          handle.then((started) => started.getResult()),
        ),
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
  // Fires the model's timers only until `done` holds, so virtual time never runs past the state a scenario waits for.
  const reach = async (done: () => boolean, what: string): Promise<void> => {
    await clock.drive(done);
    if (!done()) throw new Error(`SimDBOS ran out of timers before ${what}`);
  };
  const run = (wf: SimWorkflow, script: Script): Run => {
    const execution = new SimExecution(wf, () => 1, refusedHere);
    const gates = new Gates();
    const progress: Settled[] = [];
    const waits: Wait[] = [];
    // The model's wait between a recv's polls, watched as the real backend watches DBOS's own.
    const arrival = wf.arrival.bind(wf);
    wf.arrival = (topic, finish) => {
      const wait: Wait = { ms: finish - clock.now(), ranOut: false };
      waits.push(wait);
      return arrival(topic, finish).then(() => {
        wait.ranOut = clock.now() >= finish;
      });
    };
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
        now: () => clock.now(),
      },
      gates,
      invocations,
      progress,
    ).then((results) => {
      settled = results;
    });
    const cancel = (): Promise<void> => {
      wf.cancelled = true;
      return Promise.resolve();
    };
    return {
      entered: (name) => reach(() => gates.entered(name), `${name} started`),
      open: (name) => gates.open(name),
      recordedAll: (...ids) => reach(() => ids.every((i) => wf.rows.has(i)), `rows ${ids.join(', ')}`),
      settled: async (count) => {
        await reach(() => progress.length >= count, `${count} ops settled`);
        return progress;
      },
      waits: async (count = 0) => {
        await reach(() => waits.length >= count, `${count} recv waits armed`);
        return [...waits];
      },
      unread: (topic) => Promise.resolve(wf.hasWaiting(topic)),
      cancel,
      cancelInSleep: async (gate, sleepId) => {
        gates.open(gate);
        await reach(() => wf.rows.has(sleepId), `sleep ${sleepId} began`);
        await cancel();
      },
      cancelInPoll: async (gate) => {
        gates.open(gate);
        await reach(() => waits.length > 0, 'the recv began to wait');
        await cancel();
      },
      send: (topic, message) => {
        wf.send(message, topic);
        return Promise.resolve();
      },
      recorded: () => Promise.resolve([...wf.rows.keys()].sort((a, b) => a - b)),
      result: async () => {
        await reach(() => settled !== undefined, 'the script ended');
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
  let restoreSleeps: () => void;

  beforeAll(async () => {
    restoreSleeps = watchDbosSleeps();
    dbos = await launchThrowawayDbos('conformance');
    db = new Client({ connectionString: dbos.url });
    await db.connect();
    real = realBackend(db, dbos.url);
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

  afterEach(drainReal);

  afterAll(async () => {
    restoreSleeps();
    await db.end();
    await dbos.shutdown();
  }, 60_000);

  const id = (): string => `conf-${randomBytes(4).toString('hex')}`;
  const cancelled = { error: { name: 'Error', message: expect.stringMatching(/has been cancelled$/) } };
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
          { op: 'step', name: 'slow', parked: true },
          { op: 'step', name: 'fast' },
          { op: 'recv', topic: 'answer', timeout: LONG_S },
          { op: 'sleep', ms: 600 },
        ],
      ]);
      await run.recordedAll(1, 3, 4);
      const early = await run.recorded();
      run.open('slow');
      await run.recordedAll(0);
      const later = await run.recorded();
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
        { op: 'step', name: 'gate', parked: true },
        { op: 'recv', topic: 'waiting', timeout: 'due' },
        { op: 'recv', topic: 'empty', timeout: 'due' },
        { op: 'step', name: 'end' },
      ]);
      await run.entered('gate');
      await run.send('waiting', { early: true });
      run.open('gate');
      return { result: await run.result(), rows: await run.rows() };
    });
    expect(seen.rows).toEqual([
      { id: 2, name: 'gate', value: { from: 'gate' } },
      { id: 3, name: 'DBOS.recv', value: { early: true } },
      { id: 5, name: 'DBOS.recv', value: null },
      { id: 7, name: 'end', value: { from: 'end' } },
    ]);
  }, 30_000);

  it('replays a step body’s marked failure with its name, so a replay sees it as the same failure', async () => {
    const seen = await both(async (backend, name) => {
      const script: Script = [{ op: 'step', name: `${name}-marked`, fails: 'marked' }];
      return {
        first: await backend.start(name, script).result(),
        replay: await backend.fork(name, 1, script).result(),
      };
    });
    expect(seen.first).toEqual([
      { error: { name: 'StepBodyError', message: expect.stringMatching(/^boom in /) } },
    ]);
    expect(seen.replay).toEqual(seen.first);
  }, 30_000);

  it('replays a step body’s recorded refusal with its status and details', async () => {
    const seen = await both(async (backend, name) => {
      const script: Script = [{ op: 'step', name: `${name}-refused`, fails: 'refused' }];
      return {
        first: await backend.start(name, script).result(),
        replay: await backend.fork(name, 1, script).result(),
      };
    });
    expect(seen.replay).toEqual([
      {
        error: {
          name: 'StepBodyError',
          message: expect.stringMatching(/^refused in /),
          status: 428,
          details: { code: 'no_account' },
        },
      },
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
        { op: 'recv', topic: 'first', timeout: LONG_S },
        { op: 'sleep', ms: 150 },
      ]);
      await run.recordedAll(1);
      await run.send('first', { meant: 'first' });
      await run.result();
      return backend
        .fork(name, 3, [
          { op: 'recv', topic: 'second', timeout: LONG_S },
          { op: 'sleep', ms: LONG_MS },
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
          { op: 'sleep', ms: LONG_MS },
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
        { op: 'recv', topic: REFUSED_TOPIC, timeout: LONG_S },
        { op: 'step', name: REFUSED_STEP },
        { op: 'step', name: `${name}-after` },
      ]);
      await run.recordedAll(1);
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

  it('stops a parked recv at its first poll after a cancel, one poll interval on, and refuses every op after it', async () => {
    const seen = await both(async (backend, name) => {
      const run = backend.start(name, [
        { op: 'step', name: 'gate', parked: true },
        { op: 'recv', topic: 'never', timeout: LONG_S, poll: 200 },
        { op: 'step', name: `${name}-after` },
      ]);
      await run.entered('gate');
      await run.cancelInPoll('gate');
      const settled = await run.settled(3);
      return {
        results: [...settled].sort((a, b) => a.index - b.index).map(({ result }) => result),
        waits: await run.waits(),
        ran: backend.invocations.get(`${name}-after`) ?? 0,
        rows: await run.rows(),
      };
    });
    expect(seen).toEqual({
      results: [{ value: { from: 'gate' } }, cancelled, cancelled],
      waits: [{ ms: 200, ranOut: true }],
      ran: 0,
      rows: [
        { id: 0, name: 'gate', value: { from: 'gate' } },
        { id: 2, name: 'DBOS.sleep' },
      ],
    });
  }, 30_000);

  it('checks for a cancel before it consumes, so a cancelled recv woken by a message throws and leaves it unread', async () => {
    const seen = await both(async (backend, name) => {
      const run = backend.start(name, [{ op: 'recv', topic: 'answer', timeout: LONG_S, poll: LONG_MS }]);
      await run.waits(1);
      await run.cancel();
      await run.send('answer', { late: true });
      const [recv] = await run.settled(1);
      return {
        result: recv!.result,
        waits: (await run.waits()).length,
        unread: await run.unread('answer'),
        rows: await run.rows(),
      };
    });
    expect(seen).toEqual({
      result: cancelled,
      waits: 1,
      unread: true,
      rows: [{ id: 1, name: 'DBOS.sleep' }],
    });
  }, 30_000);

  it('lets a sleep run to its end once cancelled, then throws', async () => {
    const seen = await both(async (backend, name) => {
      const run = backend.start(name, [
        { op: 'step', name: 'gate', parked: true },
        { op: 'sleep', ms: 700 },
      ]);
      await run.entered('gate');
      await run.cancelInSleep('gate', 1);
      const [gate, sleep] = [...(await run.settled(2))].sort((a, b) => a.index - b.index);
      return {
        gate: gate!.result,
        sleep: sleep!.result,
        ranItsLength: sleep!.at - sleep!.began >= 700,
        rows: await run.rows(),
      };
    });
    expect(seen).toEqual({
      gate: { value: { from: 'gate' } },
      sleep: cancelled,
      ranItsLength: true,
      rows: [
        { id: 0, name: 'gate', value: { from: 'gate' } },
        { id: 1, name: 'DBOS.sleep' },
      ],
    });
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
