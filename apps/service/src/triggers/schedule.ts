import { CronExpressionParser } from 'cron-parser';

import { DomainError } from '../common/domain-error';
import { errorMessage } from '../common/error-message';

/**
 * The native timed-schedule trigger kind. Due-ness is evaluated inside the `trigger-poll`
 * sweep, so schedule resolution is bounded below by the sweep interval.
 */
export const ORCHESTR_SCHEDULE = 'orchestr:schedule';

/** Store key of the schedule's last-fire cursor (ISO timestamp). */
export const SCHEDULE_CURSOR_KEY = 'schedule.lastFire';

/** One year — a longer interval is a typo, and would overflow Date math into a never-fires trigger. */
const MAX_INTERVAL_MINUTES = 525_600;

/** A validated schedule — the type encodes "EXACTLY one of cron | interval". */
export type ParsedSchedule =
  /** 5-field cron expression, evaluated in `timezone` (an IANA zone, default UTC). */
  | { cron: string; intervalMinutes: null; timezone: string }
  /** Fixed cadence in minutes (>= 1), measured from the last fire. */
  | { cron: null; intervalMinutes: number; timezone: string };

/**
 * Validate + normalize `orchestr:schedule` props (`{cron?, interval_minutes?, timezone?}`),
 * rejecting with a user-facing 400. Empty strings count as unset (form-friendly).
 */
export function parseScheduleProps(props: Record<string, unknown> | null): ParsedSchedule {
  const cron = presentString(props?.cron, 'cron');
  const interval = props?.interval_minutes ?? null;
  if ((cron === null) === (interval === null)) {
    throw new DomainError('Set exactly one of cron or interval_minutes');
  }

  const timezone = presentString(props?.timezone, 'timezone') ?? 'UTC';
  if (!isValidTimezone(timezone)) {
    throw new DomainError(`Unknown timezone "${timezone}" — use an IANA name like "Europe/London"`);
  }

  if (cron === null) {
    if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1) {
      throw new DomainError('interval_minutes must be a whole number of minutes, at least 1');
    }
    if (interval > MAX_INTERVAL_MINUTES) {
      throw new DomainError(`interval_minutes must be at most ${MAX_INTERVAL_MINUTES} (one year)`);
    }
    return { cron: null, intervalMinutes: interval, timezone };
  }

  try {
    CronExpressionParser.parse(cron, { tz: timezone });
  } catch (err) {
    throw new DomainError(`Invalid cron expression "${cron}": ${errorMessage(err)}`);
  }
  return { cron, intervalMinutes: null, timezone };
}

/**
 * The first occurrence STRICTLY after `lastFire`. Cron is evaluated in the schedule's timezone,
 * which keeps wall-clock times stable across DST shifts.
 */
export function nextDueAt(schedule: ParsedSchedule, lastFire: Date): Date {
  if (schedule.cron === null) {
    return new Date(lastFire.getTime() + schedule.intervalMinutes * 60_000);
  }
  return CronExpressionParser.parse(schedule.cron, { currentDate: lastFire, tz: schedule.timezone })
    .next()
    .toDate();
}

/**
 * One sweep tick's due check: the earliest occurrence after `lastFire` at or before `now`, else
 * null. Callers advance the cursor to NOW on fire, so N missed windows collapse into ONE fire.
 */
export function dueAt(schedule: ParsedSchedule, lastFire: Date, now: Date): Date | null {
  const next = nextDueAt(schedule, lastFire);
  return next.getTime() <= now.getTime() ? next : null;
}

/** Non-empty-string coercion: null/undefined/'' → null; any other non-string is a 400. */
function presentString(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new DomainError(`${field} must be a string`);
  return value;
}

/** Whether the runtime knows this IANA timezone (Intl throws on unknown names). */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
