import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { Pool } from 'pg';
import type { DataSource, EntityManager } from 'typeorm';

import { errorMessage } from '../common/error-message';
import type { EnvConfig } from '../config/env.config';
import { rawMutateReturning } from '../database/raw-query';
import type { RuntimeStepKind } from '../database/entities/runtime-run.entity';
import { NOT_RESUMED_STEP_ERROR } from '../runs/run-failure';
import { claimLeads, parkedSteps } from '../runs/run-waits';
import type { DagPlan } from '../runtime/dag-plan';
import {
  MODEL_TURN,
  verdict,
  type CheckpointedRun,
  type NotResumableCause,
  type RecordedOp,
  type RecordedStep,
  type Resumability,
} from '../runtime/recovery-exposure';
import { CLEAR_SLOT, CLEAR_WAIT, lockRunRow } from '../runtime/run-recorder.service';
import { RUN_PLAN_WORKFLOW } from './run-plan-workflow';
import { systemDatabaseUrlOf } from './system-db-url';

/** What a run the legacy engine can't resume says, by why, wherever it is read. */
export const NOT_RESUMABLE: Readonly<Record<NotResumableCause, string>> = {
  'side-by-side':
    "This run had already run steps side by side when it stopped, so it can't be resumed safely — run it again.",
  'refused-call':
    "This run's AI Agent step was refused a sub-workflow call before it stopped, so it can't be resumed safely — run it again.",
  unmatched:
    "This run's history can't be matched to its workflow, so it can't be resumed safely — run it again.",
};

/** Ends a recovered legacy run whose replay would not repeat what it recorded. */
export class RunNotResumable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunNotResumable';
  }
}

