import { DomainError } from '../common/domain-error';

/** Every op a run tree issues, its called runs' included. */
export const RUN_STEPS = 'run.steps';
/** forEach items plus while rounds, summed over every loop in one run. */
export const RUN_LOOP_ROUNDS = 'run.loop_rounds';
/** Seconds a run may stay in flight, from its start, its last return from waiting or the service's last start, whichever is latest. */
export const RUN_ACTIVE_SECONDS = 'run.active_seconds';
/** A workspace's top-level runs running at once. */
export const WORKSPACE_RUNNING_RUNS = 'workspace.running_runs';
/** A workspace's top-level runs running or waiting at once. */
export const WORKSPACE_UNFINISHED_RUNS = 'workspace.unfinished_runs';

/** A limit a run is admitted under and carries for its whole life. */
export type RunMetric = typeof RUN_STEPS | typeof RUN_LOOP_ROUNDS | typeof RUN_ACTIVE_SECONDS;
/** A limit admission checks a workspace against. */
export type WorkspaceMetric = typeof WORKSPACE_RUNNING_RUNS | typeof WORKSPACE_UNFINISHED_RUNS;
/** Any run-budget metric. */
export type RunLimitMetric = RunMetric | WorkspaceMetric;

/** Each run-budget metric's operator variable and its default; 0 means none. */
export const RUN_LIMITS: Readonly<Record<RunLimitMetric, { env: string; default: number }>> = {
  [RUN_STEPS]: { env: 'RUN_MAX_STEPS', default: 250_000 },
  [RUN_LOOP_ROUNDS]: { env: 'RUN_MAX_LOOP_ROUNDS', default: 250_000 },
  [RUN_ACTIVE_SECONDS]: { env: 'RUN_MAX_ACTIVE_SECONDS', default: 86_400 },
  [WORKSPACE_RUNNING_RUNS]: { env: 'WORKSPACE_MAX_RUNNING_RUNS', default: 1_000 },
  [WORKSPACE_UNFINISHED_RUNS]: { env: 'WORKSPACE_MAX_UNFINISHED_RUNS', default: 10_000 },
};

/** The largest number a run limit holds: a run's row counts its steps and seconds as 4-byte integers. */
export const RUN_LIMIT_MAX = 2_147_483_647;

const RUN_METRICS: readonly RunMetric[] = [RUN_STEPS, RUN_LOOP_ROUNDS, RUN_ACTIVE_SECONDS];

/** The per-run numbers a run was admitted under; null is none. */
export type RunLimits = Record<RunMetric, number | null>;

/** The workspace caps an admission is checked against; null is none. */
export type WorkspaceRunLimits = Record<WorkspaceMetric, number | null>;

/** What one admission runs under: each run's own limits, which it carries, and its workspace's caps, checked once. */
export interface DecidedRunLimits {
  run: RunLimits;
  workspace: WorkspaceRunLimits;
}

/** How the error of every run a limit ended begins; persisted, so a stop stays final. */
export const RUN_LIMIT_PREFIX = 'Run limit reached: ';

/** The `code` of a run a per-run limit ended. */
export const RUN_LIMIT_REACHED = 'run_limit_reached';

/** The `code` of an admission a workspace limit refused. */
export const WORKSPACE_RUN_LIMIT = 'workspace_run_limit';

const WORKSPACE_RETRY_AFTER_SECONDS = 30;

const count = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, noun: string): string => `${count(n)} ${noun}${n === 1 ? '' : 's'}`;

// A duration in the largest whole unit it fills: `24 h`, `10 min`, `45 s`.
function durationText(seconds: number): string {
  if (seconds > 0 && seconds % 3_600 === 0) return `${count(seconds / 3_600)} h`;
  if (seconds > 0 && seconds % 60 === 0) return `${count(seconds / 60)} min`;
  return `${count(seconds)} s`;
}

function runLimitReached(metric: RunMetric, max: number, message: string): DomainError {
  return new DomainError(`${RUN_LIMIT_PREFIX}${message}`, 422, {
    code: RUN_LIMIT_REACHED,
    limit: metric,
    max,
  });
}

// A called run's limits are its top-level run's, so its refusal names that run.
const whose = (called: boolean): string =>
  called ? 'the top-level run this one was called under' : 'this run';

