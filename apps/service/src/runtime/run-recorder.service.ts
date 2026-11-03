import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IsNull, Not, type DataSource, type EntityManager } from 'typeorm';

import { errorMessage } from '../common/error-message';
import { RUN_ADMISSION_LOCK_SPACE } from '../database/advisory-lock-spaces';
import { newId } from '../database/ids';
import { rawMutate, rawMutateReturning, rawQuery } from '../database/raw-query';
import {
  RUN_ACTIVE_SECONDS,
  RUN_LIMIT_PREFIX,
  WORKSPACE_RUNNING_RUNS,
  WORKSPACE_UNFINISHED_RUNS,
  workspaceRunLimit,
  type DecidedRunLimits,
  type RunLimits,
  type WorkspaceRunLimits,
} from '../entitlements/run-limits';
import { TIMER_TOPIC_SQL_PREFIX } from './timer-wait';
import type { RunSource, RuntimeRunStatus, RuntimeStepKind } from '../database/entities/runtime-run.entity';

/** Per-VALUE storage cap: a value whose JSON is longer is stored as a {@link TruncatedValue}. */
const MAX_STORED_JSON_CHARS = 16_000;

/** How much of an oversized value's JSON is kept as a readable head. */
const TRUNCATED_HEAD_CHARS = 2_000;
/** What a step reads as when a cancel interrupted it, in place of the engine's own wording. */
const CANCELLED_STEP_ERROR = 'Cancelled before it finished';
// What a step reads as when a stop for a limit interrupted it.
const STOPPED_STEP_ERROR = 'Stopped before it finished — the run reached a limit.';
// A run a limit ended: final, so nothing it does afterwards rewrites it.
const LIMIT_ENDED = `(status = 'error' AND starts_with(COALESCE(error, ''), '${RUN_LIMIT_PREFIX}'))`;
// Ends a step's wait and leaves any claim on it for that wait's own resume to settle.
const END_WAIT =
  'waiting_topic = NULL, waiting_since = NULL, waiting_timeout_at = NULL, delivery_topic = NULL';
/** SET clause that drops a step's claim. */
export const CLEAR_CLAIM = 'claimed_at = NULL, claimed_by = NULL, claimed_payload = NULL';
/** SET clause that ends a step's wait and any claim on it. */
export const CLEAR_WAIT = `${END_WAIT}, ${CLEAR_CLAIM}`;
/** SET clause that empties the run's slot. */
export const CLEAR_SLOT =
  'waiting_node_id = NULL, waiting_topic = NULL, waiting_since = NULL, waiting_timeout_at = NULL';

// The root's row is gone: a charge references it.
function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === '23503';
}

// A step `s` of run `x` that calls a run still in flight: an authored call's step, or an AI Agent's whose tool the run is.
const CALLING = `EXISTS (SELECT 1 FROM runtime_runs c
   WHERE c.parent_run_id = x.id AND c.status IN ('running', 'waiting')
     AND (c.parent_step_key = s.step_key OR starts_with(c.parent_step_key, s.step_key || '#')))`;

// SQL test that a lane of the run tree rooted at `alias` is in flight: a run of it with an open step neither parked nor calling a run in flight, or running between two steps.
function treeInFlight(alias: string): string {
  return `EXISTS (
    WITH RECURSIVE tree AS (
      SELECT ${alias}.id AS id, ${alias}.status AS status
      UNION ALL
      SELECT c.id, c.status FROM runtime_runs c JOIN tree t ON c.parent_run_id = t.id
       WHERE c.status IN ('running', 'waiting')
    )
    SELECT 1 FROM tree x
     WHERE x.status IN ('running', 'waiting')
       AND (EXISTS (SELECT 1 FROM runtime_run_steps s
                     WHERE s.run_id = x.id AND s.finished_at IS NULL AND s.waiting_topic IS NULL AND NOT ${CALLING})
            OR (x.status = 'running'
                AND NOT EXISTS (SELECT 1 FROM runtime_run_steps s WHERE s.run_id = x.id AND s.finished_at IS NULL))))`;
}

// SQL for when the run `alias`'s time in flight began: its start, the last time its whole tree came back from waiting, or `floor`, this process's start, whichever is latest.
function activeSince(alias: string, floor: string): string {
  return `GREATEST(${alias}.started_at, ${alias}.active_since, ${floor}::timestamptz)`;
}