/** One SQL read, answering its rows. */
export type Sql = (text: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;

/** Runs `read` over the app database, in a transaction where the caller keeps one. */
export type AppReads = <T>(read: (app: Sql) => Promise<T>) => Promise<T>;

const ENDED: ReadonlySet<unknown> = new Set(['completed', 'error', 'cancelled']);

/** Every op a run recorded, in order, each output decoded by DBOS itself, as its replay decodes it. */
export async function recordedOps(client: DBOSClient, scopedRunId: string): Promise<RecordedOp[]> {
  return ((await client.listWorkflowSteps(scopedRunId)) ?? []).map((step): RecordedOp => {
    const failed = step.error !== null;
    const op: RecordedOp = { name: step.name, output: step.output, failed };
    return MODEL_TURN.test(step.name) ? { ...op, toolCalls: failed ? [] : toolCallsOf(step.output) } : op;
  });
}

/** The guard's verdict on a run: its ops read first and alone, then, only when it recorded any, its rows in the app database. */
export async function readResumability(
  appReads: AppReads,
  opsOf: (scopedRunId: string) => Promise<RecordedOp[]>,
  scopedRunId: string,
  run: CheckpointedRun,
): Promise<Resumability> {
  const ops = await opsOf(scopedRunId);
  if (ops.length === 0) return verdict(run, ops, null);
  const steps = await appReads(async (app) => {
    if ((await app(`SELECT 1 FROM runtime_runs WHERE id = $1`, [scopedRunId])).length === 0) return null;
    const found = await app(`SELECT step_key, kind, pinned FROM runtime_run_steps WHERE run_id = $1`, [
      scopedRunId,
    ]);
    return found.map((row): RecordedStep => ({
      stepKey: row.step_key as string,
      kind: row.kind as RuntimeStepKind,
      pinned: row.pinned === true,
    }));
  });
  return verdict(run, ops, steps);
}

// The tool calls a model turn's decoded output asks for, ids and names only; `null` when it can't be read.
function toolCallsOf(turn: unknown): RecordedOp['toolCalls'] {
  const calls = (turn as { toolCalls?: unknown } | null)?.toolCalls;
  if (!Array.isArray(calls)) return null;
  const read: Array<{ id: string; name: string }> = [];
  for (const call of calls as Array<{ id?: unknown; name?: unknown } | null>) {
    if (typeof call?.id !== 'string' || typeof call.name !== 'string') return null;
    read.push({ id: call.id, name: call.name });
  }
  return read;
}

/** What a legacy workflow checkpointed as its first argument: its plan, its pins and the scope it began with. */
export function checkpointedRun(input: unknown): CheckpointedRun {
  const args = Array.isArray(input)
    ? (input[0] as
        | { plan?: DagPlan; pins?: Record<string, unknown>; initialScope?: Record<string, unknown> }
        | undefined)
    : undefined;
  if (!args?.plan) throw new Error('the workflow checkpointed no plan');
  return { plan: args.plan, pins: args.pins ?? {}, initialScope: args.initialScope ?? {} };
}

/** The runs the legacy engine has in flight, each with what it checkpointed, read from outside any workflow. */
export async function pendingLegacyRuns(
  client: DBOSClient,
): Promise<Array<{ runId: string; run: CheckpointedRun }>> {
  const pending = await client.listWorkflows({
    workflowName: RUN_PLAN_WORKFLOW,
    status: 'PENDING',
    loadInput: true,
  });
  return pending.map((workflow) => ({ runId: workflow.workflowID, run: checkpointedRun(workflow.input) }));
}

/** Whether the run's row has already ended, which stops its workflow before the guard judges it. */
export async function alreadyEnded(app: Sql, scopedRunId: string): Promise<boolean> {
  const [row] = await app(`SELECT status FROM runtime_runs WHERE id = $1`, [scopedRunId]);
  return ENDED.has(row?.status);
}

// Before DBOS first launches, its database or schema doesn't exist yet, and so no run is in flight.
function noneBeforeFirstLaunch(err: unknown): never[] {
  const code = (err as { code?: unknown }).code;
  if (code === '3D000' || code === '42P01') return [];
  throw err;
}

// A held lock answers as an error the retry waits out, rather than holding the run's recovery up unseen.
const LOCK_TIMEOUT_MS = 1_000;
const FIRST_RETRY_MS = 100;
const LAST_RETRY_MS = 5_000;
const ATTEMPTS = 40;

/**
 * Stops a run the legacy engine recovers before it issues any op, when its replay would not repeat what it recorded;
 * reads and writes that fail wait and try again, so a database hiccup never lets such a run through.
 */
@Injectable()
export class RecoveryGuard implements OnModuleDestroy {
  private readonly logger = new Logger(RecoveryGuard.name);
  private readonly systemUrl: string;
  private client?: Promise<DBOSClient>;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService<{ env: EnvConfig }, true>,
  ) {
    this.systemUrl = systemDatabaseUrlOf(config.get('env', { infer: true }));
  }

  /** Let a run go on only if it can resume, else end it and throw {@link RunNotResumable}; `recheck` stops it between tries once its row ended. */
  async admit(scopedRunId: string, run: CheckpointedRun, recheck: () => Promise<void>): Promise<void> {
    const judged = await this.retrying(`read the history of run ${scopedRunId}`, recheck, () =>
      this.resumability(scopedRunId, run),
    );
    if (judged.resumable) return;
    this.logger.warn(`Run ${scopedRunId} can't be resumed: ${judged.reason}`);
    const message = NOT_RESUMABLE[judged.cause];
    const ended = await this.retrying(`end run ${scopedRunId}`, recheck, () =>
      this.dataSource.transaction(async (em) => {
        await em.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
        return endNotResumable(em, scopedRunId, message);
      }),
    );
    if (!ended) await recheck();
    throw new RunNotResumable(message);
  }

  /** How many runs the legacy engine has in flight would resume, would fail, or had already ended, as of now. */
  async legacyRuns(): Promise<{ resume: number; fail: number; ended: number }> {
    const counts = { resume: 0, fail: 0, ended: 0 };
    for (const { runId, run } of await pendingLegacyRuns(await this.history()).catch(noneBeforeFirstLaunch)) {
      if (await alreadyEnded((text, params) => this.dataSource.query(text, params), runId)) counts.ended += 1;
      else counts[(await this.resumability(runId, run)).resumable ? 'resume' : 'fail'] += 1;
    }
    return counts;
  }

  async onModuleDestroy(): Promise<void> {
    await (await this.client)?.destroy();
  }

  // The DBOS read runs on its own; an app transaction opens only for the run's rows, so none sits idle meanwhile.
  private resumability(scopedRunId: string, run: CheckpointedRun): Promise<Resumability> {
    return readResumability(
      (read) =>
        this.dataSource.transaction(async (em) => {
          await em.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
          return read((text, params) => em.query(text, params));
        }),
      async (id) => recordedOps(await this.history(), id),
      scopedRunId,
      run,
    );
  }

  // One client over the guard's own pool, so every history read runs under its lock timeout.
  private history(): Promise<DBOSClient> {
    if (!this.client) {
      const pool = new Pool({
        connectionString: this.systemUrl,
        max: 2,
        application_name: 'sarati-recovery-guard',
        options: `-c lock_timeout=${LOCK_TIMEOUT_MS}`,
      });
      // An idle connection the database ends is dropped from the pool; unheard, it would end the process.
      pool.on('error', (err) =>
        this.logger.warn(`The recovery guard lost a connection: ${errorMessage(err)}`),
      );
      this.client = DBOSClient.create({ systemDatabaseUrl: this.systemUrl, systemDatabasePool: pool });
    }
    return this.client;
  }

  private async retrying<T>(
    what: string,
    recheck: () => Promise<void>,
    attempt: () => Promise<T>,
  ): Promise<T> {
    let delay = FIRST_RETRY_MS;
    for (let tried = 1; ; tried++) {
      try {
        return await attempt();
      } catch (err) {
        if (tried === ATTEMPTS)
          throw new Error(`Couldn't ${what} in ${ATTEMPTS} tries: ${errorMessage(err)}`);
        this.logger.warn(`Couldn't ${what} (${errorMessage(err)}); trying again`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, LAST_RETRY_MS);
        await recheck();
      }
    }
  }
}

