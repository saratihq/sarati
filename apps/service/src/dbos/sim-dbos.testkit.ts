import { Error as DbosErrors } from '@dbos-inc/dbos-sdk';

import { DbosDurableStep } from './dbos-durable-step';
import type { SequencedOps } from './run-sequencer';

/**
 * Test support, not in the production bundle: a model of DBOS 4.23.6's per-workflow op log, held to the real SDK by
 * `test/sim-dbos-conformance.e2e-spec.ts`. Every wait runs on a {@link VirtualClock}, so a seed replays exactly.
 */

export const SLEEP = 'DBOS.sleep';
export const RECV = 'DBOS.recv';

// DBOS's own defaults: a recv with no timeout waits 60 s and polls every 10 s.
const DEFAULT_RECV_TIMEOUT_S = 60;
const DEFAULT_POLL_MS = 10_000;

/** `DBOS.recv`'s second argument: seconds, or its `RecvOptions`. */
export type RecvTimeout =
  number | { timeoutSeconds?: number; deadlineEpochMS?: number; pollingIntervalMs?: number };

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
// What DBOS's superjson round trip keeps of a value: undefined, NaN, Infinity and a Date among it.
const clone = <T>(value: T): T => structuredClone(value);

/** A clock whose timers fire in time order once everything already runnable has run; time moves only between timers. */
export class VirtualClock {
  private time = 0;
  private order = 0;
  private readonly timers: Array<{ at: number; order: number; fire: () => void }> = [];

  now(): number {
    return this.time;
  }

  at(when: number, fire: () => void): void {
    this.timers.push({ at: Math.max(when, this.time), order: this.order++, fire });
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.at(this.time + Math.max(0, ms), resolve));
  }

  /** Fires timers in order until none is left or `done` holds once the runnable work has settled. */
  async drive(done: () => boolean = () => false): Promise<void> {
    for (let fired = 0; fired < 1_000_000; fired++) {
      await settle();
      if (done()) return;
      const next = this.take();
      if (!next) return;
      this.time = next.at;
      next.fire();
    }
    throw new Error('virtual clock: over a million timers — a run is spinning');
  }

  private take(): { at: number; fire: () => void } | undefined {
    let best = -1;
    this.timers.forEach((t, i) => {
      const b = this.timers[best];
      if (!b || t.at < b.at || (t.at === b.at && t.order < b.order)) best = i;
    });
    return best < 0 ? undefined : this.timers.splice(best, 1)[0];
  }
}

/** One recorded op, as `dbos.operation_outputs` holds it, plus the caller's intent DBOS never stores. */
export interface OpRow {
  id: number;
  name: string;
  output?: unknown;
  /** As DBOS records an error: its name, its message and its own fields. */
  error?: { name: string; message: string } & Record<string, unknown>;
  /** Who issued the op — what DBOS would have to compare to catch a swap it can't see. */
  intent?: string;
  recordedAt: number;
}

/** A replayed slot DBOS let through although a different caller recorded it. */
export interface SilentPairing {
  id: number;
  name: string;
  recorded?: string;
  replayed?: string;
}

/** What a replay got wrong that DBOS did or did not notice. */
export interface SimStats {
  /** `DBOSUnexpectedStepError`s raised. */
  loud: number;
  /** Replayed sleep and recv slots handed to a caller that did not record them. */
  silent: SilentPairing[];
  /** Steps whose result was already recorded at another slot, executed again. */
  reruns: string[];
}

/** One durable workflow: its op log and its notifications, across every execution of it. */
export class SimWorkflow {
  readonly rows = new Map<number, OpRow>();
  readonly stats: SimStats = { loud: 0, silent: [], reruns: [] };
  /** `DBOS.cancelWorkflow`: every later lookup, recv poll and sleep end throws {@link DbosErrors.DBOSWorkflowCancelledError}. */
  cancelled = false;
  private readonly notifications: Array<{
    topic: string;
    message: unknown;
    key?: string;
    consumed: boolean;
  }> = [];
  private readonly arrivals = new Set<() => void>();
  private readonly recordedNames = new Set<string>();

  constructor(
    readonly id: string,
    readonly clock: VirtualClock,
  ) {}

  /** `DBOS.send`: a repeat of `key` is dropped, as `ON CONFLICT (message_uuid) DO NOTHING` drops it. */
  send(message: unknown, topic: string, key?: string): void {
    if (key !== undefined && this.notifications.some((n) => n.key === key)) return;
    this.notifications.push({ topic, message: clone(message), key, consumed: false });
    for (const wake of [...this.arrivals]) wake();
  }

  /** `DBOS.forkWorkflow`: a new workflow holding this one's rows below `startStep`. */
  fork(id: string, startStep: number): SimWorkflow {
    const forked = new SimWorkflow(id, this.clock);
    for (const row of this.rows.values()) if (row.id < startStep) forked.record({ ...row });
    return forked;
  }

