import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { errorMessage } from '../common/error-message';
import { newId } from '../database/ids';
import { TIMER_TOPIC_SQL_PREFIX } from './timer-wait';
import type { RunSource, RuntimeStepKind } from '../database/entities/runtime-run.entity';

/** Per-VALUE storage cap: a value whose JSON is longer is stored as a {@link TruncatedValue}. */
const MAX_STORED_JSON_CHARS = 16_000;

/** How much of an oversized value's JSON is kept as a readable head. */
const TRUNCATED_HEAD_CHARS = 2_000;
/** What a step reads as when a cancel interrupted it, in place of the engine's own wording. */
const CANCELLED_STEP_ERROR = 'Cancelled before it finished';
const CLEAR_WAIT = 'waiting_topic = NULL, waiting_since = NULL, waiting_timeout_at = NULL, claimed_at = NULL';
const CLEAR_SLOT =
  'waiting_node_id = NULL, waiting_topic = NULL, waiting_since = NULL, waiting_timeout_at = NULL';

/** How every refused run's error begins; a run that executes records its own outcome over it. */
export const REFUSED_RUN_ERROR_PREFIX = "Workflow can't run: ";

/** An oversized stored value: the head of its JSON, plus the size it actually had. */
export interface TruncatedValue {
  truncated: true;
  /** The value's real JSON length, before truncation. */
  size_chars: number;
  /** The cap it exceeded. */
  max_chars: number;
  /** The first {@link TRUNCATED_HEAD_CHARS} characters of its JSON. */
  preview: string;
}

/** Read a stored output back as a {@link TruncatedValue}, or null when it was stored whole. */
export function truncatedValueOf(stored: unknown): TruncatedValue | null {
  if (stored === null || typeof stored !== 'object') return null;
  // EVERY field must match, so a provider payload that happens to carry `truncated` isn't mistaken for one.
  const marker = stored as Partial<TruncatedValue>;
  const shaped =
    marker.truncated === true &&
    typeof marker.size_chars === 'number' &&
    typeof marker.max_chars === 'number' &&
    typeof marker.preview === 'string';
  return shaped ? (marker as TruncatedValue) : null;
}

/** Provenance a run record carries beyond the plan itself. */
export interface RunStartMeta {
  /** The workflow this run executes (manual from-ir / workflow-bound trigger fires). */
  workflowId?: string | null;
  /** The exact workflow version executed (env-pointer resolution at fire time). */
  workflowVersionId?: string | null;
  /** What started the run. */
  source?: RunSource;
  /** Env NAME — a historical snapshot that survives an env delete/rename; null = Default. */
  environment?: string | null;
  /** Env id linking the row; null = Default. */
  environmentId?: string | null;
  /** The review this run tested (source='review_test'); else null. */
  reviewId?: string | null;
  /** Dry run (preview): no state-changing external call fired. */
  dryRun?: boolean;
  /** The run that called this one; null for a top-level run. */
  parentRunId?: string | null;
  /** The calling step's `step_key` in the parent run. */
  parentStepKey?: string | null;
  /** The caller's org, recorded when the run has no workflow of its own to take it from. */
  orgId?: string | null;
}

/**
 * The interpreter's run-history recording seam — an interface so the interpreter stays free of
 * Nest/TypeORM. `stepWaiting`/`stepResumed` bracket each parked wait, and that per-step state is what
 * the waiting list, event delivery and the run's `waiting` status read.
 */
export interface RunRecorder {
  runStarted(
    scopedRunId: string,
    runId: string,
    userId: string,
    plan: unknown,
    meta?: RunStartMeta,
  ): Promise<void>;
  stepStarted(
    scopedRunId: string,
    stepKey: string,
    nodeId: string,
    kind: RuntimeStepKind,
    pinned?: boolean,
  ): Promise<void>;
  stepFinished(scopedRunId: string, stepKey: string, output: unknown, error: string | null): Promise<void>;
  /** Flag an errored step as tolerated (continue-on-fail) — the run went on. */
  stepContinued(scopedRunId: string, stepKey: string): Promise<void>;
  /** Record how many attempts a step took (retry-on-fail); 1 unless retried. */
  stepAttempts(scopedRunId: string, stepKey: string, attempts: number): Promise<void>;
  /** Record a step's non-fatal honesty warnings (e.g. a `{{ref}}` that resolved to nothing); never fails it. */
  stepWarnings(scopedRunId: string, stepKey: string, warnings: string[]): Promise<void>;
  /** Park a step on `topic` until `timeoutAt`, or keep the deadline it first parked with; resolves to that deadline. */
  stepWaiting(scopedRunId: string, stepKey: string, topic: string, timeoutAt: Date): Promise<Date | null>;
  /** The step's wait ended (event or timeout); the run reads `running` again once no step is parked. */
  stepResumed(scopedRunId: string, stepKey: string): Promise<void>;
  runFinished(scopedRunId: string, outputs: unknown, error: string | null): Promise<void>;
  /** A cancel unwinds the run as a failure `runFinished` has just recorded; restore what actually ended it. */
  runUnwoundByCancel(scopedRunId: string, unwindError: string): Promise<void>;
}