/** SQL test that the run `alias` is a top-level run with a lane in flight past the time it was admitted under, counted from no earlier than `floor`. */
export function overActiveTime(alias: string, floor: string): string {
  return `${alias}.parent_run_id IS NULL AND ${alias}.status IN ('running', 'waiting')
    AND (${alias}.limits ->> '${RUN_ACTIVE_SECONDS}') IS NOT NULL
    AND ${activeSince(alias, floor)} < now() - make_interval(secs => (${alias}.limits ->> '${RUN_ACTIVE_SECONDS}')::int)
    AND ${treeInFlight(alias)}`;
}

// SQL for a run's workspace: its workflow's org, else the org it was started in.
function workspaceSql(workflowParam: string, orgParam: string): string {
  return `COALESCE((SELECT org_id FROM workflows WHERE id = ${workflowParam}), ${orgParam})`;
}

/** SQL test that `alias` (a runtime_run_steps row) holds an open wait — parked, and the step not finished. */
export function parkedStep(alias: string): string {
  return `${alias}.waiting_topic IS NOT NULL AND ${alias}.finished_at IS NULL`;
}

/** {@link parkedStep} as a TypeORM `where`. */
export const PARKED_STEP = { waitingTopic: Not(IsNull()), finishedAt: IsNull() };

/** {@link parkedStep} for a step already loaded. */
export function isParkedStep(step: { waitingTopic: string | null; finishedAt: Date | null }): boolean {
  return step.waitingTopic !== null && step.finishedAt === null;
}

/** How every refused run's error begins; a run that executes records its own outcome over it. */
export const REFUSED_RUN_ERROR_PREFIX = "Workflow can't run: ";

// A run that took no step: its workflow never began, so nothing it did is undone or repeated.
const NO_STEP = 'NOT EXISTS (SELECT 1 FROM runtime_run_steps s WHERE s.run_id = runtime_runs.id)';

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

/** The interpreter's run-history seam, free of Nest/TypeORM; `stepWaiting`/`stepResumed` bracket each parked wait. */
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
  /** Park a step on `topic` until `due`, else keeping the deadline a park on `topic` already has, else for `durationMs` from its start; resolves to its deadline. */
  stepWaiting(
    scopedRunId: string,
    stepKey: string,
    topic: string,
    durationMs: number,
    deliveryTopic?: string | null,
    due?: Date | null,
  ): Promise<Date | null>;
  /** The step's wait ended; `answered` when the run took an event, which credits its claim's decider on this step. */
  stepResumed(scopedRunId: string, stepKey: string, answered?: boolean): Promise<void>;
  runFinished(scopedRunId: string, outputs: unknown, error: string | null): Promise<void>;
  /** A cancel unwinds the run as a failure `runFinished` has just recorded; restore what actually ended it. */
  runUnwoundByCancel(scopedRunId: string, unwindError: string): Promise<void>;
  /** Whether the run's row reads cancelled — the one answer to whether a cancel has landed, on either rail. */
  isCancelled(scopedRunId: string): Promise<boolean>;
  /** The run row's status; null when there is none or it cannot be read, which never stops a run. */
  runStatus(scopedRunId: string): Promise<RuntimeRunStatus | null>;
  /** Charge one sub-workflow call to its run tree, once per `callKey`: whether it is within `max`, answered alike each time; throws when it can't be charged. */
  chargeSubWorkflowCall(
    rootRunId: string,
    callKey: string,
    max: number,
    lineage: readonly string[],
  ): Promise<boolean>;
  /** Drop every charge `runId` and the runs it called made in the tree, before it runs again in their place. */
  forgetSubWorkflowCharges(rootRunId: string, runId: string): Promise<void>;
  /** Charge one step to its run tree's root, or answer the limit refusing it: past `maxSteps`, or in flight past `maxActiveSeconds`; throws when it can't be charged. */
  chargeRunStep(
    rootRunId: string,
    maxSteps: number | null,
    maxActiveSeconds: number | null,
  ): Promise<'steps' | 'active_seconds' | null>;
  /** A wait in the run tree rooted at `rootRunId` is about to end, still parked: with nothing else of the tree in flight, its time in flight starts again now; never throws. */
  runTreeResuming(rootRunId: string): Promise<void>;
}

