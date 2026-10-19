import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { errorMessage } from '../common/error-message';
import type { EnvConfig } from '../config/env.config';
import { rawMutate, rawQuery } from '../database/raw-query';
import { DbosRuntime } from '../dbos/dbos-runtime';
import { CLEAR_SLOT, CLEAR_WAIT, lockRunRow, parkedStep } from '../runtime/run-recorder.service';
import { TIMER_TOPIC_SQL_PREFIX } from '../runtime/timer-wait';

const REAPED_STEP_ERROR = 'Step did not complete — the run was reaped.';

export interface ReapResult {
  crashedRuns: number;
  timedOutWaits: number;
  orphanSteps: number;
  /** Runs holding a decision their workflow can no longer resume to take. */
  strandedDecisions: number;
}

// A run in flight past the max ($1 seconds) lost its worker — counting a `waiting` run nothing is parked on, even in an older image's slot.
function crashedRun(alias: string): string {
  return `${alias}.started_at < now() - ($1 || ' seconds')::interval
    AND (${alias}.status = 'running' OR (${alias}.status = 'waiting' AND ${alias}.waiting_topic IS NULL AND NOT EXISTS (
      SELECT 1 FROM runtime_run_steps p WHERE p.run_id = ${alias}.id AND ${parkedStep('p')}
    )))`;
}

// A wait past its window — a timer's by the max ($1 seconds, timer prefix $2) — with no decision on its way to the run.
function lapsedWait(alias: string): string {
  return `${parkedStep(alias)} AND ${alias}.status = 'running'
    AND ${alias}.waiting_timeout_at < CASE WHEN ${alias}.waiting_topic LIKE $2 || '%'
                                           THEN now() - ($1 || ' seconds')::interval ELSE now() END
    AND NOT EXISTS (SELECT 1 FROM runtime_run_steps c
                     WHERE c.run_id = ${alias}.run_id AND ${parkedStep('c')} AND c.claimed_at IS NOT NULL)`;
}

// A decision on a wait past its window by the max ($1 seconds), which the run has not taken.
function strandedClaim(alias: string): string {
  return `${parkedStep(alias)} AND ${alias}.claimed_at IS NOT NULL
    AND ${alias}.waiting_timeout_at < now() - ($1 || ' seconds')::interval`;
}

/** Moves runs a dead worker left non-terminal to a terminal `error`, and ends a run holding a decision this instance can no longer resume. Idempotent. */
@Injectable()
export class RunReaperService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RunReaperService.name);
  private booting: Promise<void> = Promise.resolve();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    private readonly dbos: DbosRuntime,
  ) {}

  private get maxSeconds(): number {
    return this.config.get('env', { infer: true }).runMaxDurationSeconds;
  }

  onApplicationBootstrap(): void {
    if (this.maxSeconds > 0) this.booting = this.bootReap();
  }

  async onModuleDestroy(): Promise<void> {
    await this.booted();
  }

  /** Settles once the pass started at boot has run. */
  booted(): Promise<void> {
    return this.booting;
  }

  // Serving does not wait on it: every pass is idempotent, and each one that writes a run's row takes that run's lock first.
  private async bootReap(): Promise<void> {
    try {
      const r = await this.reapStale();
      if (r.crashedRuns + r.timedOutWaits + r.orphanSteps + r.strandedDecisions > 0) {
        this.logger.warn(
          `boot reap: ${r.crashedRuns} crashed run(s), ${r.timedOutWaits} timed-out wait(s), ` +
            `${r.orphanSteps} orphan step(s), ${r.strandedDecisions} stranded decision(s) → error ` +
            `(a prior instance likely died mid-run)`,
        );
      }
    } catch (err) {
      // Never take the app down over the reaper — log and serve.
      this.logger.error(`boot reap failed: ${errorMessage(err)}`);
    }
  }

  /** One sweep, returning how many rows were reaped; both callers tolerate a throw (never on a request path). */
  async reapStale(): Promise<ReapResult> {
    const seconds = this.maxSeconds;
    if (seconds <= 0) return { crashedRuns: 0, timedOutWaits: 0, orphanSteps: 0, strandedDecisions: 0 };
    const em = this.dataSource.manager;
    const cutoff = `now() - ($1 || ' seconds')::interval`;

    const crashedRuns = await this.reapCrashedRuns(seconds);

    // (B) a parked wait past its window means nothing will resume the run — unless a decision is on its way to it.
    const timedOutWaits = await this.reapLapsedWaits(seconds);

    // (C) orphan steps left `running` past the window. A step whose run is PARKED is not stale —
    //     the wait step stays `running` for as long as the run is deliberately asleep, and reaping
    //     it would mark a healthy run's step failed while the run itself waits on.
    const orphanSteps = await rawMutate(
      em,
      `UPDATE runtime_run_steps s
          SET status = 'error', finished_at = now(),
              error = COALESCE(s.error, $2)
        WHERE s.status = 'running' AND s.started_at < ${cutoff}
          AND NOT EXISTS (
            SELECT 1 FROM runtime_runs r WHERE r.id = s.run_id AND r.status = 'waiting'
          )`,
      [seconds, REAPED_STEP_ERROR],
    );

    const strandedDecisions = await this.reapStrandedDecisions(seconds);

    return { crashedRuns, timedOutWaits, orphanSteps, strandedDecisions };
  }

  // Each pass that writes a run's row takes one run at a time, its own lock first, as every wait change takes it, and checks the run again once held.
  private async reapCrashedRuns(seconds: number): Promise<number> {
    const em = this.dataSource.manager;
    const crashed = await rawQuery<{ id: string }>(
      em,
      `SELECT r.id FROM runtime_runs r WHERE ${crashedRun('r')} ORDER BY r.id`,
      [seconds],
    );
    let reaped = 0;
    for (const { id } of crashed) {
      reaped += await em.transaction(async (tx) => {
        await lockRunRow(tx, id);
        return reapCrashedRun(tx, id, seconds);
      });
    }
    return reaped;
  }

  private async reapLapsedWaits(seconds: number): Promise<number> {
    const em = this.dataSource.manager;
    const lapsed = await rawQuery<{ id: string }>(
      em,
      `SELECT DISTINCT s.run_id AS id FROM runtime_run_steps s
         JOIN runtime_runs r ON r.id = s.run_id AND r.status = 'waiting'
        WHERE ${lapsedWait('s')}
        ORDER BY id`,
      [seconds, TIMER_TOPIC_SQL_PREFIX],
    );
    let reaped = 0;
    for (const { id } of lapsed) {
      reaped += await em.transaction(async (tx) => {
        await lockRunRow(tx, id);
        return reapLapsedRun(tx, id, seconds);
      });
    }
    return reaped;
  }

  // (D) a decision past its wait's window by the max, on a run this instance can no longer resume: credit it and end the run.
  private async reapStrandedDecisions(seconds: number): Promise<number> {
    const em = this.dataSource.manager;
    const held = await rawQuery<{ id: string }>(
      em,
      `SELECT DISTINCT s.run_id AS id FROM runtime_run_steps s
         JOIN runtime_runs r ON r.id = s.run_id AND r.status = 'waiting'
        WHERE ${strandedClaim('s')}
        ORDER BY id`,
      [seconds],
    );
    const dbosEnabled = this.config.get('env', { infer: true }).dbosEnabled;
    let reaped = 0;
    for (const { id } of held) {
      if (dbosEnabled && (await this.dbos.canResume(id))) continue;
      reaped += await em.transaction(async (tx) => {
        await lockRunRow(tx, id);
        return reapStrandedRun(tx, id, seconds);
      });
    }
    return reaped;
  }
}

