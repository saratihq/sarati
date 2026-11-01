import { PARK_DELAY_ABOVE_MS, timerTopicFor, WAKE_POLL_MS } from '../runtime/timer-wait';

/** A concurrent branch of a run, from {@link DurableStep.spawn}. */
export interface Lane {
  readonly id: number;
}

/** How a lane ended: with its value, or with what it threw. */
export type Outcome<T = unknown> = { ok: true; value: T } | { ok: false; error: unknown };

/** A durable pause of `ms`: `name` is its op's, `stepKey` the step's it belongs to. */
export interface Pause {
  name: string;
  stepKey: string;
  ms: number;
}

/** A durable wait for an event on `topic`, received on `deliveryTopic` when the run routes it by its step. */
export interface EventWait {
  name: string;
  stepKey: string;
  topic: string;
  deliveryTopic: string | null;
  timeoutMs: number;
}

/** Where a wait or a delay parks, as the run's history keeps it. */
export interface Park {
  topic: string;
  deliveryTopic: string | null;
  durationMs: number;
  /** The deadline its substrate armed it to, which history records over any earlier one; null when it cannot know it. */
  due: Date | null;
}

/** A parked delay's timer, armed: `due` is null when the substrate cannot know the deadline it fires at. */
export interface ParkedTimer {
  due: Date | null;
  fired: Promise<unknown>;
}

/** The run-history writes around a wait or a delay that parks; neither should throw. */
export interface ParkHooks {
  /** Once it parks: resolves to when history keeps it due, or null when no history keeps it. */
  parked(park: Park): Promise<Date | null>;
  /** Once it is over: `answered` when it took an event. */
  resumed(answered: boolean): Promise<void>;
}

/**
 * Thin seam over the durable-execution substrate: the interpreter runs every side effect and pause through THIS
 * contract, never DBOS directly, and the DBOS impl checkpoints each so a crash resumes instead of re-firing.
 */
export interface DurableStep {
  /** A checkpointed step — its result is memoized on resume. */
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Run a plan's top-level walk as the run's first lane; settles once every lane it started has ended. */
  root<T>(fn: () => Promise<T>): Promise<T>;
  /** Start `fn` as a concurrent branch of the run: the one way to start one. */
  spawn(fn: () => Promise<unknown>): Lane;
  /** The first of `lanes` to end. */
  joinAny(lanes: readonly Lane[]): Promise<{ lane: Lane; outcome: Outcome }>;
  /** Every one of `lanes`' outcomes, in their order, once all have ended. */
  joinAll(lanes: readonly Lane[]): Promise<Outcome[]>;
  /** Pause durably; one that parks resolves to when it was due, and one that does not, or whose due nothing kept, to null. */
  delay(pause: Pause, hooks: ParkHooks): Promise<Date | null>;
  /** Suspend durably until an event arrives, or the wait times out (→ null). */
  waitForEvent<T = unknown>(wait: EventWait, hooks: ParkHooks): Promise<T | null>;
  /** Wait `ms` inside a step's body, unrecorded; a cancel this substrate can see mid-step cuts it short. */
  waitInStep(ms: number): Promise<void>;
  /** Throw this run's own cancel if the substrate already knows of one, mid-step and without a checkpoint. */
  throwIfCancelled(): void;
  /** The cancel the run's row shows, made this substrate's own, so it unwinds the run as a cancel wherever it is seen. */
  cancelSeenOnRow(): Error;
  /** Whether `err` is this substrate unwinding its own run's cancel — never a step failure. */
  isCancellation(err: unknown): boolean;
  /** Whether `err` must end the run whatever would absorb it: its cancel, or its history disagreeing with the run. */
  isFatal(err: unknown): boolean;
}

/** Thrown at the next step boundary of an in-process run that was cancelled. */
export class RunCancelledError extends Error {
  constructor() {
    super('Run was cancelled');
    this.name = 'RunCancelledError';
  }
}

/** A run about to issue ops in an order its recorded history does not hold; fatal, and never absorbed. */
export class DeterminismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeterminismError';
  }
}

class PlainLanes {
  private next = 0;
  private readonly ends = new Map<number, Promise<Outcome>>();
  /** Each lane's outcome once it has ended, in the order they ended. */
  private readonly ended = new Map<number, Outcome>();

  spawn(fn: () => Promise<unknown>): Lane {
    const lane = { id: this.next++ };
    const end = (async () => fn())().then(
      (value): Outcome => ({ ok: true, value }),
      (error: unknown): Outcome => ({ ok: false, error }),
    );
    void end.then((outcome) => this.ended.set(lane.id, outcome));
    this.ends.set(lane.id, end);
    return lane;
  }