/** A run being admitted, as {@link RunRecorderService.runsAdmitted} records it; `meta.orgId` is its workspace. */
export interface RunAdmission {
  scopedRunId: string;
  runId: string;
  userId: string;
  plan: unknown;
  meta: RunStartMeta;
  limits: DecidedRunLimits | null;
}

const hasCaps = (caps: WorkspaceRunLimits | undefined): caps is WorkspaceRunLimits =>
  caps !== undefined && (caps[WORKSPACE_RUNNING_RUNS] !== null || caps[WORKSPACE_UNFINISHED_RUNS] !== null);

/**
 * Persists run + per-step records. Every write is an UPSERT keyed on the scoped run id (and
 * step_key), because a DBOS crash-recovery re-executes the workflow body from the top. Every write but
 * a run's admission is best-effort — history must never fail a run, so errors are logged and swallowed deliberately.
 */
@Injectable()
export class RunRecorderService implements RunRecorder, OnModuleInit {
  private readonly logger = new Logger(RunRecorderService.name);
  private floor: Promise<Date> | null = null;

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

  /** {@link runStarted} for runs admitted together into one workspace: whether each recorded its run; refuses all, recording none, when it has no room. */
  async runsAdmitted(runs: readonly RunAdmission[]): Promise<boolean[]> {
    const [first] = runs;
    if (!first) return [];
    const workspace = first.meta.orgId ?? null;
    if (runs.some((run) => (run.meta.orgId ?? null) !== workspace || run.userId !== first.userId)) {
      throw new Error('runs admitted together are of one workspace and one caller');
    }
    return this.dataSource.manager.transaction(async (tx) => {
      const recorded: boolean[] = [];
      for (const run of runs) {
        recorded.push(
          await this.insertRun(
            'runAdmitted',
            run.scopedRunId,
            run.runId,
            run.userId,
            run.plan,
            run.meta,
            null,
            false,
            run.limits?.run ?? null,
            tx,
          ),
        );
      }
      const caps = first.limits?.workspace;
      // Counted after the inserts, so an id already holding a run is never counted, and under the lock, so every admission counted before has committed.
      if (recorded.includes(true) && hasCaps(caps)) {
        await tx.query(`SELECT pg_advisory_xact_lock($1, hashtext($2::text))`, [
          RUN_ADMISSION_LOCK_SPACE,
          workspace ?? `user:${first.userId}`,
        ]);
        await assertWorkspaceRoom(tx, workspace, first.userId, caps);
      }
      return recorded;
    });
  }

