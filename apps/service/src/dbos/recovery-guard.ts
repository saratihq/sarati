import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { Pool } from 'pg';
import type { DataSource } from 'typeorm';

import { errorMessage } from '../common/error-message';
import type { EnvConfig } from '../config/env.config';
import type { RuntimeStepKind } from '../database/entities/runtime-run.entity';
import type { DagPlan } from '../runtime/dag-plan';
import {
  MODEL_TURN,
  resumability,
  type NotResumableCause,
  type RecordedOp,
  type Resumability,
} from '../runtime/recovery-exposure';
import { lockRunRow, recordNotResumable } from '../runtime/run-recorder.service';
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

/** A run's resumability from what it recorded in the app database and the DBOS system database; one with ops but no run row can't resume. */
export async function readResumability(
  app: Sql,
  system: Sql,
  scopedRunId: string,
  plan: DagPlan,
): Promise<Resumability> {
  const ops = await system(
    `SELECT function_name, CASE WHEN function_name ~ $2 THEN output END AS output, error IS NOT NULL AS failed
       FROM dbos.operation_outputs WHERE workflow_uuid = $1 ORDER BY function_id`,
    [scopedRunId, MODEL_TURN.source],
  );
  // With no op recorded, entering replays nothing: a fresh start, or a run caught before its first op.
  if (ops.length === 0) return { resumable: true };
  if ((await app(`SELECT 1 FROM runtime_runs WHERE id = $1`, [scopedRunId])).length === 0) {
    return { resumable: false, cause: 'unmatched', reason: 'it has no run row' };
  }
  const steps = await app(`SELECT step_key, kind, pinned FROM runtime_run_steps WHERE run_id = $1`, [
    scopedRunId,
  ]);
  return resumability(plan, {
    steps: steps.map((row) => ({
      stepKey: row.step_key as string,
      kind: row.kind as RuntimeStepKind,
      pinned: row.pinned === true,
    })),
    ops: ops.map((row) => {
      const name = row.function_name as string;
      if (!MODEL_TURN.test(name)) return { name };
      return { name, toolCalls: row.failed === true ? [] : toolCallsOf(row.output) };
    }),
  });
}

// The tool calls a model turn's checkpointed output asks for, ids and names only; `null` when it can't be read.
function toolCallsOf(output: unknown): RecordedOp['toolCalls'] {
  let turn: unknown;
  try {
    const stored = JSON.parse(String(output)) as { __dbos_serializer?: unknown; json?: unknown } | null;
    turn = stored?.__dbos_serializer === 'superjson' ? stored.json : stored;
  } catch {
    return null;
  }
  const calls = (turn as { toolCalls?: unknown } | null)?.toolCalls;
  if (!Array.isArray(calls)) return null;
  const read: Array<{ id: string; name: string }> = [];
  for (const call of calls as Array<{ id?: unknown; name?: unknown } | null>) {
    if (typeof call?.id !== 'string' || typeof call.name !== 'string') return null;
    read.push({ id: call.id, name: call.name });
  }
  return read;
}

/** The plan a legacy workflow checkpointed as its first argument. */
export function checkpointedPlan(input: unknown): DagPlan {
  const plan = Array.isArray(input) ? (input[0] as { plan?: DagPlan } | undefined)?.plan : undefined;
  if (!plan) throw new Error('the workflow checkpointed no plan');
  return plan;
}

/** The runs the legacy engine has in flight, each with the plan it checkpointed, read from outside any workflow. */
export async function pendingLegacyRuns(
  systemDatabaseUrl: string,
): Promise<Array<{ runId: string; plan: DagPlan }>> {
  const client = await DBOSClient.create({ systemDatabaseUrl });
  try {
    const pending = await client.listWorkflows({
      workflowName: RUN_PLAN_WORKFLOW,
      status: 'PENDING',
      loadInput: true,
    });
    return pending.map((workflow) => ({
      runId: workflow.workflowID,
      plan: checkpointedPlan(workflow.input),
    }));
  } finally {
    await client.destroy();
  }
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

/**
 * Stops a run the legacy engine recovers before it issues any op, when its history shows a step that ran beside
 * another; reads and writes that fail wait and try again, so a database hiccup never lets such a run through.
 */
@Injectable()
export class RecoveryGuard implements OnModuleDestroy {
  private readonly logger = new Logger(RecoveryGuard.name);
  private readonly systemUrl: string;
  private pool?: Pool;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService<{ env: EnvConfig }, true>,
  ) {
    this.systemUrl = systemDatabaseUrlOf(config.get('env', { infer: true }));
  }

  /** Let a run go on only if it can resume; otherwise end it in error and throw {@link RunNotResumable}. */
  async admit(scopedRunId: string, plan: DagPlan): Promise<void> {
    const verdict = await this.retrying(`read the history of run ${scopedRunId}`, () =>
      this.resumability(scopedRunId, plan),
    );
    if (verdict.resumable) return;
    this.logger.warn(`Run ${scopedRunId} can't be resumed: ${verdict.reason}`);
    await this.retrying(`end run ${scopedRunId}`, () =>
      this.dataSource.transaction(async (em) => {
        await em.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
        await lockRunRow(em, scopedRunId);
        await recordNotResumable(em, scopedRunId, NOT_RESUMABLE[verdict.cause]);
      }),
    );
    throw new RunNotResumable(NOT_RESUMABLE[verdict.cause]);
  }

  /** How many runs the legacy engine has in flight would resume and how many would fail, as of now. */
  async legacyRuns(): Promise<{ resume: number; fail: number }> {
    const counts = { resume: 0, fail: 0 };
    for (const { runId, plan } of await pendingLegacyRuns(this.systemUrl).catch(noneBeforeFirstLaunch)) {
      counts[(await this.resumability(runId, plan)).resumable ? 'resume' : 'fail'] += 1;
    }
    return counts;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  private resumability(scopedRunId: string, plan: DagPlan): Promise<Resumability> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
      return readResumability(
        (text, params) => em.query(text, params),
        (text, params) => this.system(text, params),
        scopedRunId,
        plan,
      );
    });
  }

  private async system(text: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
    this.pool ??= new Pool({
      connectionString: this.systemUrl,
      max: 2,
      options: `-c lock_timeout=${LOCK_TIMEOUT_MS}`,
    });
    return (await this.pool.query<Record<string, unknown>>(text, params)).rows;
  }

  private async retrying<T>(what: string, attempt: () => Promise<T>): Promise<T> {
    for (let delay = FIRST_RETRY_MS; ; delay = Math.min(delay * 2, LAST_RETRY_MS)) {
      try {
        return await attempt();
      } catch (err) {
        this.logger.warn(`Couldn't ${what} (${errorMessage(err)}); trying again`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