  async joinAny(lanes: readonly Lane[]): Promise<{ lane: Lane; outcome: Outcome }> {
    if (lanes.length === 0) throw new Error('joinAny needs at least one lane to wait for');
    const first = await Promise.race(
      lanes.map((lane) => this.ends.get(lane.id)!.then((outcome) => ({ lane, outcome }))),
    );
    // A failure that ended along with it comes first, so the run stops before starting what a success unblocks.
    const failed = [...this.ended].find(
      ([id, outcome]) => !outcome.ok && lanes.some((lane) => lane.id === id),
    );
    const taken = failed ? { lane: lanes.find((lane) => lane.id === failed[0])!, outcome: failed[1] } : first;
    this.ends.delete(taken.lane.id);
    this.ended.delete(taken.lane.id);
    return taken;
  }

  async joinAll(lanes: readonly Lane[]): Promise<Outcome[]> {
    const outcomes = await Promise.all(lanes.map((lane) => this.ends.get(lane.id)!));
    for (const lane of lanes) {
      this.ends.delete(lane.id);
      this.ended.delete(lane.id);
    }
    return outcomes;
  }
}

/** Every substrate but the sequenced one: plain-promise lanes, and each delay and wait over one sleep and one receive. */
export abstract class PlainDurableStep implements DurableStep {
  private readonly lanes = new PlainLanes();

  abstract run<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Pause durably for `ms`. */
  abstract sleep(name: string, ms: number): Promise<void>;
  /** Suspend durably until an event is delivered to `topic`, or `timeoutMs` elapses (→ null). */
  abstract receive<T = unknown>(name: string, topic: string, timeoutMs: number): Promise<T | null>;
  /** Arm a parked delay's timer on `topic`, which nobody can send to. */
  protected abstract armTimer(pause: Pause, topic: string): ParkedTimer;
  abstract waitInStep(ms: number): Promise<void>;
  abstract throwIfCancelled(): void;
  abstract cancelSeenOnRow(): Error;
  abstract isCancellation(err: unknown): boolean;
  abstract isFatal(err: unknown): boolean;

  root<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  spawn(fn: () => Promise<unknown>): Lane {
    return this.lanes.spawn(fn);
  }

  joinAny(lanes: readonly Lane[]): Promise<{ lane: Lane; outcome: Outcome }> {
    return this.lanes.joinAny(lanes);
  }

  joinAll(lanes: readonly Lane[]): Promise<Outcome[]> {
    return this.lanes.joinAll(lanes);
  }

  async delay(pause: Pause, hooks: ParkHooks): Promise<Date | null> {
    if (pause.ms <= PARK_DELAY_ABOVE_MS) {
      await this.sleep(pause.name, pause.ms);
      return null;
    }
    // A long delay parks, out of the in-flight cap.
    const topic = timerTopicFor(pause.stepKey);
    const timer = this.armTimer(pause, topic);
    // Handled at once: a cancel can reject it while the park below is still being written.
    timer.fired.catch(() => undefined);
    const kept = await hooks.parked({ topic, deliveryTopic: null, durationMs: pause.ms, due: timer.due });
    try {
      await this.parkedOn(timer.fired);
    } finally {
      await hooks.resumed(false);
    }
    return timer.due ?? kept;
  }

  async waitForEvent<T = unknown>(wait: EventWait, hooks: ParkHooks): Promise<T | null> {
    const pending = this.receive<T>(wait.name, wait.deliveryTopic ?? wait.topic, wait.timeoutMs);
    pending.catch(() => undefined);
    await hooks.parked({
      topic: wait.topic,
      deliveryTopic: wait.deliveryTopic,
      durationMs: wait.timeoutMs,
      due: null,
    });
    let answered = false;
    try {
      const payload = await this.parkedOn(pending);
      answered = payload !== null;
      return payload ?? null;
    } finally {
      await hooks.resumed(answered);
    }
  }

  /** A lane's wait on a park whose history is written: nothing it does goes on until the park ends. */
  protected parkedOn<T>(wait: Promise<T>): Promise<T> {
    return wait;
  }
}

/** Non-durable local/test substrate — in-process timer + in-memory bus. NOT safe for production side effects. */
export class PassThroughDurableStep extends PlainDurableStep {
  private readonly waiters = new Map<string, (value: unknown) => void>();
  private readonly onCancel = new Set<() => void>();
  private readonly nested = new Set<PassThroughDurableStep>();
  private cancelled = false;
  private liveLanes = 0;
  private waitingLanes = 0;

