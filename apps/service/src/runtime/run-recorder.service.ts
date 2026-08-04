import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { errorMessage } from '../common/error-message';
import { newId } from '../database/ids';
import type { RunSource, RuntimeStepKind } from '../database/entities/runtime-run.entity';

/** Outputs larger than this are stored as a truncation marker, not dropped. */
const MAX_STORED_JSON_CHARS = 16_000;

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
  /** The review this run tested (source='review_test', ADR 0015); else null. */
  reviewId?: string | null;
  /** Dry run (preview): no state-changing external call fired (ADR 0041). */
  dryRun?: boolean;
}

/**
 * The interpreter's run-history recording seam — an interface so the interpreter stays free of
 * Nest/TypeORM. `runWaiting`/`runResumed` bracket a `waitForEvent` pause, and that persisted state
 * is what the waiting list and event-delivery validation read.
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
  /** Flag an errored step as tolerated (continue-on-fail, ADR 0020) — the run went on. */
  stepContinued(scopedRunId: string, stepKey: string): Promise<void>;
  /** Record how many attempts a step took (retry-on-fail, ADR 0020); 1 unless retried. */
  stepAttempts(scopedRunId: string, stepKey: string, attempts: number): Promise<void>;
  /** Record a step's non-fatal honesty warnings (e.g. a `{{ref}}` that resolved to nothing); never fails it. */
  stepWarnings(scopedRunId: string, stepKey: string, warnings: string[]): Promise<void>;
  runWaiting(scopedRunId: string, nodeId: string, topic: string, timeoutAt: Date): Promise<void>;
  runResumed(scopedRunId: string): Promise<void>;
  runFinished(scopedRunId: string, outputs: unknown, error: string | null): Promise<void>;
  /** Mark a non-terminal run `cancelled` (user cancel, B7). No-op if already terminal. */
  runCancelled(scopedRunId: string): Promise<void>;
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

  async runStarted(
    scopedRunId: string,
    runId: string,
    userId: string,
    plan: unknown,
    meta?: RunStartMeta,
  ): Promise<void> {
    await this.write('runStarted', scopedRunId, [
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, plan, status, started_at, workflow_id, source, environment, environment_id, workflow_version_id, review_id, dry_run)
       VALUES ($1, $2, $3, $4, CAST($5 AS json), 'running', now(), $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO NOTHING`,
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
    // `pinned` marks a REPLAYED step (ADR 0021) — set on both the insert and the crash-replay
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

  /** Park the record on a waitForEvent: the waiting list + event validation read this state. */
  async runWaiting(scopedRunId: string, nodeId: string, topic: string, timeoutAt: Date): Promise<void> {
    await this.write('runWaiting', scopedRunId, [
      `UPDATE runtime_runs
          SET status = 'waiting', waiting_node_id = $2, waiting_topic = $3,
              waiting_since = now(), waiting_timeout_at = $4
        WHERE id = $1 AND status = 'running'`,
      [scopedRunId, nodeId, topic, timeoutAt],
    ]);
  }

  /** The wait resolved (event or timeout) — back to running, waiting state cleared. */
  async runResumed(scopedRunId: string): Promise<void> {
    await this.write('runResumed', scopedRunId, [
      `UPDATE runtime_runs
          SET status = 'running', waiting_node_id = NULL, waiting_topic = NULL,
              waiting_since = NULL, waiting_timeout_at = NULL
        WHERE id = $1 AND status = 'waiting'`,
      [scopedRunId],
    ]);
  }

  async runFinished(scopedRunId: string, outputs: unknown, error: string | null): Promise<void> {
    await this.write('runFinished', scopedRunId, [
      `UPDATE runtime_runs
          SET status = $2, outputs = CAST($3 AS json), error = $4, finished_at = now(),
              waiting_node_id = NULL, waiting_topic = NULL, waiting_since = NULL, waiting_timeout_at = NULL
        WHERE id = $1`,
      [scopedRunId, error === null ? 'completed' : 'error', cappedJson(outputs), error],
    ]);
  }

  async runCancelled(scopedRunId: string): Promise<void> {
    // The WHERE guard is what stops a cancel racing a natural finish from rewriting the outcome.
    await this.write('runCancelled', scopedRunId, [
      `UPDATE runtime_runs
          SET status = 'cancelled', finished_at = now(),
              waiting_node_id = NULL, waiting_topic = NULL, waiting_since = NULL, waiting_timeout_at = NULL
        WHERE id = $1 AND status IN ('running', 'waiting')`,
      [scopedRunId],
    ]);
  }

  private async write(op: string, scopedRunId: string, [sql, params]: [string, unknown[]]): Promise<void> {
    try {
      await this.dataSource.query(sql, params);
    } catch (err) {
      this.logger.warn(`run history ${op} failed for ${scopedRunId}: ${errorMessage(err)}`);
    }
  }
}

function planIdOf(plan: unknown): string {
  const id = plan !== null && typeof plan === 'object' ? (plan as { id?: unknown }).id : undefined;
  return (typeof id === 'string' && id ? id : 'plan').slice(0, 200);
}

/** JSON for storage, size-capped — an oversized payload becomes a marker, never a failed write. */
function cappedJson(value: unknown): string {
  const raw = JSON.stringify(value ?? null);
  if (raw === undefined) return 'null';
  if (raw.length <= MAX_STORED_JSON_CHARS) return raw;
  return JSON.stringify({ truncated: true, size_chars: raw.length });
}