  /** The workspace a run of `workflowId` started in `orgId` belongs to, as its row will record it. */
  async workspaceOf(workflowId: string | null, orgId: string | null): Promise<string | null> {
    const [row] = await rawQuery<{ org_id: string | null }>(
      this.dataSource.manager,
      `SELECT ${workspaceSql('$1::uuid', '$2::uuid')} AS org_id`,
      [workflowId, orgId],
    );
    return row?.org_id ?? null;
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
    failOpen = true,
    limits: RunLimits | null = null,
    em: EntityManager = this.dataSource.manager,
  ): Promise<boolean> {
    const recorded = await this.write<unknown[]>(
      op,
      scopedRunId,
      [
        `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, plan, status, error, started_at, finished_at, workflow_id, source, environment, environment_id, workflow_version_id, review_id, dry_run, parent_run_id, parent_step_key, org_id, limits)
       VALUES ($1, $2, $3, $4, CAST($5 AS json),
               CASE WHEN $16::text IS NULL THEN 'running' ELSE 'error' END, $16, now(),
               CASE WHEN $16::text IS NULL THEN NULL ELSE now() END,
               $6, $7, $8, $9, $10, $11, $12, $13, $14,
               ${workspaceSql('$6', '$15')}, CAST($18 AS json))
       ON CONFLICT (id) DO UPDATE
          SET plan_id = EXCLUDED.plan_id, plan = EXCLUDED.plan, status = EXCLUDED.status,
              error = EXCLUDED.error, outputs = NULL, started_at = EXCLUDED.started_at,
              finished_at = EXCLUDED.finished_at, workflow_id = EXCLUDED.workflow_id,
              source = EXCLUDED.source, environment = EXCLUDED.environment,
              environment_id = EXCLUDED.environment_id, workflow_version_id = EXCLUDED.workflow_version_id,
              review_id = EXCLUDED.review_id, dry_run = EXCLUDED.dry_run,
              parent_run_id = EXCLUDED.parent_run_id, parent_step_key = EXCLUDED.parent_step_key,
              org_id = EXCLUDED.org_id, limits = EXCLUDED.limits, active_since = NULL
        WHERE runtime_runs.status = 'error' AND starts_with(runtime_runs.error, $17)
          AND COALESCE(json_typeof(runtime_runs.plan), 'null') = 'null'
          AND ${NO_STEP}
       RETURNING id`,
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
          limits ? JSON.stringify(limits) : null,
        ],
      ],
      failOpen,
      em,
    );
    return recorded?.length === 1;
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
    const finished = await this.write<
      [Array<{ kind: string; waiting_topic: string | null; claimed: boolean }>, number]
    >('stepFinished', scopedRunId, [
      `UPDATE runtime_run_steps
          SET status = $3, output = CAST($4 AS json), error = $5, finished_at = now()
        WHERE run_id = $1 AND step_key = $2
        RETURNING kind, waiting_topic, claimed_at IS NOT NULL AS claimed`,
      [scopedRunId, stepKey, error === null ? 'completed' : 'error', cappedJson(output), error],
    ]);
    // A wait or claim still set here lost its resume write; recording it now credits a decision the step took.
    const step = finished?.[0][0];
    if (step && (step.waiting_topic || step.claimed)) {
      const took = step.kind === 'waitForEvent' && error === null && output !== null && output !== undefined;
      await this.stepResumed(scopedRunId, stepKey, took);
    }
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
    durationMs: number,
    deliveryTopic: string | null = null,
    due: Date | null = null,
  ): Promise<Date | null> {
    // The deadline its substrate armed, else the one a park on this topic already keeps, else its step's start plus the window.
    const rows = await this.writeWait<Array<{ due: Date | null }>>('stepWaiting', scopedRunId, (em) =>
      em.query(
        `WITH parked AS (
           UPDATE runtime_run_steps
              SET waiting_since = CASE WHEN waiting_topic = $3 THEN waiting_since ELSE started_at END,
                  waiting_timeout_at = COALESCE($6::timestamptz,
                                                CASE WHEN waiting_topic = $3 THEN waiting_timeout_at
                                                     ELSE started_at + make_interval(secs => $4::double precision / 1000) END),
                  delivery_topic = $5,
                  waiting_topic = $3
            WHERE run_id = $1 AND step_key = $2 AND finished_at IS NULL AND resumed_at IS NULL
            RETURNING waiting_timeout_at
         )
         SELECT COALESCE(
                  (SELECT waiting_timeout_at FROM parked),
                  (SELECT COALESCE($6::timestamptz, started_at + make_interval(secs => $4::double precision / 1000))
                     FROM runtime_run_steps WHERE run_id = $1 AND step_key = $2)
                ) AS due`,
        [scopedRunId, stepKey, topic, durationMs, deliveryTopic, due],
      ),
    );
    return rows?.[0]?.due ?? null;
  }

  async stepResumed(scopedRunId: string, stepKey: string, answered = false): Promise<void> {
    try {
      await this.dataSource.manager.transaction(async (em) => {
        await lockRunRow(em, scopedRunId);
        // Read once under the step's lock, so the step and the run's slot credit the same claim; a replay finds it gone.
        const [claim] = answered
          ? await rawQuery<{ claimed_by: string; claimed_at: Date }>(
              em,
              `SELECT claimed_by, claimed_at FROM runtime_run_steps
                WHERE run_id = $1 AND step_key = $2 AND claimed_by IS NOT NULL FOR NO KEY UPDATE`,
              [scopedRunId, stepKey],
            )
          : [];
        await em.query(
          `UPDATE runtime_run_steps
              SET decided_by = COALESCE($3::uuid, decided_by), decided_at = COALESCE($4::timestamptz, decided_at),
                  ${CLEAR_WAIT}, resumed_at = COALESCE(resumed_at, now())
            WHERE run_id = $1 AND step_key = $2`,
          [scopedRunId, stepKey, claim?.claimed_by ?? null, claim?.claimed_at ?? null],
        );
        await deriveRunWait(em, scopedRunId, claim ? { by: claim.claimed_by, at: claim.claimed_at } : null);
      });
    } catch (err) {
      this.logger.warn(`run history stepResumed failed for ${scopedRunId}: ${errorMessage(err)}`);
    }
  }

  async runFinished(scopedRunId: string, outputs: unknown, error: string | null): Promise<void> {
    // A cancel and a limit's end are final: nothing the run does after either may rewrite it as completed or failed.
    await this.write('runFinished', scopedRunId, [
      `UPDATE runtime_runs
          SET status = $2, outputs = CAST($3 AS json), error = $4, finished_at = now(), ${CLEAR_SLOT}
        WHERE id = $1 AND status <> 'cancelled' AND NOT ${LIMIT_ENDED}`,
      [scopedRunId, error === null ? 'completed' : 'error', cappedOutputsJson(outputs), error],
    ]);
    await this.clearWaits('runFinished', scopedRunId);
  }

  async runUnwoundByCancel(scopedRunId: string, unwindError: string): Promise<void> {
    await this.write('runUnwoundByCancel', scopedRunId, [
      `UPDATE runtime_runs
          SET status = 'cancelled', error = NULL, finished_at = COALESCE(finished_at, now()), ${CLEAR_SLOT}
        WHERE id = $1 AND status <> 'completed' AND NOT ${LIMIT_ENDED}`,
      [scopedRunId],
    ]);
    await this.clearWaits('runUnwoundByCancel', scopedRunId);
    // Only the step that carried this very error: the one the cancel, or a stop for a limit, interrupted.
    await this.write('runUnwoundByCancel', scopedRunId, [
      `UPDATE runtime_run_steps
          SET error = CASE WHEN EXISTS (SELECT 1 FROM runtime_runs WHERE id = $1 AND ${LIMIT_ENDED}) THEN $4 ELSE $3 END
        WHERE run_id = $1 AND error = $2`,
      [scopedRunId, unwindError, CANCELLED_STEP_ERROR, STOPPED_STEP_ERROR],
    ]);
  }

  async isCancelled(scopedRunId: string): Promise<boolean> {
    return (await this.runStatus(scopedRunId)) === 'cancelled';
  }

  async chargeSubWorkflowCall(
    rootRunId: string,
    callKey: string,
    max: number,
    lineage: readonly string[],
  ): Promise<boolean> {
    try {
      return await this.dataSource.manager.transaction(async (em) => {
        await lockRunRow(em, rootRunId);
        const [charge] = await rawQuery<{ allowed: boolean }>(
          em,
          `WITH charged AS (
             INSERT INTO runtime_sub_workflow_charges (root_run_id, call_key, allowed, lineage)
             SELECT $1::varchar, $2::varchar, count(*) < $3::int, $4::varchar[]
               FROM runtime_sub_workflow_charges WHERE root_run_id = $1::varchar AND allowed
             ON CONFLICT (root_run_id, call_key) DO NOTHING
             RETURNING allowed
           )
           SELECT allowed FROM charged
           UNION ALL
           SELECT allowed FROM runtime_sub_workflow_charges WHERE root_run_id = $1::varchar AND call_key = $2::varchar
           LIMIT 1`,
          [rootRunId, callKey, max, lineage],
        );
        return charge!.allowed;
      });
    } catch (err) {
      if (isForeignKeyViolation(err))
        throw new Error(`run ${rootRunId} has no row to charge a sub-workflow call to`);
      throw err;
    }
  }

  async forgetSubWorkflowCharges(rootRunId: string, runId: string): Promise<void> {
    await this.dataSource.manager.transaction(async (em) => {
      await lockRunRow(em, rootRunId);
      await em.query(
        `DELETE FROM runtime_sub_workflow_charges WHERE root_run_id = $1::varchar AND $2::varchar = ANY(lineage)`,
        [rootRunId, runId],
      );
    });
  }

  async chargeRunStep(
    rootRunId: string,
    maxSteps: number | null,
    maxActiveSeconds: number | null,
  ): Promise<'steps' | 'active_seconds' | null> {
    const floor = maxActiveSeconds === null ? null : await this.inFlightFloor();
    const charged = await rawMutateReturning<{ steps_used: number }>(
      this.dataSource.manager,
      `UPDATE runtime_runs r SET steps_used = r.steps_used + 1
        WHERE r.id = $1 AND ($2::int IS NULL OR r.steps_used < $2::int)
          AND ($3::int IS NULL OR ${activeSince('r', '$4')} >= now() - make_interval(secs => $3::int))
        RETURNING r.steps_used`,
      [rootRunId, maxSteps, maxActiveSeconds, floor],
    );
    if (charged.length === 1) return null;
    const [root] = await rawQuery<{ steps_used: number }>(
      this.dataSource.manager,
      `SELECT steps_used FROM runtime_runs WHERE id = $1`,
      [rootRunId],
    );
    // Fails closed, as a sub-workflow charge does: a step its root has no row for is never run uncounted.
    if (!root) throw new Error(`run ${rootRunId} has no row to charge a step to`);
    return maxSteps !== null && root.steps_used >= maxSteps ? 'steps' : 'active_seconds';
  }

  async runTreeResuming(rootRunId: string): Promise<void> {
    try {
      // Under the root's own lock, as every change to a run's waits takes it first.
      await this.dataSource.manager.transaction(async (em) => {
        await lockRunRow(em, rootRunId);
        await em.query(
          `UPDATE runtime_runs r SET active_since = now()
            WHERE r.id = $1 AND r.status IN ('running', 'waiting') AND NOT ${treeInFlight('r')}`,
          [rootRunId],
        );
      });
    } catch (err) {
      // Fails open, as every history write does: the run goes on, its clock unmoved.
      this.logger.warn(`run history runTreeResuming failed for ${rootRunId}: ${errorMessage(err)}`);
    }
  }

  /** This process's start by the database's clock: time in flight never counts from before it, so a restart's downtime never does. */
  inFlightFloor(): Promise<Date> {
    this.floor ??= rawQuery<{ now: Date }>(this.dataSource.manager, 'SELECT now() AS now').then(
      ([row]) => row!.now,
      (err: unknown) => {
        this.floor = null;
        throw err;
      },
    );
    return this.floor;
  }

  onModuleInit(): Promise<unknown> {
    return this.inFlightFloor();
  }

  async runStatus(scopedRunId: string): Promise<RuntimeRunStatus | null> {
    try {
      const rows: Array<{ status: RuntimeRunStatus }> = await this.dataSource.query(
        `SELECT status FROM runtime_runs WHERE id = $1`,
        [scopedRunId],
      );
      return rows[0]?.status ?? null;
    } catch (err) {
      // Fail open: a history read must never stop or fail a run that nobody ended.
      this.logger.warn(`run history runStatus failed for ${scopedRunId}: ${errorMessage(err)}`);
      return null;
    }
  }

  /** The outputs a run's row holds; throws when they can't be read. */
  async runOutputs(scopedRunId: string): Promise<Record<string, unknown>> {
    const [row] = await rawQuery<{ outputs: Record<string, unknown> | null }>(
      this.dataSource.manager,
      `SELECT outputs FROM runtime_runs WHERE id = $1`,
      [scopedRunId],
    );
    return row?.outputs ?? {};
  }

  private async clearWaits(op: string, scopedRunId: string): Promise<void> {
    try {
      await clearStepWaits(this.dataSource.manager, scopedRunId);
    } catch (err) {
      this.logger.warn(`run history ${op} failed for ${scopedRunId}: ${errorMessage(err)}`);
    }
  }

  private async writeWait<T = unknown>(
    op: string,
    scopedRunId: string,
    write: (em: EntityManager) => Promise<T>,
  ): Promise<T | null> {
    try {
      return await withWaitLock(this.dataSource.manager, scopedRunId, write);
    } catch (err) {
      this.logger.warn(`run history ${op} failed for ${scopedRunId}: ${errorMessage(err)}`);
      return null;
    }
  }

  private async write<T = unknown>(
    op: string,
    scopedRunId: string,
    [sql, params]: [string, unknown[]],
    failOpen = true,
    em: EntityManager = this.dataSource.manager,
  ): Promise<T | null> {
    try {
      return await em.query<T>(sql, params);
    } catch (err) {
      if (!failOpen) throw err;
      this.logger.warn(`run history ${op} failed for ${scopedRunId}: ${errorMessage(err)}`);
      return null;
    }
  }
}

