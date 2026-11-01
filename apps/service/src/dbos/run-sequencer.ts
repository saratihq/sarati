import { AsyncLocalStorage } from 'node:async_hooks';

import { Logger } from '@nestjs/common';

import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';
import { DeterminismError, type Lane, type Outcome } from '../providers/durable-step';
import { PARK_DELAY_ABOVE_MS, timerTopicFor, WAKE_POLL_MS } from '../runtime/timer-wait';

/**
 * The DBOS calls a sequenced run issues; each reserves its function ids synchronously, when it is called. Every
 * call carries its unit's name, which DBOS checks for a step and ignores for a sleep or a recv.
 */
export interface SequencedOps {
  runStep<T>(fn: () => Promise<T>, name: string): Promise<T>;
  sleepms(ms: number, name: string): Promise<void>;
  recv<T>(
    topic: string,
    options: { deadlineEpochMS: number; pollingIntervalMs?: number },
    name: string,
  ): Promise<T | null>;
  now(): number;
}

/** A delay longer than this parks on a recv, which notices a cancel within one poll; a shorter one sleeps. */
export const RECV_DELAY_ABOVE_MS = 10_000;
const TURN_WARN_AFTER_MS = 30_000;

/** Glue a wait or a delay runs in its lane's turn when it parks and when it is over; neither should throw. */
export interface ParkHooks {
  parked?(deadline: number): Promise<void>;
  resumed?(answered: boolean): Promise<void>;
}

const STEP_BODY_ERROR = 'StepBodyError';