function reapCrashedRun(em: EntityManager, runId: string, seconds: number): Promise<number> {
  return rawMutate(
    em,
    `UPDATE runtime_runs r
        SET status = 'error', finished_at = now(),
            error = COALESCE(error, 'Run did not complete within the maximum duration — the worker likely crashed, was killed, or was interrupted by a deploy.')
      WHERE r.id = $2 AND ${crashedRun('r')}`,
    [seconds, runId],
  );
}

async function reapLapsedRun(em: EntityManager, runId: string, seconds: number): Promise<number> {
  const [lapsed] = await rawQuery<{ reason: string }>(
    em,
    `SELECT CASE WHEN s.waiting_topic LIKE $2 || '%'
              THEN 'The run never woke from a scheduled wait — the worker was down when it was due.'
              ELSE 'Approval window expired before a decision was recorded.' END AS reason
       FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id AND r.status = 'waiting'
      WHERE s.run_id = $3 AND ${lapsedWait('s')}
      ORDER BY s.waiting_timeout_at LIMIT 1`,
    [seconds, TIMER_TOPIC_SQL_PREFIX, runId],
  );
  if (!lapsed) return 0;
  await endParkedSteps(em, runId);
  return rawMutate(
    em,
    `UPDATE runtime_runs SET status = 'error', finished_at = now(), error = COALESCE(error, $2), ${CLEAR_SLOT}
      WHERE id = $1 AND status = 'waiting'`,
    [runId, lapsed.reason],
  );
}

async function reapStrandedRun(em: EntityManager, runId: string, seconds: number): Promise<number> {
  const [claim] = await rawQuery<{ claimed_by: string; claimed_at: Date; who: string }>(
    em,
    `SELECT s.claimed_by, s.claimed_at, COALESCE(u.name, u.email, 'someone') AS who
       FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id AND r.status = 'waiting'
       LEFT JOIN users u ON u.id = s.claimed_by
      WHERE s.run_id = $2 AND ${strandedClaim('s')}
      ORDER BY s.claimed_at LIMIT 1`,
    [seconds, runId],
  );
  if (!claim) return 0;
  await endParkedSteps(em, runId);
  return rawMutate(
    em,
    `UPDATE runtime_runs SET status = 'error', finished_at = now(), decided_by = $2, decided_at = $3, error = $4, ${CLEAR_SLOT}
      WHERE id = $1 AND status = 'waiting'`,
    [
      runId,
      claim.claimed_by,
      claim.claimed_at,
      `Decided by ${claim.who}, but the run could not resume to take the decision — run it again`,
    ],
  );
}

// Every wait still parked on the run ends as an errored step.
async function endParkedSteps(em: EntityManager, runId: string): Promise<void> {
  await em.query(
    `UPDATE runtime_run_steps s SET status = 'error', finished_at = now(), error = COALESCE(s.error, $2), ${CLEAR_WAIT}
      WHERE s.run_id = $1 AND ${parkedStep('s')}`,
    [runId, REAPED_STEP_ERROR],
  );
}
