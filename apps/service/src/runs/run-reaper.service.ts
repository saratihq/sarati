import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { errorMessage } from '../common/error-message';
import type { EnvConfig } from '../config/env.config';
import { rawMutate, rawQuery } from '../database/raw-query';
import { DbosRuntime } from '../dbos/dbos-runtime';
import { RUN_ACTIVE_SECONDS } from '../entitlements/run-limits';
import {
  CLEAR_CLAIM,
  CLEAR_SLOT,
  CLEAR_WAIT,
  lockRunRow,
  overActiveTime,
  parkedStep,
  RunRecorderService,
} from '../runtime/run-recorder.service';
import { TIMER_TOPIC_SQL_PREFIX } from '../runtime/timer-wait';
import { claimLeads, latestClaim, parkedSteps } from './run-waits';
import { RunsService } from './runs.service';

const REAPED_STEP_ERROR = 'Step did not complete — the run was reaped.';
const INTERRUPTED_RUN_ERROR =
  'The service restarted while this run was going, and nothing can resume it: it ran only inside the service (a dry run, or with DBOS off), its start was never saved to DBOS, or DBOS is off now. Run it again.';

interface LiveCandidate {
  id: string;
  dry_run: boolean;
  parent_run_id: string | null;
}

interface LeftGoing {
  id: string;
  dry_run: boolean;
  /** Its top-level run, or null when a run on its way up has no row. */
  root: string | null;
}

export interface ReapResult {
  /** Live runs stopped for running past the time they were admitted under. */
  stoppedRuns: number;
  crashedRuns: number;
  timedOutWaits: number;
  orphanSteps: number;
  /** Runs holding a decision their workflow can no longer resume to take. */
  strandedDecisions: number;
}

// When a run last went into flight: its start, or the latest of its waits to end, since it flips back to running only as its last wait ends.
function inFlightSince(alias: string): string {
  return `GREATEST(${alias}.started_at, (SELECT max(w.resumed_at) FROM runtime_run_steps w WHERE w.run_id = ${alias}.id))`;
}

// A run in flight past the max ($1 seconds) lost its worker — counting a `waiting` run nothing is parked on, even in an older image's slot.
function crashedRun(alias: string): string {
  return `${inFlightSince(alias)} < now() - ($1 || ' seconds')::interval
    AND (${alias}.status = 'running' OR (${alias}.status = 'waiting' AND ${alias}.waiting_topic IS NULL AND NOT EXISTS (
      SELECT 1 FROM runtime_run_steps p WHERE p.run_id = ${alias}.id AND ${parkedStep('p')}
    )))`;
}

