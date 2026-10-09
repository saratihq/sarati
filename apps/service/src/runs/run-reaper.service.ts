import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { errorMessage } from '../common/error-message';
import type { EnvConfig } from '../config/env.config';
import { rawMutate } from '../database/raw-query';
import { TIMER_TOPIC_SQL_PREFIX } from '../runtime/timer-wait';

const REAPED_STEP_ERROR = 'Step did not complete — the run was reaped.';

export interface ReapResult {
  crashedRuns: number;
  timedOutWaits: number;
  orphanSteps: number;
}

/**
 * Moves runs a dead worker left non-terminal to a terminal `error`. Purely time-based, which is what
 * makes it replica-safe: anything in flight past `RUN_MAX_DURATION_SECONDS` cannot be a live run. Idempotent.
 */
@Injectable()
export class RunReaperService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RunReaperService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService<{ env: EnvConfig }, true>,
  ) {}

  private get maxSeconds(): number {
    return this.config.get('env', { infer: true }).runMaxDurationSeconds;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.maxSeconds <= 0) return; // reaper disabled
    try {
      const r = await this.reapStale();
      if (r.crashedRuns + r.timedOutWaits + r.orphanSteps > 0) {
        this.logger.warn(
          `boot reap: ${r.crashedRuns} crashed run(s), ${r.timedOutWaits} timed-out wait(s), ` +
            `${r.orphanSteps} orphan step(s) → error (a prior instance likely died mid-run)`,
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
    if (seconds <= 0) return { crashedRuns: 0, timedOutWaits: 0, orphanSteps: 0 };
    const em = this.dataSource.manager;
    const cutoff = `now() - ($1 || ' seconds')::interval`;

    // (A) a run in flight past the max, counting a `waiting` run with nothing parked, lost its worker.
    const crashedRuns = await rawMutate(
      em,
      `UPDATE runtime_runs r
          SET status = 'error', finished_at = now(),
              error = COALESCE(error, 'Run did not complete within the maximum duration — the worker likely crashed, was killed, or was interrupted by a deploy.')
        WHERE r.started_at < ${cutoff}
          AND (r.status = 'running' OR (r.status = 'waiting' AND NOT EXISTS (
            SELECT 1 FROM runtime_run_steps s WHERE s.run_id = r.id AND s.waiting_topic IS NOT NULL
          )))`,
      [seconds],
    );

    // (B) a parked wait past its window (a timer's: past its wake by the max) means nothing will resume the run.
    const timedOutWaits = await rawMutate(
      em,
      `WITH stale AS (
         SELECT DISTINCT ON (s.run_id) s.run_id,
                CASE WHEN s.waiting_topic LIKE $2 || '%'
                  THEN 'The run never woke from a scheduled wait — the worker was down when it was due.'
                  ELSE 'Approval window expired before a decision was recorded.' END AS reason
           FROM runtime_run_steps s
           JOIN runtime_runs r ON r.id = s.run_id AND r.status = 'waiting'
          WHERE s.status = 'running'
            AND s.waiting_timeout_at < CASE WHEN s.waiting_topic LIKE $2 || '%' THEN ${cutoff} ELSE now() END
          ORDER BY s.run_id, s.waiting_timeout_at
       ), unparked AS (
         UPDATE runtime_run_steps s
            SET status = 'error', finished_at = now(), error = COALESCE(s.error, $3),
                waiting_topic = NULL, waiting_since = NULL, waiting_timeout_at = NULL
           FROM stale WHERE s.run_id = stale.run_id AND s.waiting_topic IS NOT NULL
       )
       UPDATE runtime_runs r
          SET status = 'error', finished_at = now(), error = COALESCE(r.error, stale.reason)
         FROM stale
        WHERE r.id = stale.run_id AND r.status = 'waiting'`,
      [seconds, TIMER_TOPIC_SQL_PREFIX, REAPED_STEP_ERROR],
    );

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

    return { crashedRuns, timedOutWaits, orphanSteps };
  }
}