  record(row: OpRow): void {
    this.rows.set(row.id, row);
    if (!row.name.startsWith('DBOS.')) this.recordedNames.add(row.name);
  }

  hasRecorded(name: string): boolean {
    return this.recordedNames.has(name);
  }

  /** Resolves once a message on `topic` is waiting or the clock reaches `finish`. */
  arrival(topic: string, finish: number): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (!this.waiting(topic) && this.clock.now() < finish) return;
        this.arrivals.delete(check);
        resolve();
      };
      this.arrivals.add(check);
      this.clock.at(finish, check);
      check();
    });
  }

  hasWaiting(topic: string): boolean {
    return this.waiting(topic);
  }

  consume(topic: string): unknown {
    const next = this.notifications.find((n) => n.topic === topic && !n.consumed);
    if (!next) return null;
    next.consumed = true;
    return next.message;
  }

  private waiting(topic: string): boolean {
    return this.notifications.some((n) => n.topic === topic && !n.consumed);
  }
}

/** Reserved ids with no row by design: a `sleepms(<=0)`, or a recv timeout already due. */
export type RowlessSlot = { id: number; why: 'zero sleep' | 'timeout already due' | 'fatal at lookup' };

/** A write DBOS attempted and the database refused outside every retried class: the op rejects and records no row. */
export class SimDbFault extends Error {
  readonly code = '55P03';

  constructor() {
    super('lock not available');
    this.name = 'SimDbFault';
  }
}

/** The op a write belongs to, for choosing which write to refuse. */
export interface FaultSlot {
  kind: 'step' | 'sleep' | 'recv';
  name: string;
  topic?: string;
}

/**
 * One execution of a workflow body: its own function-id counter, taken synchronously at call time as DBOS does, and
 * dead after {@link crash} — a dead execution's ops never settle and record nothing.
 */
export class SimExecution {
  private counter = 0;
  private live = 0;
  private liveSteps = 0;
  private alive = true;
  readonly rowless: RowlessSlot[] = [];
  /** The name each id this execution reserved was taken for, in id order: its op-to-id map. */
  readonly issued: string[] = [];

  constructor(
    private readonly wf: SimWorkflow,
    private readonly dbLatency: () => number,
    private readonly refuses: (slot: FaultSlot) => boolean = () => false,
  ) {}

  get reserved(): number {
    return this.counter;
  }

  /** Ops this execution issued that have not settled yet. */
  get inFlight(): number {
    return this.live;
  }

  /** Of those, the steps: a body that may still be running, and whose row is still to be written. */
  get stepsInFlight(): number {
    return this.liveSteps;
  }

  crash(): void {
    this.alive = false;
  }

  /** A step whose lookup raises `error`, as DBOS raises a fatal one: it takes its id, records nothing and never runs. */
  failStepAtLookup(name: string, error: Error): Promise<never> {
    const id = this.reserve(name);
    this.rowless.push({ id, why: 'fatal at lookup' });
    return this.track(async () => {
      await this.lookup();
      throw error;
    });
  }

  runStep<T>(fn: () => Promise<T>, name: string, intent: string = name): Promise<T> {
    const id = this.reserve(name);
    this.liveSteps += 1;
    const step = this.track(async () => {
      await this.lookup();
      const row = this.wf.rows.get(id);
      if (row) {
        this.checkSlot(id, name, row);
        if (row.error) throw Object.assign(new Error(row.error.message), clone(row.error));
        return clone(row.output as T);
      }
      if (this.wf.hasRecorded(name)) this.wf.stats.reruns.push(name);
      let output: T;
      try {
        output = await fn();
      } catch (err) {
        await this.write();
        this.refuse({ kind: 'step', name });
        const e = err instanceof Error ? err : new Error(String(err));
        this.wf.record({
          id,
          name,
          error: { ...clone({ ...e }), name: e.name, message: e.message },
          intent,
          recordedAt: this.now(),
        });
        throw err;
      }
      await this.write();
      this.refuse({ kind: 'step', name });
      this.wf.record({ id, name, output: clone(output), intent, recordedAt: this.now() });
      return clone(output);
    });
    const settled = (): void => {
      this.liveSteps -= 1;
    };
    step.then(settled, settled);
    return step;
  }

  sleepms(ms: number, intent?: string): Promise<void> {
    const id = this.reserve(SLEEP);
    if (ms <= 0) {
      this.rowless.push({ id, why: 'zero sleep' });
      return Promise.resolve();
    }
    return this.track(async () => {
      const end = await this.durableSleep(id, ms, intent);
      await this.wf.clock.sleep(end - this.now());
      if (!this.alive) return never<void>();
      this.throwIfCancelled();
    });
  }