/** The refusal of the op that would take a run tree past its steps, worded for a run another one `called`, or a top-level one. */
export function stepLimitReached(max: number, called = false): DomainError {
  const counted = called
    ? 'counting every workflow it calls, this one included'
    : 'the steps of workflows it calls count too';
  return runLimitReached(
    RUN_STEPS,
    max,
    `${whose(called)} took ${plural(max, 'step')}, the most one run may take in this workspace — ${counted}. An operator can raise ${RUN_LIMITS[RUN_STEPS].env}.`,
  );
}

/** The end of a run tree in flight past its time, worded for a run another one `called`, or a top-level one. */
export function activeTimeLimitReached(max: number, called = false): DomainError {
  return runLimitReached(
    RUN_ACTIVE_SECONDS,
    max,
    `${whose(called)} was in flight for more than ${durationText(max)} since it started or last resumed from a wait, the longest one run may go in this workspace. An operator can raise ${RUN_LIMITS[RUN_ACTIVE_SECONDS].env}.`,
  );
}

/** A called run's step or time refusal, worded again for the run that called it, itself `called` or top-level. */
export function callersRefusal(err: unknown, called: boolean): unknown {
  if (!isRunLimitReached(err)) return err;
  const { limit, max } = (err as { details: { limit?: unknown; max?: unknown } }).details;
  if (typeof max !== 'number') return err;
  if (limit === RUN_STEPS) return stepLimitReached(max, called);
  if (limit === RUN_ACTIVE_SECONDS) return activeTimeLimitReached(max, called);
  return err;
}

/** The refusal of a forEach given more items than its run has loop rounds left. */
export function forEachLimitReached(loop: string, items: number, left: number, max: number): DomainError {
  return runLimitReached(
    RUN_LOOP_ROUNDS,
    max,
    `loop "${loop}" was given ${plural(items, 'item')}, more than the ${plural(left, 'loop round')} this run has left of the ${count(max)} one run may take in this workspace. Split the list, or an operator can raise ${RUN_LIMITS[RUN_LOOP_ROUNDS].env}.`,
  );
}

/** The refusal of a while loop's round past its run's loop rounds. */
export function whileLimitReached(loop: string, max: number): DomainError {
  return runLimitReached(
    RUN_LOOP_ROUNDS,
    max,
    `while loop "${loop}" needed another round after this run had taken its ${plural(max, 'loop round')}, the most one run may take in this workspace. Lower its max_iterations, or an operator can raise ${RUN_LIMITS[RUN_LOOP_ROUNDS].env}.`,
  );
}

/** Whether `err` is a per-run limit's refusal — by its recorded code, so it holds after a step records it and DBOS replays it. */
export function isRunLimitReached(err: unknown): boolean {
  const details = (err as { details?: { code?: unknown } } | null | undefined)?.details;
  return typeof details === 'object' && details !== null && details.code === RUN_LIMIT_REACHED;
}

/** The refusal a run's row records as its `error`, under the limit whose variable it names and that limit's number in `limits`; null for any other error. */
export function recordedRunLimit(error: string | null, limits: RunLimits | null): DomainError | null {
  if (!error?.startsWith(RUN_LIMIT_PREFIX)) return null;
  const limit = RUN_METRICS.find((metric) => error.endsWith(`raise ${RUN_LIMITS[metric].env}.`));
  return limit
    ? new DomainError(error, 422, { code: RUN_LIMIT_REACHED, limit, max: limits?.[limit] ?? null })
    : null;
}

/** The refusal of an admission past one of its workspace's caps; it records nothing. */
export function workspaceRunLimit(metric: WorkspaceMetric, max: number): DomainError {
  const variable = RUN_LIMITS[metric].env;
  const message =
    metric === WORKSPACE_RUNNING_RUNS
      ? `This workspace already has ${plural(max, 'run')} running, the most it may run at once. Try again when one finishes; an operator can raise ${variable}.`
      : `This workspace already has ${plural(max, 'unfinished run')} — running, or waiting on an approval or a timer — the most it may hold at once. Finish or cancel some, then try again; an operator can raise ${variable}.`;
  return new DomainError(message, 429, {
    code: WORKSPACE_RUN_LIMIT,
    limit: metric,
    max,
    retry_after_s: WORKSPACE_RETRY_AFTER_SECONDS,
  });
}

/** Whether `err` is an admission its workspace's caps refused. */
export function isWorkspaceRunLimit(err: unknown): err is DomainError {
  return err instanceof DomainError && err.details?.code === WORKSPACE_RUN_LIMIT;
}
