import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EnvConfig } from '../config/env.config';
import {
  RUN_ACTIVE_SECONDS,
  RUN_LIMITS,
  RUN_LIMIT_MAX,
  RUN_LOOP_ROUNDS,
  RUN_STEPS,
  WORKSPACE_RUNNING_RUNS,
  WORKSPACE_UNFINISHED_RUNS,
  type DecidedRunLimits,
  type RunLimitMetric,
} from './run-limits';

/** The plans seam: the run budget's numbers are asked here, so core never learns about plans or billing. */
export interface EntitlementsProvider {
  /** Feature gate: may this org use `feature` at all? */
  allows(orgId: string, feature: string): Promise<boolean>;
  /** Numeric limit for a metric in a workspace (null for a run with none), or null = unlimited. */
  limitFor(orgId: string | null, metric: string): Promise<number | null>;
}

export const ENTITLEMENTS_PROVIDER = Symbol('ENTITLEMENTS_PROVIDER');

const isRunLimitMetric = (metric: string): metric is RunLimitMetric => Object.hasOwn(RUN_LIMITS, metric);

/** The open core's answer: every feature allowed, each run-budget metric from its operator variable, and nothing else limited. */
@Injectable()
export class OpenCoreEntitlements implements EntitlementsProvider {
  constructor(private readonly config: ConfigService<{ env: EnvConfig }, true>) {}

  allows(): Promise<boolean> {
    return Promise.resolve(true);
  }

  limitFor(_orgId: string | null, metric: string): Promise<number | null> {
    if (!isRunLimitMetric(metric)) return Promise.resolve(null);
    const value = this.config.get('env', { infer: true }).runLimits[metric];
    return Promise.resolve(value > 0 ? value : null);
  }
}

// A provider's answer as a run can keep it: a whole number from 0, held to the most a run's row can count; anything else fails the admission.
function keptAnswer(metric: RunLimitMetric, answer: number | null): number | null {
  if (answer === null) return null;
  if (!Number.isInteger(answer) || answer < 0) {
    throw new Error(
      `the entitlements provider answered ${metric} with ${String(answer)}, not null or a whole number from 0`,
    );
  }
  return Math.min(answer, RUN_LIMIT_MAX);
}

/** The one place the seam is asked a run's limits, for its workspace (null for a run with none), once as it is admitted or tested. */
export async function decideRunLimits(
  provider: EntitlementsProvider,
  workspace: string | null,
): Promise<DecidedRunLimits> {
  const ask = async (metric: RunLimitMetric): Promise<number | null> =>
    keptAnswer(metric, await provider.limitFor(workspace, metric));
  const [steps, loopRounds, activeSeconds, running, unfinished] = await Promise.all([
    ask(RUN_STEPS),
    ask(RUN_LOOP_ROUNDS),
    ask(RUN_ACTIVE_SECONDS),
    ask(WORKSPACE_RUNNING_RUNS),
    ask(WORKSPACE_UNFINISHED_RUNS),
  ]);
  return {
    run: { [RUN_STEPS]: steps, [RUN_LOOP_ROUNDS]: loopRounds, [RUN_ACTIVE_SECONDS]: activeSeconds },
    workspace: { [WORKSPACE_RUNNING_RUNS]: running, [WORKSPACE_UNFINISHED_RUNS]: unfinished },
  };
}