  /** Whether the run is parked: it has lanes, and each waits on a park, on other lanes, or on a run nested in it that is parked. */
  parked(): boolean {
    const parkedNests = [...this.nested].filter((run) => run.parked()).length;
    return this.liveLanes > 0 && this.waitingLanes + parkedNests === this.liveLanes;
  }

  override root<T>(fn: () => Promise<T>): Promise<T> {
    return this.lane(fn);
  }

  override spawn(fn: () => Promise<unknown>): Lane {
    return super.spawn(() => this.lane(fn));
  }

  override joinAny(lanes: readonly Lane[]): Promise<{ lane: Lane; outcome: Outcome }> {
    return this.waiting(super.joinAny(lanes));
  }

  override joinAll(lanes: readonly Lane[]): Promise<Outcome[]> {
    return this.waiting(super.joinAll(lanes));
  }

  protected override parkedOn<T>(wait: Promise<T>): Promise<T> {
    return this.waiting(wait);
  }

  override async run<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    if (this.cancelled) throw new RunCancelledError();
    return fn();
  }

  override sleep(_name: string, ms: number): Promise<void> {
    return this.waitInStep(ms);
  }

  override receive<T = unknown>(_name: string, topic: string, timeoutMs: number): Promise<T | null> {
    return this.pause<T | null>((wake) => {
      const disarm = timerAt(Date.now() + timeoutMs, () => wake(null));
      const receiver = (value: unknown): void => wake(value as T);
      this.waiters.set(topic, receiver);
      return () => {
        disarm();
        if (this.waiters.get(topic) === receiver) this.waiters.delete(topic);
      };
    });
  }

  protected override armTimer(pause: Pause, _topic: string): ParkedTimer {
    const due = Date.now() + pause.ms;
    return { due: new Date(due), fired: this.pause<void>((wake) => timerAt(due, () => wake())) };
  }

  override waitInStep(ms: number): Promise<void> {
    return this.pause<void>((wake) => {
      const timer = setTimeout(wake, ms);
      return () => clearTimeout(timer);
    });
  }

  override isCancellation(err: unknown): boolean {
    return this.cancelled && err instanceof RunCancelledError;
  }

  override isFatal(err: unknown): boolean {
    return this.isCancellation(err) || err instanceof DeterminismError;
  }

  override throwIfCancelled(): void {
    if (this.cancelled) throw new RunCancelledError();
  }

  override cancelSeenOnRow(): Error {
    this.cancel();
    return new RunCancelledError();
  }

  /** Deliver an event to a pending wait on `topic`. Returns false if none is waiting. */
  deliver(topic: string, payload: unknown): boolean {
    const waiter = this.waiters.get(topic);
    if (!waiter) return false;
    waiter(payload);
    return true;
  }

  /** Cancel the run: a pending pause ends now, and every later step throws {@link RunCancelledError}. */
  cancel(): void {
    this.cancelled = true;
    for (const hook of [...this.onCancel]) hook();
  }

  /** Run a run nested inside this one's current step on a substrate this run's cancel reaches too. */
  async nest<T>(run: (durable: PassThroughDurableStep) => Promise<T>): Promise<T> {
    const nested = new PassThroughDurableStep();
    const cascade = (): void => nested.cancel();
    if (this.cancelled) nested.cancel();
    this.onCancel.add(cascade);
    this.nested.add(nested);
    try {
      return await run(nested);
    } finally {
      this.onCancel.delete(cascade);
      this.nested.delete(nested);
    }
  }

  private async lane<T>(fn: () => Promise<T>): Promise<T> {
    this.liveLanes++;
    try {
      return await fn();
    } finally {
      this.liveLanes--;
    }
  }

  private async waiting<T>(wait: Promise<T>): Promise<T> {
    this.waitingLanes++;
    try {
      return await wait;
    } finally {
      this.waitingLanes--;
    }
  }

  // `arm` starts the pause and returns how to disarm it; a cancel rejects it at once.
  private pause<T>(arm: (wake: (value: T) => void) => () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.cancelled) {
        reject(new RunCancelledError());
        return;
      }
      const settle = (): void => {
        disarm();
        this.onCancel.delete(abort);
      };
      const abort = (): void => {
        settle();
        reject(new RunCancelledError());
      };
      const disarm = arm((value) => {
        settle();
        resolve(value);
      });
      this.onCancel.add(abort);
    });
  }
}

// Fired by the wall clock `due` is on, read at least once a poll, never by a timer alone, which can run ahead of it or behind it; returns how to disarm it.
function timerAt(due: number, fire: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    timer = setTimeout(() => (Date.now() < due ? arm() : fire()), Math.min(due - Date.now(), WAKE_POLL_MS));
  };
  arm();
  return () => clearTimeout(timer);
}
