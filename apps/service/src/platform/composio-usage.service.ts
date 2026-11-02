import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { ActionError } from '@sarati/actions-sdk';
import type { DataSource } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { isRecord } from '../common/json-util';
import type { EnvConfig } from '../config/env.config';
import { rawQuery } from '../database/raw-query';
import { PlatformKeysService } from './platform-keys.service';

/** The first day of the UTC calendar month `at` (an SQL timestamptz expression) falls in, whatever the session's time zone. */
export function utcMonthOf(at: string): string {
  return `date_trunc('month', (${at}) AT TIME ZONE 'UTC')::date`;
}

const MONTH = `SELECT ${utcMonthOf('now()')} AS start`;
const RESETS_ON = `to_char(month.start + interval '1 month', 'YYYY-MM-DD')`;

const CHARGE = `
  WITH month AS (${MONTH}),
  charged AS (
    INSERT INTO composio_usage (user_id, month, actions)
    SELECT $1::uuid, month.start, 1 FROM month WHERE $2::integer >= 1
    ON CONFLICT (user_id, month) DO UPDATE
       SET actions = composio_usage.actions + 1, updated_at = now()
     WHERE composio_usage.actions < $2::integer
    RETURNING actions
  )
  SELECT (SELECT actions FROM charged) AS actions, ${RESETS_ON} AS resets_on FROM month`;

const COUNT_TRIGGER_EVENT = `
  INSERT INTO composio_usage (user_id, month, trigger_events)
  SELECT person, (${MONTH}), 1 FROM unnest($1::uuid[]) AS person
  ON CONFLICT (user_id, month) DO UPDATE
     SET trigger_events = composio_usage.trigger_events + 1, updated_at = now()`;

const USAGE = `
  WITH month AS (${MONTH})
  SELECT COALESCE(u.actions, 0) AS actions, COALESCE(u.trigger_events, 0) AS trigger_events, ${RESETS_ON} AS resets_on
    FROM month LEFT JOIN composio_usage u ON u.user_id = $1::uuid AND u.month = month.start`;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `YYYY-MM-DD` as people read it, e.g. December 1, 2026. */
function spelled(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return `${MONTH_NAMES[(month ?? 1) - 1]} ${day}, ${year}`;
}

const MONTHLY_LIMIT = 'composio_monthly_limit';
const MAX_CAUSE_DEPTH = 8;

/** What a refusal by the monthly app-action limit carries, whichever rail it crossed and whatever wraps it, and its reset date spelled; null for any other failure. */
export function monthlyLimitOf(err: unknown): { details: Record<string, unknown>; resetsOn: string } | null {
  for (let at = err, depth = 0; at instanceof Error && depth < MAX_CAUSE_DEPTH; at = at.cause, depth++) {
    const details =
      at instanceof DomainError ? at.details : at instanceof ActionError ? at.detail : undefined;
    if (isRecord(details) && details.code === MONTHLY_LIMIT && typeof details.resets_at === 'string') {
      return { details, resetsOn: spelled(details.resets_at.slice(0, 10)) };
    }
  }
  return null;
}

/** One person's use of the instance's Composio account this UTC month. */
export interface ComposioUsage {
  actions_used: number;
  actions_limit: number;
  trigger_events: number;
  /** When the count starts again: midnight UTC on the first of next month, as an ISO instant. */
  resets_at: string;
}

/** The person a request acts for has run every app action this instance allows them this month. */
export class ComposioCapReached extends DomainError {
  constructor(limit: number, resetsOn: string) {
    super(
      limit === 0
        ? `This instance runs no app actions on its Composio account: its monthly limit per person is 0 (the count starts again on ${spelled(resetsOn)}, UTC)`
        : `The monthly limit of ${limit} app actions per person on this instance is used up for the account this runs as — it resets on ${spelled(resetsOn)} (UTC)`,
      429,
      { code: MONTHLY_LIMIT, limit, resets_at: `${resetsOn}T00:00:00.000Z` },
    );
  }
}

/** Each person's monthly use of the instance's own Composio account, charged before every app action is sent; inert unless the instance provides one. */
@Injectable()
export class ComposioUsageService {
  private readonly limit: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly platformKeys: PlatformKeysService,
    config: ConfigService<{ env: EnvConfig }, true>,
  ) {
    this.limit = config.get('env', { infer: true }).instanceComposioMonthlyActionsPerPerson;
  }

  /** Counts one app action for `personId`, committed before the caller sends it, or throws {@link ComposioCapReached} counting nothing. */
  async charge(personId: string): Promise<void> {
    if (!this.platformKeys.composioManagedByInstance()) return;
    const [row] = await rawQuery<{ actions: number | null; resets_on: string }>(
      this.dataSource.manager,
      CHARGE,
      [personId, this.limit],
    );
    if (!row || row.actions === null) throw new ComposioCapReached(this.limit, row?.resets_on ?? '');
  }

  /** Counts one delivered trigger event for each of `personIds`. */
  async countTriggerEvent(personIds: readonly string[]): Promise<void> {
    if (!this.platformKeys.composioManagedByInstance() || personIds.length === 0) return;
    await rawQuery(this.dataSource.manager, COUNT_TRIGGER_EVENT, [personIds]);
  }

  /** `personId`'s use this month, or null when each person uses their own key and nothing is counted. */
  async usageOf(personId: string): Promise<ComposioUsage | null> {
    if (!this.platformKeys.composioManagedByInstance()) return null;
    const [row] = await rawQuery<{ actions: number; trigger_events: number; resets_on: string }>(
      this.dataSource.manager,
      USAGE,
      [personId],
    );
    return {
      actions_used: row?.actions ?? 0,
      actions_limit: this.limit,
      trigger_events: row?.trigger_events ?? 0,
      resets_at: `${row?.resets_on ?? ''}T00:00:00.000Z`,
    };
  }
}