/** Take a run's own row lock, which every change to its waits holds; run it first in its transaction. */
export async function lockRunRow(em: EntityManager, scopedRunId: string): Promise<void> {
  await em.query(`SELECT 1 FROM runtime_runs WHERE id = $1 FOR NO KEY UPDATE`, [scopedRunId]);
}

/** Run `write` holding the run's lock, deriving nothing — for a change that parks or unparks no step. */
export function withRunLock<T>(
  manager: EntityManager,
  scopedRunId: string,
  write: (em: EntityManager) => Promise<T>,
): Promise<T> {
  return manager.transaction(async (em) => {
    await lockRunRow(em, scopedRunId);
    return write(em);
  });
}

/** Change a run's step waits under its lock, then re-derive its status (`waiting` while any step is parked) and slot. */
export function withWaitLock<T>(
  manager: EntityManager,
  scopedRunId: string,
  write: (em: EntityManager) => Promise<T>,
): Promise<T> {
  return manager.transaction(async (em) => {
    await lockRunRow(em, scopedRunId);
    const result = await write(em);
    await deriveRunWait(em, scopedRunId);
    return result;
  });
}

// The run's one UPDATE under lockRunRow (row 11): a second would re-check its workflow and environment keys after the run lock.
async function deriveRunWait(
  em: EntityManager,
  scopedRunId: string,
  decision: { by: string; at: Date } | null = null,
): Promise<void> {
  // The slot mirrors the headline wait an older image can answer, and its latest decision: never one received on its own topic.
  await em.query(
    `UPDATE runtime_runs r
          SET status = CASE WHEN EXISTS (
                SELECT 1 FROM runtime_run_steps s WHERE s.run_id = r.id AND ${parkedStep('s')}
              ) THEN 'waiting' ELSE 'running' END,
              (waiting_node_id, waiting_topic, waiting_since, waiting_timeout_at) = (
                SELECT s.node_id, s.waiting_topic, s.waiting_since, s.waiting_timeout_at
                  FROM runtime_run_steps s
                 WHERE s.run_id = r.id AND ${parkedStep('s')} AND s.delivery_topic IS NULL
                 ORDER BY s.waiting_topic LIKE $2 || '%', s.waiting_timeout_at NULLS LAST, s.step_key
                 LIMIT 1
              ),
              decided_by = CASE WHEN r.decided_at > $4::timestamptz THEN r.decided_by ELSE COALESCE($3::uuid, r.decided_by) END,
              decided_at = GREATEST(r.decided_at, $4::timestamptz)
        WHERE r.id = $1 AND r.status IN ('running', 'waiting')`,
    [scopedRunId, TIMER_TOPIC_SQL_PREFIX, decision?.by ?? null, decision?.at ?? null],
  );
}