// A run a process before this one ($1 its start) left going.
function leftGoing(alias: string): string {
  return `${alias}.status IN ('running', 'waiting') AND ${alias}.started_at < $1`;
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

/** Stops a run running here past its time, moves runs a dead worker left non-terminal to a terminal `error`, and ends a run holding a decision this instance can no longer resume. Idempotent. */
@Injectable()
export class RunReaperService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RunReaperService.name);
  private booting: Promise<void> = Promise.resolve();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
    private readonly dbos: DbosRuntime,
    private readonly runs: RunsService,
    private readonly recorder: RunRecorderService,
  ) {}

  private get maxSeconds(): number {
    return this.config.get('env', { infer: true }).runMaxDurationSeconds;
  }

  onApplicationBootstrap(): void {
    this.booting = this.bootReap();
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
      const interrupted = await this.endInterruptedRuns();
      const r = await this.reapStale();
      if (
        interrupted + r.stoppedRuns + r.crashedRuns + r.timedOutWaits + r.orphanSteps + r.strandedDecisions >
        0
      ) {
        this.logger.warn(
          `boot reap: ${interrupted} run(s) a restart cut off, ${r.stoppedRuns} run(s) stopped past their time limit, ${r.crashedRuns} crashed run(s), ${r.timedOutWaits} timed-out wait(s), ` +
            `${r.orphanSteps} orphan step(s), ${r.strandedDecisions} stranded decision(s) → error ` +
            `(a prior instance likely died mid-run)`,
        );
      }
    } catch (err) {
      // Never take the app down over the reaper — log and serve.
      this.logger.error(`boot reap failed: ${errorMessage(err)}`);
    }
  }

  /** One sweep, returning how many rows were reaped; both callers tolerate a throw (never on a request path). RUN_MAX_DURATION_SECONDS=0 turns off all but the time stop. */
  async reapStale(signal?: AbortSignal): Promise<ReapResult> {
    const stoppedRuns = await this.stopOverTime(signal);
    const seconds = this.maxSeconds;
    if (seconds <= 0)
      return { stoppedRuns, crashedRuns: 0, timedOutWaits: 0, orphanSteps: 0, strandedDecisions: 0 };
    const em = this.dataSource.manager;
    const cutoff = `now() - ($1 || ' seconds')::interval`;

    const crashedRuns = await this.reapCrashedRuns(seconds, signal);

    // (B) a parked wait past its window means nothing will resume the run — unless a decision is on its way to it.
    const timedOutWaits = await this.reapLapsedWaits(seconds);

    // (C) a step outlives only a run that has ended; a live run's step can span its park.
    const orphanSteps = await rawMutate(
      em,
      `UPDATE runtime_run_steps s
          SET status = 'error', finished_at = now(),
              error = COALESCE(s.error, $2)
        WHERE s.status = 'running' AND s.started_at < ${cutoff}
          AND NOT EXISTS (
            SELECT 1 FROM runtime_runs r WHERE r.id = s.run_id AND r.status IN ('running', 'waiting')
          )`,
      [seconds, REAPED_STEP_ERROR],
    );
    // A claim a cancel left for its wait's resume, on a run ended so long ago that the resume never came.
    await rawMutate(
      em,
      `UPDATE runtime_run_steps s SET ${CLEAR_CLAIM}
         FROM runtime_runs r
        WHERE r.id = s.run_id AND s.claimed_at IS NOT NULL
          AND r.status NOT IN ('running', 'waiting') AND r.finished_at < ${cutoff}`,
      [seconds],
    );

    const strandedDecisions = await this.reapStrandedDecisions(seconds, signal);

    return { stoppedRuns, crashedRuns, timedOutWaits, orphanSteps, strandedDecisions };
  }

  // A live top-level run past the time it was admitted under ends through the one end a cancel takes; one nothing here holds is the crash pass's.
  private async stopOverTime(signal: AbortSignal | undefined): Promise<number> {
    const over = await rawQuery<LiveCandidate & { active_seconds: number }>(
      this.dataSource.manager,
      `SELECT r.id, r.dry_run, r.parent_run_id, (r.limits ->> '${RUN_ACTIVE_SECONDS}')::int AS active_seconds
         FROM runtime_runs r WHERE ${overActiveTime('r', '$1')} ORDER BY r.id`,
      [await this.recorder.inFlightFloor()],
    );
    let stopped = 0;
    for (const run of over) {
      if (signal?.aborted) break;
      if (!(await this.runningHere(run))) continue;
      try {
        if (await this.runs.stopOverTime(run.id, run.active_seconds)) stopped++;
      } catch (err) {
        // DBOS is told first, so a stop DBOS could not be told of records nothing: the next pass tries again.
        this.logger.warn(`run ${run.id}: not stopped past its time limit this pass: ${errorMessage(err)}`);
      }
    }
    return stopped;
  }

  // A run this instance holds or will resume is not crashed, whatever its age; one DBOS cannot be asked about waits for the next pass.
  private async runningHere(run: LiveCandidate): Promise<boolean | null> {
    try {
      return await this.runs.isRunningHere({
        id: run.id,
        dryRun: run.dry_run,
        parentRunId: run.parent_run_id,
      });
    } catch (err) {
      this.logger.warn(
        `run ${run.id}: left to the next reap, as DBOS could not say whether it runs: ${errorMessage(err)}`,
      );
      return null;
    }
  }

  // At boot, whatever RUN_MAX_DURATION_SECONDS says: a run nothing can resume is certainly dead, so it holds no workspace's slot.
  private async endInterruptedRuns(): Promise<number> {
    const em = this.dataSource.manager;
    const floor = await this.recorder.inFlightFloor();
    const left = await rawQuery<LeftGoing>(
      em,
      `WITH RECURSIVE up(id, dry_run, root, parent) AS (
         SELECT r.id, r.dry_run, r.id, r.parent_run_id FROM runtime_runs r WHERE ${leftGoing('r')}
         UNION ALL
         SELECT up.id, up.dry_run, p.id, p.parent_run_id
           FROM up LEFT JOIN runtime_runs p ON p.id = up.parent WHERE up.parent IS NOT NULL
       )
       SELECT id, dry_run, root FROM up WHERE parent IS NULL ORDER BY id`,
      [floor],
    );
    let ended = 0;
    for (const run of left) {
      if (!(await this.resumesNowhere(run))) continue;
      ended += await em.transaction(async (tx) => {
        await lockRunRow(tx, run.id);
        return endInterruptedRun(tx, run.id, floor);
      });
    }
    return ended;
  }

  // Nothing resumes a dry run, any run while DBOS is off, or a run whose top-level run DBOS holds no workflow for; one whose top-level run is unknown, or DBOS can't be asked about, is left.
  private async resumesNowhere(run: LeftGoing): Promise<boolean> {
    if (run.dry_run || !this.config.get('env', { infer: true }).dbosEnabled) return true;
    if (run.root === null) return false;
    try {
      return !(await this.dbos.holdsWorkflow(run.root));
    } catch (err) {
      this.logger.warn(
        `run ${run.id}: left going, as DBOS could not say whether it holds its tree: ${errorMessage(err)}`,
      );
      return false;
    }
  }

  // Each pass that writes a run's row takes one run at a time, its own lock first, as every wait change takes it, and checks the run again once held.
  private async reapCrashedRuns(seconds: number, signal: AbortSignal | undefined): Promise<number> {
    const em = this.dataSource.manager;
    const crashed = await rawQuery<LiveCandidate>(
      em,
      `SELECT r.id, r.dry_run, r.parent_run_id FROM runtime_runs r WHERE ${crashedRun('r')} ORDER BY r.id`,
      [seconds],
    );
    let reaped = 0;
    for (const run of crashed) {
      if (signal?.aborted) break;
      if ((await this.runningHere(run)) !== false) continue;
      const { id } = run;
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
  private async reapStrandedDecisions(seconds: number, signal: AbortSignal | undefined): Promise<number> {
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
      // A stop leaves the rest to the next boot's reap rather than ask a DBOS about to stop.
      if (signal?.aborted) break;
      if (dbosEnabled && (await this.dbos.canResume(id))) continue;
      reaped += await em.transaction(async (tx) => {
        await lockRunRow(tx, id);
        return reapStrandedRun(tx, id, seconds);
      });
    }
    return reaped;
  }
}

