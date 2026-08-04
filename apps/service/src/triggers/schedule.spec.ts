import { DomainError } from '../common/domain-error';
import { dueAt, nextDueAt, parseScheduleProps } from './schedule';

describe('parseScheduleProps (create-time validation)', () => {
  it('accepts a plain interval; timezone defaults to UTC', () => {
    expect(parseScheduleProps({ interval_minutes: 15 })).toEqual({
      cron: null,
      intervalMinutes: 15,
      timezone: 'UTC',
    });
  });

  it('accepts a cron with an IANA timezone', () => {
    expect(parseScheduleProps({ cron: '0 9 * * 1-5', timezone: 'Europe/London' })).toEqual({
      cron: '0 9 * * 1-5',
      intervalMinutes: null,
      timezone: 'Europe/London',
    });
  });

  it('rejects BOTH cron and interval set, and NEITHER', () => {
    expect(() => parseScheduleProps({ cron: '* * * * *', interval_minutes: 5 })).toThrow(
      'Set exactly one of cron or interval_minutes',
    );
    expect(() => parseScheduleProps({})).toThrow('Set exactly one of cron or interval_minutes');
    expect(() => parseScheduleProps(null)).toThrow(DomainError);
  });

  it('treats an empty-string cron as unset (form-friendly)', () => {
    expect(parseScheduleProps({ cron: '', interval_minutes: 5 }).intervalMinutes).toBe(5);
  });

  it('rejects an interval under 1 minute, not a whole number, or over one year', () => {
    for (const bad of [0, -5, 2.5, '15', Number.NaN, 525_601, 1e15]) {
      expect(() => parseScheduleProps({ interval_minutes: bad })).toThrow(DomainError);
    }
    expect(parseScheduleProps({ interval_minutes: 1 }).intervalMinutes).toBe(1);
    expect(parseScheduleProps({ interval_minutes: 525_600 }).intervalMinutes).toBe(525_600);
  });

  it('rejects a cron the parser cannot parse', () => {
    // Note: cron-parser pads short expressions ("* * * *" is parser-valid), so
    // the reject set is what the PARSER refuses — the pinned validation rule.
    for (const bad of ['not a cron', '99 99 * * *', '* * * * * * *']) {
      expect(() => parseScheduleProps({ cron: bad })).toThrow('Invalid cron expression');
    }
  });

  it('rejects an unknown timezone (both modes) and a non-string cron', () => {
    expect(() => parseScheduleProps({ cron: '* * * * *', timezone: 'Mars/Olympus' })).toThrow(
      'Unknown timezone',
    );
    expect(() => parseScheduleProps({ interval_minutes: 5, timezone: 'nope' })).toThrow('Unknown timezone');
    expect(() => parseScheduleProps({ cron: 42 })).toThrow('cron must be a string');
  });
});

describe('due evaluation (one sweep tick)', () => {
  const at = (iso: string): Date => new Date(iso);

  it('interval: due exactly one interval after the last fire, not before', () => {
    const schedule = parseScheduleProps({ interval_minutes: 15 });
    const lastFire = at('2026-07-10T09:00:00Z');
    expect(nextDueAt(schedule, lastFire).toISOString()).toBe('2026-07-10T09:15:00.000Z');
    expect(dueAt(schedule, lastFire, at('2026-07-10T09:14:59Z'))).toBeNull();
    expect(dueAt(schedule, lastFire, at('2026-07-10T09:15:00Z'))?.toISOString()).toBe(
      '2026-07-10T09:15:00.000Z',
    );
  });

  it('cron: "weekdays at 9am" from a Friday mid-morning is next Monday 09:00', () => {
    const schedule = parseScheduleProps({ cron: '0 9 * * 1-5' });
    // 2026-07-10 is a Friday; 10:00 UTC is past that day's 09:00 fire.
    const next = nextDueAt(schedule, at('2026-07-10T10:00:00Z'));
    expect(next.toISOString()).toBe('2026-07-13T09:00:00.000Z'); // Monday
    expect(dueAt(schedule, at('2026-07-10T10:00:00Z'), at('2026-07-12T09:00:00Z'))).toBeNull(); // Sunday
    expect(dueAt(schedule, at('2026-07-10T10:00:00Z'), at('2026-07-13T09:00:30Z'))?.toISOString()).toBe(
      '2026-07-13T09:00:00.000Z',
    );
  });

  it('cron timezone: daily 09:00 Europe/London keeps wall-clock time across the DST shift', () => {
    const schedule = parseScheduleProps({ cron: '0 9 * * *', timezone: 'Europe/London' });
    // BST starts 2026-03-29 01:00 UTC. 09:00 local is 09:00Z before, 08:00Z after.
    const beforeShift = nextDueAt(schedule, at('2026-03-27T12:00:00Z'));
    expect(beforeShift.toISOString()).toBe('2026-03-28T09:00:00.000Z'); // GMT
    const acrossShift = nextDueAt(schedule, beforeShift);
    expect(acrossShift.toISOString()).toBe('2026-03-29T08:00:00.000Z'); // BST — still 09:00 local
  });

  it('cron DST edge: a spring-forward-nonexistent time fires shifted, not skipped', () => {
    // America/New_York 2026-03-08: 02:00→03:00, so 02:30 local does not exist.
    // cron-parser fires it at 03:30 EDT (07:30Z) instead of dropping the day.
    const schedule = parseScheduleProps({ cron: '30 2 * * *', timezone: 'America/New_York' });
    const onGapDay = nextDueAt(schedule, at('2026-03-07T12:00:00Z'));
    expect(onGapDay.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    // The day after resumes the normal wall-clock time (02:30 EDT = 06:30Z).
    expect(nextDueAt(schedule, onGapDay).toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('missed windows collapse: N overdue occurrences fire ONCE, stamped with the earliest', () => {
    const schedule = parseScheduleProps({ cron: '0 9 * * *' });
    // Cursor is 3 days stale (service down / trigger disabled): 3 windows missed.
    const staleCursor = at('2026-07-07T10:00:00Z');
    const now = at('2026-07-10T10:00:00Z');
    const fire = dueAt(schedule, staleCursor, now);
    expect(fire?.toISOString()).toBe('2026-07-08T09:00:00.000Z'); // earliest missed occurrence
    // The sweep advances the cursor to NOW on fire — re-evaluating immediately
    // is NOT due (one catch-up fire, no backfill flood)…
    expect(dueAt(schedule, now, now)).toBeNull();
    // …and the cadence resumes at the next real occurrence.
    expect(nextDueAt(schedule, now).toISOString()).toBe('2026-07-11T09:00:00.000Z');
  });

  it('interval missed windows collapse the same way', () => {
    const schedule = parseScheduleProps({ interval_minutes: 60 });
    const staleCursor = at('2026-07-10T00:00:00Z');
    const now = at('2026-07-10T05:30:00Z'); // 5 windows missed
    expect(dueAt(schedule, staleCursor, now)?.toISOString()).toBe('2026-07-10T01:00:00.000Z');
    expect(dueAt(schedule, now, now)).toBeNull(); // cursor advanced → one fire only
  });
});