/** Under {@link lockRunRow}: whether a run that took no step, ended in error or left running with no workflow, runs again from now with `plan` and `limits`; a dry run, or one of another workflow or environment, does not. */
export async function rearmUnstarted(
  em: EntityManager,
  scopedRunId: string,
  plan: unknown,
  meta: RunStartMeta,
  limits: RunLimits | null = null,
): Promise<boolean> {
  // Its workflow and environment keys stay as they are, so the update never reaches either row (row 11).
  const rearmed = await rawMutate(
    em,
    `UPDATE runtime_runs
        SET status = 'running', error = NULL, outputs = NULL, finished_at = NULL, started_at = now(),
            plan_id = $2, plan = CAST($3 AS json), source = $4, environment = $5, workflow_version_id = $6,
            review_id = $7, limits = CAST($10 AS json), active_since = NULL, ${CLEAR_SLOT}
      WHERE id = $1 AND status IN ('error', 'running') AND NOT dry_run AND ${NO_STEP}
        AND workflow_id IS NOT DISTINCT FROM $8 AND environment_id IS NOT DISTINCT FROM $9`,
    [
      scopedRunId,
      planIdOf(plan),
      cappedJson(plan),
      meta.source ?? null,
      meta.environment ?? null,
      meta.workflowVersionId ?? null,
      meta.reviewId ?? null,
      meta.workflowId ?? null,
      meta.environmentId ?? null,
      limits ? JSON.stringify(limits) : null,
    ],
  );
  return rearmed === 1;
}