// A decision on its way to the run is credited, as every end that can't take one credits it.
async function endInterruptedRun(em: EntityManager, runId: string, floor: Date): Promise<number> {
  const leads = claimLeads((await parkedSteps(em, runId)).filter((s) => s.claimedAt !== null));
  const latest = latestClaim(leads);
  const ended = await rawMutate(
    em,
    `UPDATE runtime_runs r
        SET status = 'error', finished_at = now(), error = $3, ${CLEAR_SLOT},
            decided_by = CASE WHEN $4::uuid IS NULL OR r.decided_at > $5::timestamptz THEN r.decided_by ELSE $4::uuid END,
            decided_at = GREATEST(r.decided_at, $5::timestamptz)
      WHERE r.id = $2 AND ${leftGoing('r')}`,
    [floor, runId, INTERRUPTED_RUN_ERROR, latest?.claimedBy ?? null, latest?.claimedAt ?? null],
  );
  if (ended === 0) return 0;
  await endParkedSteps(
    em,
    runId,
    leads.map((s) => s.stepKey),
  );
  await em.query(
    `UPDATE runtime_run_steps SET status = 'error', finished_at = now(), error = COALESCE(error, $2), ${CLEAR_WAIT}
      WHERE run_id = $1 AND finished_at IS NULL`,
    [runId, REAPED_STEP_ERROR],
  );
  return ended;
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
  await endParkedSteps(em, runId, []);
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
      ORDER BY s.claimed_at DESC LIMIT 1`,
    [seconds, runId],
  );
  if (!claim) return 0;
  const claimed = (await parkedSteps(em, runId)).filter((s) => s.claimedAt !== null);
  await endParkedSteps(
    em,
    runId,
    claimLeads(claimed).map((s) => s.stepKey),
  );
  return rawMutate(
    em,
    `UPDATE runtime_runs
        SET status = 'error', finished_at = now(), error = $4, ${CLEAR_SLOT},
            decided_by = CASE WHEN decided_at > $3::timestamptz THEN decided_by ELSE $2::uuid END,
            decided_at = GREATEST(decided_at, $3::timestamptz)
      WHERE id = $1 AND status = 'waiting'`,
    [
      runId,
      claim.claimed_by,
      claim.claimed_at,
      `Decided by ${claim.who}, but the run could not resume to take the decision — run it again`,
    ],
  );
}

// Every wait still parked on the run ends as an errored step; one decision credits only the wait that leads its receive.
async function endParkedSteps(em: EntityManager, runId: string, credited: string[]): Promise<void> {
  await em.query(
    `UPDATE runtime_run_steps s
        SET status = 'error', finished_at = now(), error = COALESCE(s.error, $2),
            decided_by = CASE WHEN s.step_key = ANY($3) THEN s.claimed_by END,
            decided_at = CASE WHEN s.step_key = ANY($3) THEN s.claimed_at END, ${CLEAR_WAIT}
      WHERE s.run_id = $1 AND ${parkedStep('s')}`,
    [runId, REAPED_STEP_ERROR, credited],
  );
}