/** A step body's own failure, recorded as its outcome: the only rejection a lane may branch on. */
export class StepBodyError extends Error {
  constructor(
    message: string,
    /** A domain refusal's status, which a run start answers with. */
    readonly status?: number,
    /** A domain refusal's details. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = STEP_BODY_ERROR;
  }
}

// By name: DBOS replays a recorded error as a plain Error keeping its name, message and own fields.
function isStepBodyFailure(error: unknown): error is StepBodyError {
  return error instanceof Error && error.name === STEP_BODY_ERROR;
}

function recordedFailure(error: unknown): StepBodyError {
  return error instanceof DomainError
    ? new StepBodyError(error.message, error.status, error.details)
    : new StepBodyError(errorMessage(error));
}

// What a lane is handed for a body's recorded failure, built from the record alone so a replay hands it the same.
function deliveredFailure(error: StepBodyError): Error {
  return typeof error.status === 'number'
    ? new DomainError(error.message, error.status, error.details)
    : new StepBodyError(error.message);
}

interface LaneState extends Lane {
  outcome?: Outcome;
  endOrder?: number;
  joiners: Set<Joiner>;
}

interface Joiner {
  lane: number;
  on: LaneState[];
  resolve(ended: LaneState): void;
  reject(error: unknown): void;
}

/** One op in flight: a step, or a wait's or a delay's recv or sleep, named by its head. */
interface Unit {
  index: number;
  name: string;
  lane: number;
  /** A recv or a sleep, which has no failure of its own to deliver. */
  owned: boolean;
  outcome?: Outcome;
  settled: Deferred;
  deliver?: { resolve(value: unknown): void; reject(error: unknown): void };
}

/** A lane ready to run once granted the turn; `completed` when it carries an op's settled outcome. */
interface Wake {
  lane: number;
  completed: boolean;
  go(): void;
  fail(error: unknown): void;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Makes a durable run's op issue order depend only on its recorded history. Lane code runs one lane at a time, in a
 * turn granted first in, first out; an op is issued only by the lane holding the turn, which then gives it up; and
 * when two or more ops are in flight, the order they settle in is recorded as a `sched` step and followed on replay.
 */
export class RunSequencer {
  private readonly lanes = new AsyncLocalStorage<number>();
  private readonly runnable: Wake[] = [];
  private readonly inFlight = new Map<number, Unit>();
  private readonly logger = new Logger(RunSequencer.name);
  private readonly running = new Map<number, LaneState>();
  private readonly draining = new Set<Unit>();
  private readonly recording = new Set<Promise<unknown>>();
  private onDrain?: () => void;
  private readonly joiners = new Set<Joiner>();
  private readonly poisoned = deferred();
  private holder: number | null = null;
  private poison: { error: unknown } | null = null;
  private quiescing = false;
  private nextLane = 0;
  private nextIndex = 0;
  private nextSched = 0;
  private ended = 0;
  private watchdog?: NodeJS.Timeout;

  constructor(
    private readonly ops: SequencedOps,
    private readonly fatal: (error: unknown) => boolean = () => false,
    private readonly turnWarnAfterMs = TURN_WARN_AFTER_MS,
  ) {}

  /** The run's first lane; settles with it, or rejects with whatever poisoned the run. */
  async run<T>(root: () => Promise<T>): Promise<T> {
    const state = this.newLane();
    this.grant(state.id);
    let outcome: Outcome<T>;
    try {
      outcome = { ok: true, value: await this.lanes.run(state.id, root) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    this.running.delete(state.id);
    clearTimeout(this.watchdog);
    if (!this.poison && (this.inFlight.size > 0 || this.running.size > 0)) {
      this.fail(new DeterminismError('the run ended with lanes still running'));
    }
    if (this.poison) {
      await this.untilDrained();
      throw this.poison.error;
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** Starts `fn` as a new lane, once the turn reaches it; the caller keeps the turn. */
  spawn(fn: () => Promise<unknown>): Lane {
    this.assertTurn('spawn a lane');
    const state = this.newLane();
    this.runnable.push({
      lane: state.id,
      completed: false,
      go: () => this.startLane(state, fn),
      fail: (error) => {
        state.outcome = { ok: false, error };
        this.running.delete(state.id);
      },
    });
    return state;
  }

  /** The first of `lanes` to end — at once, keeping the turn, if one already has. */
  joinAny(lanes: readonly Lane[]): Promise<{ lane: Lane; outcome: Outcome }> {
    this.assertTurn('join a lane');
    if (lanes.length === 0) throw new Error('joinAny needs at least one lane to wait for');
    const states = lanes as readonly LaneState[];
    const done = states.filter((s) => s.outcome).sort((a, b) => a.endOrder! - b.endOrder!)[0];
    if (done) return Promise.resolve({ lane: done, outcome: done.outcome! });
    return new Promise((resolve, reject) => {
      const joiner: Joiner = {
        lane: this.holder!,
        on: [...states],
        resolve: (ended) => resolve({ lane: ended, outcome: ended.outcome! }),
        reject,
      };
      this.joiners.add(joiner);
      for (const s of states) s.joiners.add(joiner);
      this.release();
    });
  }

  /** Every one of `lanes`' outcomes, in their order, once all have ended. */
  async joinAll(lanes: readonly Lane[]): Promise<Outcome[]> {
    const states = lanes as readonly LaneState[];
    let left = states.filter((s) => !s.outcome);
    while (left.length > 0) {
      await this.joinAny(left);
      left = left.filter((s) => !s.outcome);
    }
    return states.map((s) => s.outcome!);
  }

  /** A checkpointed step, named `step|<key>`. */
  async step<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.assertTurn(`issue step|${key}`);
    const name = `step|${key}`;
    const body = async (): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        throw this.fatal(error) ? error : recordedFailure(error);
      }
    };
    const unit = this.issue(name, false, () => this.ops.runStep(body, name));
    try {
      return (await this.awaitUnit(unit)) as T;
    } catch (error) {
      throw isStepBodyFailure(error) ? deliveredFailure(error) : error;
    }
  }

  /** Waits until a deadline its head step records once, and returns that deadline. */
  async delay(key: string, ms: number, hooks: ParkHooks = {}): Promise<number> {
    const name = `deadline|${key}`;
    this.assertTurn(`issue ${name}`);
    const planned = { deadline: this.ops.now() + ms, ms };
    const head = await this.inTurn(this.ops.runStep(() => Promise.resolve(planned), name));
    if (head.ms !== ms) {
      throw this.diverged(`${name} recorded a delay of ${head.ms} ms, and the run now delays ${ms} ms`);
    }
    const unit =
      head.ms > RECV_DELAY_ABOVE_MS
        ? this.issue(name, true, () =>
            this.ops.recv(
              timerTopicFor(key),
              { deadlineEpochMS: head.deadline, pollingIntervalMs: WAKE_POLL_MS },
              name,
            ),
          )
        : this.issue(name, true, () => this.ops.sleepms(Math.max(0, head.deadline - this.ops.now()), name));
    const parks = head.ms > PARK_DELAY_ABOVE_MS;
    await this.awaitParked(unit, () => (parks ? hooks.parked?.(head.deadline) : undefined));
    if (parks) await hooks.resumed?.(false);
    return head.deadline;
  }

  /** Waits for an event on `topic` until a deadline its head step records once; null on timeout. */
  async wait<T>(key: string, topic: string, timeoutMs: number, hooks: ParkHooks = {}): Promise<T | null> {
    const name = `wait|${key}`;
    this.assertTurn(`issue ${name}`);
    const planned = this.ops.now() + timeoutMs;
    const head = await this.inTurn(
      this.ops.runStep(() => Promise.resolve({ topic, deadline: planned }), name),
    );
    if (head.topic !== topic) {
      throw this.diverged(`${name} recorded the topic "${head.topic}", and the run now waits on "${topic}"`);
    }
    const unit = this.issue(name, true, () =>
      this.ops.recv<T>(topic, { deadlineEpochMS: head.deadline }, name),
    );
    const payload = (await this.awaitParked(unit, () => hooks.parked?.(head.deadline))) as T | null;
    await hooks.resumed?.(payload !== null);
    return payload;
  }

  private newLane(): LaneState {
    const state: LaneState = { id: this.nextLane++, joiners: new Set() };
    this.running.set(state.id, state);
    return state;
  }

  private startLane(state: LaneState, fn: () => Promise<unknown>): void {
    this.lanes
      .run(state.id, async () => fn())
      .then(
        (value) => this.endLane(state, { ok: true, value }),
        (error: unknown) => this.endLane(state, { ok: false, error }),
      );
  }

  private endLane(state: LaneState, outcome: Outcome): void {
    this.running.delete(state.id);
    this.onDrain?.();
    state.outcome = outcome;
    state.endOrder = this.ended++;
    if (!outcome.ok && this.fatal(outcome.error)) this.fail(outcome.error);
    for (const joiner of state.joiners) this.wakeJoiner(joiner, state);
    if (!this.poison && this.holder === state.id) this.release();
  }

  private wakeJoiner(joiner: Joiner, ended: LaneState): void {
    if (!this.joiners.delete(joiner)) return;
    for (const s of joiner.on) s.joiners.delete(joiner);
    if (this.poison) return;
    this.runnable.push({
      lane: joiner.lane,
      completed: false,
      go: () => joiner.resolve(ended),
      fail: (error) => joiner.reject(error),
    });
  }

  private issue(name: string, owned: boolean, start: () => Promise<unknown>): Unit {
    const unit: Unit = { index: this.nextIndex++, name, lane: this.holder!, owned, settled: deferred() };
    this.inFlight.set(unit.index, unit);
    try {
      start().then(
        (value) => this.settle(unit, { ok: true, value }),
        (error: unknown) => this.settle(unit, { ok: false, error }),
      );
    } catch (error) {
      this.settle(unit, { ok: false, error });
    }
    return unit;
  }

  // Gives up the turn until the unit is delivered, which hands the turn back with its outcome.
  private awaitUnit(unit: Unit): Promise<unknown> {
    return new Promise((resolve, reject) => {
      unit.deliver = { resolve, reject };
      if (!this.poison) this.release();
      else if (unit.outcome) this.hand(unit);
      else unit.deliver.reject(this.poison.error);
    });
  }

  // The unit is taken even when the park hook throws, so no op is left in flight with no lane to take it.
  private async awaitParked(unit: Unit, park: () => Promise<void> | undefined): Promise<unknown> {
    let failed: { error: unknown } | null = null;
    try {
      await park();
    } catch (error) {
      failed = { error };
    }
    const value = await this.awaitUnit(unit);
    if (failed) throw failed.error;
    return value;
  }

  // A head step, awaited in turn: it has no failure of its own, so any rejection is one DBOS may not have recorded.
  private async inTurn<T>(op: Promise<T>): Promise<T> {
    try {
      const value = await op;
      if (this.poison) throw this.poison.error;
      return value;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private settle(unit: Unit, outcome: Outcome): void {
    if (unit.outcome) return;
    if (this.poison) {
      if (!this.draining.delete(unit)) return;
      unit.outcome = outcome;
      this.hand(unit);
      this.onDrain?.();
      return;
    }
    unit.outcome = outcome;
    unit.settled.resolve();
    // Only a step body's marked failure is surely recorded; a replay would not see any other rejection.
    if (!outcome.ok && (unit.owned || !isStepBodyFailure(outcome.error))) this.fail(outcome.error);
  }

  private deliver(unit: Unit): void {
    this.inFlight.delete(unit.index);
    this.runnable.push({
      lane: unit.lane,
      completed: true,
      go: () => this.hand(unit),
      fail: (error) => unit.deliver?.reject(error),
    });
  }

  private hand(unit: Unit): void {
    const outcome = unit.outcome!;
    if (outcome.ok) unit.deliver?.resolve(outcome.value);
    else unit.deliver?.reject(outcome.error);
  }

  private grant(lane: number): void {
    this.holder = lane;
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(
      () =>
        this.logger.warn(
          `lane ${lane} has held the run's turn for ${this.turnWarnAfterMs} ms; no other lane can run`,
        ),
      this.turnWarnAfterMs,
    ).unref();
  }

  private release(): void {
    this.holder = null;
    clearTimeout(this.watchdog);
    queueMicrotask(() => this.grantNext());
  }

  private grantNext(): void {
    if (this.poison || this.holder !== null) return;
    const next = this.runnable.shift();
    if (next) {
      this.grant(next.lane);
      next.go();
      return;
    }
    void this.quiesce();
  }

  // Nothing can run: deliver what settles next, in the order this execution saw or its history recorded.
  private async quiesce(): Promise<void> {
    if (this.quiescing) return;
    this.quiescing = true;
    try {
      while (!this.poison && this.runnable.length === 0 && this.holder === null) {
        const pending = [...this.inFlight.values()].sort((a, b) => a.index - b.index);
        if (pending.length === 0) return;
        await this.firstSettled(pending);
        if (this.poison) return;
        if (pending.length === 1) {
          this.deliver(pending[0]!);
          continue;
        }
        await this.deliverRecorded(pending);
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.quiescing = false;
    }
    if (!this.poison && this.holder === null) this.grantNext();
  }

  private async deliverRecorded(pending: Unit[]): Promise<void> {
    const names = pending.map((u) => u.name);
    const observed = pending.filter((u) => u.outcome).map((u) => u.index);
    const name = `sched|${this.nextSched++}`;
    const record = this.ops.runStep(() => Promise.resolve({ inFlight: names, settled: observed }), name);
    this.recording.add(record);
    const recorded = (): void => {
      this.recording.delete(record);
      this.onDrain?.();
    };
    record.then(recorded, recorded);
    const decision = await record;
    if (this.poison) return;
    if (decision.inFlight.join('\n') !== names.join('\n')) {
      this.fail(
        this.diverged(
          `${name} recorded [${decision.inFlight.join(', ')}] in flight; [${names.join(', ')}] are`,
        ),
      );
      return;
    }
    const chosen = decision.settled.map((index) => this.inFlight.get(index));
    if (chosen.some((unit) => !unit)) {
      this.fail(this.diverged(`${name} recorded ops settling that are not in flight`));
      return;
    }
    await Promise.race([Promise.all(chosen.map((unit) => unit!.settled.promise)), this.poisoned.promise]);
    if (!this.poison) chosen.forEach((unit) => this.deliver(unit!));
  }

  private firstSettled(pending: Unit[]): Promise<void> {
    return Promise.race([...pending.map((u) => u.settled.promise), this.poisoned.promise]);
  }

  private assertTurn(what: string): void {
    if (this.poison) throw this.poison.error;
    const lane = this.lanes.getStore();
    if (lane === undefined || lane !== this.holder) {
      throw this.diverged(
        `lane ${lane ?? 'outside the run'} tried to ${what} while lane ${this.holder} held the turn`,
      );
    }
  }

  private diverged(message: string): DeterminismError {
    const error = new DeterminismError(message);
    this.fail(error);
    return error;
  }

  // Every step body still running, every sched record, and every lane but the root, ends before a failed run does.
  private untilDrained(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.running.size > 0 || this.draining.size > 0 || this.recording.size > 0) return;
        this.onDrain = undefined;
        resolve();
      };
      this.onDrain = check;
      check();
    });
  }

  // The fault state: nothing else is issued, recorded or delivered; a lane whose op already settled still gets it.
  private fail(error: unknown): void {
    if (this.poison) return;
    this.poison = { error };
    this.holder = null;
    clearTimeout(this.watchdog);
    for (const wake of this.runnable.splice(0)) {
      if (wake.completed) wake.go();
      else wake.fail(error);
    }
    for (const unit of this.inFlight.values()) {
      if (unit.outcome) this.hand(unit);
      // A receive or a sleep may wait for days; a step body ends by itself, and its lane's writes come before the run's.
      else if (unit.owned) unit.deliver?.reject(error);
      else this.draining.add(unit);
    }
    this.inFlight.clear();
    for (const joiner of this.joiners) joiner.reject(error);
    this.joiners.clear();
    this.poisoned.resolve();
  }
}