/** Under {@link lockRunRow}: a run whose workflow was never saved reads as refused, for `reason`, so a resend of its id takes it over. */
export async function refuseUnstarted(em: EntityManager, scopedRunId: string, reason: string): Promise<void> {
  await em.query(
    `UPDATE runtime_runs SET status = 'error', error = $2, plan = NULL, outputs = NULL, finished_at = now(), ${CLEAR_SLOT}
      WHERE id = $1 AND status = 'running' AND ${NO_STEP}`,
    [scopedRunId, `${REFUSED_RUN_ERROR_PREFIX}${reason}`],
  );
}

/** Mark a non-terminal run `cancelled` and unpark its steps; run it holding {@link lockRunRow}. */
export async function recordCancel(em: EntityManager, scopedRunId: string): Promise<void> {
  // The WHERE guard is what stops a cancel racing a natural finish from rewriting the outcome.
  await em.query(
    `UPDATE runtime_runs SET status = 'cancelled', finished_at = now(), ${CLEAR_SLOT}
      WHERE id = $1 AND status IN ('running', 'waiting')`,
    [scopedRunId],
  );
  // A claim stays: the run may already have taken its decision, and only that wait's resume knows.
  await em.query(`UPDATE runtime_run_steps SET ${END_WAIT} WHERE run_id = $1 AND waiting_topic IS NOT NULL`, [
    scopedRunId,
  ]);
}