/**
 * Persists run + per-step records. Every write is an UPSERT keyed on the scoped run id (and
 * step_key), because a DBOS crash-recovery re-executes the workflow body from the top. All writes
 * are best-effort — history must never fail a run, so errors are logged and swallowed deliberately.
 */
@Injectable()
export class RunRecorderService implements RunRecorder {
  private readonly logger = new Logger(RunRecorderService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Record a run as started; it takes over an id only a refusal holds, and leaves any run already on it as it was. */
  async runStarted(
    scopedRunId: string,
    runId: string,
    userId: string,
    plan: unknown,
    meta?: RunStartMeta,
  ): Promise<void> {
    await this.insertRun('runStarted', scopedRunId, runId, userId, plan, meta, null);
  }

  /** Record a run refused before any step ran, as already failed; it replaces an earlier refusal on the id, and leaves any run on it as it was. */
  async runRefused(
    scopedRunId: string,
    runId: string,
    userId: string,
    error: string,
    meta?: RunStartMeta,
  ): Promise<void> {
    await this.insertRun('runRefused', scopedRunId, runId, userId, null, meta, error);
  }

  private async insertRun(
    op: string,
    scopedRunId: string,
    runId: string,
    userId: string,
    plan: unknown,
    meta: RunStartMeta | undefined,
    error: string | null,
  ): Promise<void> {
    await this.write(op, scopedRunId, [
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, plan, status, error, started_at, finished_at, workflow_id, source, environment, environment_id, workflow_version_id, review_id, dry_run, parent_run_id, parent_step_key, org_id)
       VALUES ($1, $2, $3, $4, CAST($5 AS json),
               CASE WHEN $16::text IS NULL THEN 'running' ELSE 'error' END, $16, now(),
               CASE WHEN $16::text IS NULL THEN NULL ELSE now() END,
               $6, $7, $8, $9, $10, $11, $12, $13, $14,
               COALESCE((SELECT org_id FROM workflows WHERE id = $6), $15))
       ON CONFLICT (id) DO UPDATE
          SET plan_id = EXCLUDED.plan_id, plan = EXCLUDED.plan, status = EXCLUDED.status,
              error = EXCLUDED.error, outputs = NULL, started_at = EXCLUDED.started_at,
              finished_at = EXCLUDED.finished_at, workflow_id = EXCLUDED.workflow_id,
              source = EXCLUDED.source, environment = EXCLUDED.environment,
              environment_id = EXCLUDED.environment_id, workflow_version_id = EXCLUDED.workflow_version_id,
              review_id = EXCLUDED.review_id, dry_run = EXCLUDED.dry_run,
              parent_run_id = EXCLUDED.parent_run_id, parent_step_key = EXCLUDED.parent_step_key,
              org_id = EXCLUDED.org_id
        WHERE runtime_runs.status = 'error' AND starts_with(runtime_runs.error, $17)
          AND COALESCE(json_typeof(runtime_runs.plan), 'null') = 'null'
          AND NOT EXISTS (SELECT 1 FROM runtime_run_steps s WHERE s.run_id = runtime_runs.id)`,
      [
        scopedRunId,
        runId,
        userId,
        planIdOf(plan),
        cappedJson(plan),
        meta?.workflowId ?? null,
        meta?.source ?? null,
        meta?.environment ?? null,
        meta?.environmentId ?? null,
        meta?.workflowVersionId ?? null,
        meta?.reviewId ?? null,
        meta?.dryRun ?? false,
        meta?.parentRunId ?? null,
        meta?.parentStepKey ?? null,
        meta?.orgId ?? null,
        error,
        REFUSED_RUN_ERROR_PREFIX,
      ],
    ]);
  }

  async stepStarted(
    scopedRunId: string,
    stepKey: string,
    nodeId: string,
    kind: RuntimeStepKind,
    pinned = false,
  ): Promise<void> {
    // `pinned` marks a REPLAYED step — set on both the insert and the crash-replay
    // UPSERT so history stays honest about which steps actually executed.
    await this.write('stepStarted', scopedRunId, [
      `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at, pinned)
       VALUES ($1, $2, $3, $4, $5, 'running', now(), $6)
       ON CONFLICT (run_id, step_key)
       DO UPDATE SET status = 'running', error = NULL, pinned = $6, continued = false, attempts = 1`,
      [newId(), scopedRunId, stepKey, nodeId, kind, pinned],
    ]);
  }

  async stepFinished(
    scopedRunId: string,
    stepKey: string,
    output: unknown,
    error: string | null,
  ): Promise<void> {
    await this.write('stepFinished', scopedRunId, [
      `UPDATE runtime_run_steps
          SET status = $3, output = CAST($4 AS json), error = $5, finished_at = now()
        WHERE run_id = $1 AND step_key = $2`,
      [scopedRunId, stepKey, error === null ? 'completed' : 'error', cappedJson(output), error],
    ]);
  }

  async stepContinued(scopedRunId: string, stepKey: string): Promise<void> {
    // The row already carries status='error' from stepFinished; this flags it as tolerated
    // so the runs panel shows "errored, continued" rather than a halt.
    await this.write('stepContinued', scopedRunId, [
      `UPDATE runtime_run_steps SET continued = true WHERE run_id = $1 AND step_key = $2`,
      [scopedRunId, stepKey],
    ]);
  }

  async stepAttempts(scopedRunId: string, stepKey: string, attempts: number): Promise<void> {
    await this.write('stepAttempts', scopedRunId, [
      `UPDATE runtime_run_steps SET attempts = $3 WHERE run_id = $1 AND step_key = $2`,
      [scopedRunId, stepKey, attempts],
    ]);
  }

  async stepWarnings(scopedRunId: string, stepKey: string, warnings: string[]): Promise<void> {
    await this.write('stepWarnings', scopedRunId, [
      `UPDATE runtime_run_steps SET warnings = CAST($3 AS json) WHERE run_id = $1 AND step_key = $2`,
      [scopedRunId, stepKey, JSON.stringify(warnings)],
    ]);
  }

  async stepWaiting(
    scopedRunId: string,
    stepKey: string,
    topic: string,
    timeoutAt: Date,
  ): Promise<Date | null> {
    // A replay re-parks with the deadline the wait first had, and never re-parks a wait already answered.
    const [rows] = (await this.writeWait<[Array<{ waiting_timeout_at: Date | null }>, number]>(
      'stepWaiting',
      scopedRunId,
      [
        `UPDATE runtime_run_steps
            SET waiting_since = CASE WHEN waiting_topic = $3 THEN waiting_since ELSE now() END,
                waiting_timeout_at = CASE WHEN waiting_topic = $3 THEN waiting_timeout_at ELSE $4 END,
                waiting_topic = $3
          WHERE run_id = $1 AND step_key = $2 AND finished_at IS NULL
          RETURNING waiting_timeout_at`,
        [scopedRunId, stepKey, topic, timeoutAt],
      ],
    )) ?? [[]];
    return rows[0]?.waiting_timeout_at ?? null;
  }

  async stepResumed(scopedRunId: string, stepKey: string): Promise<void> {
    await this.writeWait('stepResumed', scopedRunId, [
      `UPDATE runtime_run_steps SET ${CLEAR_WAIT} WHERE run_id = $1 AND step_key = $2`,
      [scopedRunId, stepKey],
    ]);
  }

  async runFinished(scopedRunId: string, outputs: unknown, error: string | null): Promise<void> {
    await this.write('runFinished', scopedRunId, [
      `UPDATE runtime_runs
          SET status = $2, outputs = CAST($3 AS json), error = $4, finished_at = now(), ${CLEAR_SLOT}
        WHERE id = $1`,
      [scopedRunId, error === null ? 'completed' : 'error', cappedOutputsJson(outputs), error],
    ]);
    await this.clearWaits('runFinished', scopedRunId);
  }

  async runUnwoundByCancel(scopedRunId: string, unwindError: string): Promise<void> {
    await this.write('runUnwoundByCancel', scopedRunId, [
      `UPDATE runtime_runs
          SET status = 'cancelled', error = NULL, finished_at = COALESCE(finished_at, now()), ${CLEAR_SLOT}
        WHERE id = $1 AND status <> 'completed'`,
      [scopedRunId],
    ]);
    await this.clearWaits('runUnwoundByCancel', scopedRunId);
    // Only the step that carried this very error: the one the cancel interrupted.
    await this.write('runUnwoundByCancel', scopedRunId, [
      `UPDATE runtime_run_steps SET error = $3 WHERE run_id = $1 AND error = $2`,
      [scopedRunId, unwindError, CANCELLED_STEP_ERROR],
    ]);
  }

  private async clearWaits(op: string, scopedRunId: string): Promise<void> {
    await this.write(op, scopedRunId, [
      `UPDATE runtime_run_steps SET ${CLEAR_WAIT} WHERE run_id = $1 AND waiting_topic IS NOT NULL`,
      [scopedRunId],
    ]);
  }

  private async writeWait<T = unknown>(
    op: string,
    scopedRunId: string,
    [sql, params]: [string, unknown[]],
  ): Promise<T | null> {
    try {
      return await withWaitLock(this.dataSource.manager, scopedRunId, (em): Promise<T> =>
        em.query(sql, params),
      );
    } catch (err) {
      this.logger.warn(`run history ${op} failed for ${scopedRunId}: ${errorMessage(err)}`);
      return null;
    }
  }

  private async write(op: string, scopedRunId: string, [sql, params]: [string, unknown[]]): Promise<void> {
    try {
      await this.dataSource.query(sql, params);
    } catch (err) {
      this.logger.warn(`run history ${op} failed for ${scopedRunId}: ${errorMessage(err)}`);
    }
  }
}

/** Change a run's step waits under its lock, then re-derive its status (`waiting` while any step is parked) and slot. */
export function withWaitLock<T>(
  manager: EntityManager,
  scopedRunId: string,
  write: (em: EntityManager) => Promise<T>,
): Promise<T> {
  return manager.transaction(async (em) => {
    await em.query(`SELECT 1 FROM runtime_runs WHERE id = $1 FOR NO KEY UPDATE`, [scopedRunId]);
    const result = await write(em);
    // The slot mirrors the headline wait so an older image run against this database can still answer it.
    await em.query(
      `UPDATE runtime_runs r
          SET status = CASE WHEN EXISTS (
                SELECT 1 FROM runtime_run_steps s WHERE s.run_id = r.id AND s.waiting_topic IS NOT NULL
              ) THEN 'waiting' ELSE 'running' END,
              (waiting_node_id, waiting_topic, waiting_since, waiting_timeout_at) = (
                SELECT s.node_id, s.waiting_topic, s.waiting_since, s.waiting_timeout_at
                  FROM runtime_run_steps s
                 WHERE s.run_id = r.id AND s.waiting_topic IS NOT NULL
                 ORDER BY s.waiting_topic LIKE $2 || '%', s.waiting_timeout_at NULLS LAST, s.step_key
                 LIMIT 1
              )
        WHERE r.id = $1 AND r.status IN ('running', 'waiting')`,
      [scopedRunId, TIMER_TOPIC_SQL_PREFIX],
    );
    return result;
  });
}

/** Mark a non-terminal run `cancelled` (user cancel, B7) and unpark its steps; run it inside {@link withWaitLock}. */
export async function recordCancel(em: EntityManager, scopedRunId: string): Promise<void> {
  // The WHERE guard is what stops a cancel racing a natural finish from rewriting the outcome.
  await em.query(
    `UPDATE runtime_runs SET status = 'cancelled', finished_at = now(), ${CLEAR_SLOT}
      WHERE id = $1 AND status IN ('running', 'waiting')`,
    [scopedRunId],
  );
  await em.query(
    `UPDATE runtime_run_steps SET ${CLEAR_WAIT} WHERE run_id = $1 AND waiting_topic IS NOT NULL`,
    [scopedRunId],
  );
}

function planIdOf(plan: unknown): string {
  const id = plan !== null && typeof plan === 'object' ? (plan as { id?: unknown }).id : undefined;
  return (typeof id === 'string' && id ? id : 'plan').slice(0, 200);
}

/** A value as it is stored: itself when it fits the cap, else a {@link TruncatedValue} keeping its head. */
function cappedValue(value: unknown): unknown {
  const raw = JSON.stringify(value ?? null);
  if (raw === undefined) return null;
  if (raw.length <= MAX_STORED_JSON_CHARS) return value ?? null;
  return {
    truncated: true,
    size_chars: raw.length,
    max_chars: MAX_STORED_JSON_CHARS,
    preview: raw.slice(0, TRUNCATED_HEAD_CHARS),
  } satisfies TruncatedValue;
}

/** JSON for storage, size-capped — an oversized payload keeps a head, never a failed write. */
function cappedJson(value: unknown): string {
  return JSON.stringify(cappedValue(value)) ?? 'null';
}

/** The run's outputs map, capped PER STEP — one oversized value must never take the whole map down. */
function cappedOutputsJson(outputs: unknown): string {
  if (outputs === null || typeof outputs !== 'object' || Array.isArray(outputs)) return cappedJson(outputs);
  const capped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(outputs)) capped[key] = cappedValue(value);
  return JSON.stringify(capped) ?? 'null';
}