  recv<T>(topic: string, timeout?: RecvTimeout, intent?: string): Promise<T | null> {
    const id = this.reserve(RECV);
    const timeoutId = this.reserve(SLEEP);
    return this.track(async () => {
      await this.lookup();
      const row = this.wf.rows.get(id);
      if (row) {
        this.checkSlot(id, RECV, row, intent);
        return clone((row.output ?? null) as T | null);
      }
      const timeoutMs = this.timeoutMs(timeout);
      let finish = this.now() + timeoutMs;
      if (timeoutMs > 0)
        finish = await this.durableSleep(timeoutId, timeoutMs, intent && `${intent}#timeout`);
      else this.rowless.push({ id: timeoutId, why: 'timeout already due' });
      const poll =
        typeof timeout === 'object' ? (timeout.pollingIntervalMs ?? DEFAULT_POLL_MS) : DEFAULT_POLL_MS;
      for (;;) {
        this.throwIfCancelled();
        if (this.wf.hasWaiting(topic) || this.now() >= finish) break;
        await this.wf.arrival(topic, Math.min(finish, this.now() + poll));
        if (!this.alive) return never<T | null>();
      }
      this.throwIfCancelled();
      await this.write();
      this.refuse({ kind: 'recv', name: RECV, topic });
      const message = this.wf.consume(topic);
      this.wf.record({ id, name: RECV, output: message, intent, recordedAt: this.now() });
      return clone(message as T | null);
    });
  }

  private track<T>(op: () => Promise<T>): Promise<T> {
    this.live += 1;
    const running = op();
    const settled = (): void => {
      this.live -= 1;
    };
    running.then(settled, settled);
    return running;
  }

  private reserve(name: string): number {
    this.issued.push(name);
    return this.counter++;
  }

  private timeoutMs(timeout: RecvTimeout | undefined): number {
    if (typeof timeout === 'number') return timeout * 1000;
    if (timeout?.deadlineEpochMS !== undefined) return Math.max(0, timeout.deadlineEpochMS - this.now());
    return (timeout?.timeoutSeconds ?? DEFAULT_RECV_TIMEOUT_S) * 1000;
  }

  private async durableSleep(id: number, ms: number, intent?: string): Promise<number> {
    const end = this.now() + ms;
    await this.lookup();
    const row = this.wf.rows.get(id);
    if (row) {
      this.checkSlot(id, SLEEP, row, intent);
      return row.output as number;
    }
    this.refuse({ kind: 'sleep', name: SLEEP });
    this.wf.record({ id, name: SLEEP, output: end, intent, recordedAt: this.now() });
    return end;
  }

  // DBOS checks only the op's name; a different caller replaying the slot passes, and is counted.
  private checkSlot(id: number, name: string, row: OpRow, intent?: string): void {
    if (row.name !== name) {
      this.wf.stats.loud += 1;
      throw new DbosErrors.DBOSUnexpectedStepError(this.wf.id, id, name, row.name);
    }
    if (intent !== undefined && row.intent !== undefined && row.intent !== intent) {
      this.wf.stats.silent.push({ id, name, recorded: row.intent, replayed: intent });
    }
  }

  // A read of the op log, which DBOS refuses once the workflow is cancelled.
  private async lookup(): Promise<void> {
    await this.write();
    this.throwIfCancelled();
  }

  private async write(): Promise<void> {
    await this.wf.clock.sleep(this.dbLatency());
    if (!this.alive) await never<void>();
  }

  private refuse(slot: FaultSlot): void {
    if (this.refuses(slot)) throw new SimDbFault();
  }

  private throwIfCancelled(): void {
    if (this.wf.cancelled) throw new DbosErrors.DBOSWorkflowCancelledError(this.wf.id);
  }

  private now(): number {
    return this.wf.clock.now();
  }
}

/** Today's `DbosDurableStep` over the model: the same calls, each passing its name as the intent. */
export class SimDbosDurableStep extends DbosDurableStep {
  constructor(
    protected readonly execution: SimExecution,
    private readonly clock: VirtualClock,
  ) {
    super();
  }

  override run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.execution.runStep(fn, name);
  }

  override sleep(name: string, ms: number): Promise<void> {
    return this.execution.sleepms(ms, name);
  }

  override receive<T = unknown>(name: string, topic: string, timeoutMs: number): Promise<T | null> {
    return this.execution.recv<T>(topic, timeoutMs / 1000, name);
  }

  override waitInStep(ms: number): Promise<void> {
    return this.clock.sleep(ms);
  }
}

/** The sequencer's DBOS calls over the model, each passing its unit's name as the intent. */
export function simOps(execution: SimExecution, clock: VirtualClock): SequencedOps {
  return {
    runStep: (fn, name) => execution.runStep(fn, name),
    sleepms: (ms, name) => execution.sleepms(ms, name),
    recv: (topic, options, name) => execution.recv(topic, options, name),
    now: () => clock.now(),
  };
}