/** Under {@link lockRunRow}, once a stop is decided there: end the run as an error saying which limit, and unpark its steps. */
export async function recordStop(em: EntityManager, scopedRunId: string, message: string): Promise<void> {
  await em.query(
    `UPDATE runtime_runs SET status = 'error', error = $2, finished_at = now(), ${CLEAR_SLOT}
      WHERE id = $1 AND status IN ('running', 'waiting')`,
    [scopedRunId, message],
  );
  await em.query(`UPDATE runtime_run_steps SET ${END_WAIT} WHERE run_id = $1 AND waiting_topic IS NOT NULL`, [
    scopedRunId,
  ]);
}

/** The runs `scopedRunId` called, and the runs they called, that are still running or waiting. */
export async function descendantsInFlight(em: EntityManager, scopedRunId: string): Promise<string[]> {
  const rows = await rawQuery<{ id: string }>(
    em,
    `WITH RECURSIVE tree AS (
       SELECT id, status FROM runtime_runs WHERE parent_run_id = $1
       UNION ALL
       SELECT r.id, r.status FROM runtime_runs r JOIN tree t ON r.parent_run_id = t.id
     )
     SELECT id FROM tree WHERE status IN ('running', 'waiting')`,
    [scopedRunId],
  );
  return rows.map((row) => row.id);
}

// Under the workspace's admission lock, with the runs just recorded among them: refuse them, rolling the inserts back, past either cap; a run counts as running while a lane of its tree is in flight.
async function assertWorkspaceRoom(
  em: EntityManager,
  workspace: string | null,
  userId: string,
  caps: WorkspaceRunLimits,
): Promise<void> {
  const held = `FROM runtime_runs r
    WHERE r.parent_run_id IS NULL AND r.status IN ('running', 'waiting')
      AND (r.org_id = $1::uuid OR ($1::uuid IS NULL AND r.org_id IS NULL AND r.user_id = $2::uuid))`;
  const [{ unfinished }] = (await rawQuery<{ unfinished: number }>(
    em,
    `SELECT count(*)::int AS unfinished ${held}`,
    [workspace, userId],
  )) as [{ unfinished: number }];
  const running = caps[WORKSPACE_RUNNING_RUNS];
  // Only once there are more unfinished runs than may run is it worth asking which are in flight.
  if (running !== null && unfinished > running) {
    const [{ busy }] = (await rawQuery<{ busy: number }>(
      em,
      `SELECT count(*)::int AS busy FROM (SELECT 1 ${held} AND ${treeInFlight('r')} LIMIT ($3::bigint + 1)) b`,
      [workspace, userId, running],
    )) as [{ busy: number }];
    if (busy > running) throw workspaceRunLimit(WORKSPACE_RUNNING_RUNS, running);
  }
  const most = caps[WORKSPACE_UNFINISHED_RUNS];
  if (most !== null && unfinished > most) throw workspaceRunLimit(WORKSPACE_UNFINISHED_RUNS, most);
}

/** End every wait still set on a run's steps, and any claim on them. */
export async function clearStepWaits(em: EntityManager, scopedRunId: string): Promise<void> {
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
