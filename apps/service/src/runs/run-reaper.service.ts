import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { errorMessage } from '../common/error-message';
import type { EnvConfig } from '../config/env.config';
import { rawMutate } from '../database/raw-query';

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

    // (A) `running` runs older than the max — the worker died without writing an ending.
    const crashedRuns = await rawMutate(
      em,
      `UPDATE runtime_runs
          SET status = 'error', finished_at = now(),
              error = COALESCE(error, 'Run did not complete within the maximum duration — the worker likely crashed, was killed, or was interrupted by a deploy.')
        WHERE status = 'running' AND started_at < ${cutoff}`,
      [seconds],
    );

    // (B) `waiting` HITL runs past their approval window — the decision path already
    //     rejects a late approval, so the run can never resume anyway.
    const timedOutWaits = await rawMutate(
      em,
      `UPDATE runtime_runs
          SET status = 'error', finished_at = now(),
              error = COALESCE(error, 'Approval window expired before a decision was recorded.'),
              waiting_node_id = NULL, waiting_topic = NULL, waiting_since = NULL, waiting_timeout_at = NULL
        WHERE status = 'waiting' AND waiting_timeout_at IS NOT NULL AND waiting_timeout_at < now()`,
      [],
    );

    // (C) orphan steps left `running` past the window — same time rule, no join needed.
    const orphanSteps = await rawMutate(
      em,
      `UPDATE runtime_run_steps
          SET status = 'error', finished_at = now(),
              error = COALESCE(error, 'Step did not complete — the run was reaped.')
        WHERE status = 'running' AND started_at < ${cutoff}`,
      [seconds],
    );

    return { crashedRuns, timedOutWaits, orphanSteps };
  }
}