// End the run holding its lock, crediting each claimed wait and the run with its decider as the reaper does, and each step
// still under way with a stop of its own; false if it had ended.
async function endNotResumable(em: EntityManager, scopedRunId: string, message: string): Promise<boolean> {
  await lockRunRow(em, scopedRunId);
  const leads = claimLeads((await parkedSteps(em, scopedRunId)).filter((s) => s.claimedAt !== null));
  const latest = leads.reduce<(typeof leads)[number] | undefined>(
    (last, lead) => (last && last.claimedAt! >= lead.claimedAt! ? last : lead),
    undefined,
  );
  const ended = await rawMutateReturning(
    em,
    `UPDATE runtime_runs
        SET status = 'error', error = $2, finished_at = now(), ${CLEAR_SLOT},
            decided_by = CASE WHEN $3::uuid IS NULL OR decided_at > $4::timestamptz THEN decided_by ELSE $3::uuid END,
            decided_at = GREATEST(decided_at, $4::timestamptz)
      WHERE id = $1 AND status IN ('running', 'waiting')
      RETURNING id`,
    [scopedRunId, message, latest?.claimedBy ?? null, latest?.claimedAt ?? null],
  );
  if (ended.length === 0) return false;
  await em.query(
    `UPDATE runtime_run_steps
        SET decided_by = CASE WHEN step_key = ANY($2) THEN claimed_by ELSE decided_by END,
            decided_at = CASE WHEN step_key = ANY($2) THEN claimed_at ELSE decided_at END,
            error = CASE WHEN status = 'running' THEN $3 ELSE error END,
            finished_at = CASE WHEN status = 'running' THEN now() ELSE finished_at END,
            status = CASE WHEN status = 'running' THEN 'error' ELSE status END,
            ${CLEAR_WAIT}
      WHERE run_id = $1 AND (status = 'running' OR waiting_topic IS NOT NULL OR claimed_at IS NOT NULL)`,
    [scopedRunId, leads.map((lead) => lead.stepKey), NOT_RESUMED_STEP_ERROR],
  );
  return true;
}
