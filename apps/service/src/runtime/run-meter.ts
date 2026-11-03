import {
  activeTimeLimitReached,
  isRunLimitReached,
  RUN_ACTIVE_SECONDS,
  RUN_STEPS,
  stepLimitReached,
  type RunLimits,
} from '../entitlements/run-limits';
import type { DurableStep, EventWait, Lane, Outcome, ParkHooks, Pause } from '../providers/durable-step';
import type { RunRecorder } from './run-recorder.service';

/** A run tree's one budget: each op takes a step from it, or is refused by the limit it reached, worded for a run another one `called` or a top-level one. */
export interface RunMeter {
  charge(called: boolean): Promise<void>;
  /** A wait of the tree's is about to end, still parked; never throws. */
  resuming(): Promise<void>;
}

/** Charges the tree's root row, so the count outlives a crash, and refuses an op past its steps or its root's time in flight. */
export class DurableRunMeter implements RunMeter {
  constructor(
    private readonly recorder: RunRecorder,
    private readonly rootRunId: string,
    private readonly limits: RunLimits,
  ) {}

  async charge(called: boolean): Promise<void> {
    const steps = this.limits[RUN_STEPS];
    const seconds = this.limits[RUN_ACTIVE_SECONDS];
    if (steps === null && seconds === null) return;
    const refused = await this.recorder.chargeRunStep(this.rootRunId, steps, seconds);
    if (refused === 'steps') throw stepLimitReached(steps!, called);
    if (refused === 'active_seconds') throw activeTimeLimitReached(seconds!, called);
  }

  async resuming(): Promise<void> {
    if (this.limits[RUN_ACTIVE_SECONDS] !== null) await this.recorder.runTreeResuming(this.rootRunId);
  }
}

/** Counts a run that keeps no history, a single-step or agent test, in memory: its steps only. */
export class InMemoryRunMeter implements RunMeter {
  private used = 0;

  constructor(private readonly maxSteps: number | null) {}

  charge(called: boolean): Promise<void> {
    if (this.maxSteps !== null && this.used >= this.maxSteps) {
      return Promise.reject(stepLimitReached(this.maxSteps, called));
    }
    this.used += 1;
    return Promise.resolve();
  }

  resuming(): Promise<void> {
    return Promise.resolve();
  }
}

/** A run's substrate with every op charged inside its own step body, and a limit's refusal fatal by its recorded code. */
export class MeteredDurableStep implements DurableStep {
  constructor(
    private readonly inner: DurableStep,
    private readonly meter: RunMeter,
    private readonly called: boolean,
  ) {}

  run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.inner.run(name, async () => {
      await this.meter.charge(this.called);
      return fn();
    });
  }

  root<T>(fn: () => Promise<T>): Promise<T> {
    return this.inner.root(fn);
  }

  spawn(fn: () => Promise<unknown>): Lane {
    return this.inner.spawn(fn);
  }

  joinAny(lanes: readonly Lane[]): Promise<{ lane: Lane; outcome: Outcome }> {
    return this.inner.joinAny(lanes);
  }

  joinAll(lanes: readonly Lane[]): Promise<Outcome[]> {
    return this.inner.joinAll(lanes);
  }

  delay(pause: Pause, hooks: ParkHooks): Promise<Date | null> {
    return this.inner.delay(pause, this.metered(hooks));
  }

  waitForEvent<T = unknown>(wait: EventWait, hooks: ParkHooks): Promise<T | null> {
    return this.inner.waitForEvent<T>(wait, this.metered(hooks));
  }

  // Told before the wait's history unparks it, so the tree reads as it was while the wait still held.
  private metered(hooks: ParkHooks): ParkHooks {
    return {
      parked: (park) => hooks.parked(park),
      resumed: async (answered) => {
        await this.meter.resuming();
        await hooks.resumed(answered);
      },
    };
  }

  waitInStep(ms: number): Promise<void> {
    return this.inner.waitInStep(ms);
  }

  throwIfCancelled(): void {
    this.inner.throwIfCancelled();
  }

  cancelSeenOnRow(): Error {
    return this.inner.cancelSeenOnRow();
  }

  isCancellation(err: unknown): boolean {
    return this.inner.isCancellation(err);
  }

  isFatal(err: unknown): boolean {
    return isRunLimitReached(err) || this.inner.isFatal(err);
  }
}
