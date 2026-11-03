import type { ConfigService } from '@nestjs/config';

import { validateEnv, type EnvConfig } from '../config/env.config';
import { decideRunLimits, OpenCoreEntitlements, type EntitlementsProvider } from './entitlements';
import {
  activeTimeLimitReached,
  callersRefusal,
  forEachLimitReached,
  isRunLimitReached,
  RUN_ACTIVE_SECONDS,
  RUN_LIMIT_MAX,
  RUN_LIMITS,
  RUN_LOOP_ROUNDS,
  RUN_STEPS,
  recordedRunLimit,
  stepLimitReached,
  whileLimitReached,
  WORKSPACE_RUNNING_RUNS,
  WORKSPACE_UNFINISHED_RUNS,
  workspaceRunLimit,
} from './run-limits';

const providerFrom = (raw: Record<string, string>): OpenCoreEntitlements =>
  new OpenCoreEntitlements({ get: () => validateEnv(raw) } as unknown as ConfigService<
    { env: EnvConfig },
    true
  >);

describe('run limits: the one definition site', () => {
  it('every run limit has one metric, one env variable and one default, and 0 reads as none', async () => {
    const metrics = Object.keys(RUN_LIMITS);
    expect(metrics).toEqual([
      RUN_STEPS,
      RUN_LOOP_ROUNDS,
      RUN_ACTIVE_SECONDS,
      WORKSPACE_RUNNING_RUNS,
      WORKSPACE_UNFINISHED_RUNS,
    ]);
    expect(new Set(Object.values(RUN_LIMITS).map((limit) => limit.env)).size).toBe(metrics.length);
    expect(
      Object.values(RUN_LIMITS).every((limit) => Number.isInteger(limit.default) && limit.default > 0),
    ).toBe(true);
    const none = providerFrom(Object.fromEntries(Object.values(RUN_LIMITS).map((limit) => [limit.env, '0'])));
    for (const metric of metrics) await expect(none.limitFor('org', metric)).resolves.toBeNull();
  });

  it('the open-core provider answers each run metric from its env value for any workspace, none included, and null for any other metric', async () => {
    const provider = providerFrom({ RUN_MAX_STEPS: '12', WORKSPACE_MAX_RUNNING_RUNS: '3' });
    for (const workspace of ['org-a', 'org-b', null]) {
      await expect(provider.limitFor(workspace, RUN_STEPS)).resolves.toBe(12);
      await expect(provider.limitFor(workspace, WORKSPACE_RUNNING_RUNS)).resolves.toBe(3);
      await expect(provider.limitFor(workspace, RUN_LOOP_ROUNDS)).resolves.toBe(
        RUN_LIMITS[RUN_LOOP_ROUNDS].default,
      );
      await expect(provider.limitFor(workspace, 'seats')).resolves.toBeNull();
    }
    await expect(provider.allows()).resolves.toBe(true);
  });

  it('decideRunLimits asks the provider once per metric for the run’s workspace', async () => {
    const asked: Array<[string | null, string]> = [];
    const provider: EntitlementsProvider = {
      allows: () => Promise.resolve(true),
      limitFor: (orgId, metric) => {
        asked.push([orgId, metric]);
        return Promise.resolve(metric === RUN_ACTIVE_SECONDS ? null : metric.length);
      },
    };

    const decided = await decideRunLimits(provider, 'ws-1');

    expect(asked.sort()).toEqual(
      Object.keys(RUN_LIMITS)
        .map((metric) => ['ws-1', metric])
        .sort(),
    );
    expect(decided).toEqual({
      run: {
        [RUN_STEPS]: RUN_STEPS.length,
        [RUN_LOOP_ROUNDS]: RUN_LOOP_ROUNDS.length,
        [RUN_ACTIVE_SECONDS]: null,
      },
      workspace: {
        [WORKSPACE_RUNNING_RUNS]: WORKSPACE_RUNNING_RUNS.length,
        [WORKSPACE_UNFINISHED_RUNS]: WORKSPACE_UNFINISHED_RUNS.length,
      },
    });
  });

  it("decideRunLimits holds a provider's answer to what a run's row can count, and fails an admission on one that is no limit at all", async () => {
    const answering = (answer: number | null): EntitlementsProvider => ({
      allows: () => Promise.resolve(true),
      limitFor: () => Promise.resolve(answer),
    });

    for (const big of [RUN_LIMIT_MAX + 1, 10_000_000_000, Number.MAX_SAFE_INTEGER]) {
      const decided = await decideRunLimits(answering(big), 'ws');
      expect(Object.values({ ...decided.run, ...decided.workspace })).toEqual(Array(5).fill(RUN_LIMIT_MAX));
    }
    expect((await decideRunLimits(answering(0), 'ws')).run[RUN_STEPS]).toBe(0);
    for (const bad of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(decideRunLimits(answering(bad), 'ws')).rejects.toThrow(
        `the entitlements provider answered ${RUN_STEPS} with ${String(bad)}, not null or a whole number from 0`,
      );
    }
  });

  it("words a step or time refusal for the run it lands on: a called run's names the top-level run it was called under, and its caller's names the caller", () => {
    const called = stepLimitReached(8, true);
    expect(called.message).toBe(
      'Run limit reached: the top-level run this one was called under took 8 steps, the most one run may take in this workspace — counting every workflow it calls, this one included. An operator can raise RUN_MAX_STEPS.',
    );
    expect(called.details).toEqual(stepLimitReached(8).details);
    expect(callersRefusal(called, false)).toEqual(stepLimitReached(8));
    expect(callersRefusal(stepLimitReached(8), true)).toEqual(called);
    expect(callersRefusal(activeTimeLimitReached(60, true), false)).toEqual(activeTimeLimitReached(60));
    expect((callersRefusal(activeTimeLimitReached(60), true) as Error).message).toContain(
      'the top-level run this one was called under was in flight for more than 1 min',
    );
    const loop = forEachLimitReached('items', 5, 3, 3);
    expect(callersRefusal(loop, false)).toBe(loop);
    const other = new Error('boom');
    expect(callersRefusal(other, false)).toBe(other);
  });

  it("reads the limit a run's row records back off its error: each refusal under its own limit and that limit's number, and nothing else as one", () => {
    const limits = { [RUN_STEPS]: 6, [RUN_LOOP_ROUNDS]: 4, [RUN_ACTIVE_SECONDS]: 3 };
    const refusals = [
      stepLimitReached(6),
      stepLimitReached(6, true),
      forEachLimitReached('items', 9, 4, 4),
      whileLimitReached('again', 4),
      activeTimeLimitReached(3),
      activeTimeLimitReached(3, true),
    ];

    for (const refusal of refusals) {
      const read = recordedRunLimit(refusal.message, limits);
      expect([read?.message, read?.status, read?.details]).toEqual([refusal.message, 422, refusal.details]);
    }
    expect(recordedRunLimit(stepLimitReached(6).message, null)?.details).toEqual({
      ...stepLimitReached(6).details,
      max: null,
    });
    expect(
      recordedRunLimit(forEachLimitReached('raise RUN_MAX_STEPS.', 9, 4, 4).message, limits)?.details,
    ).toEqual(forEachLimitReached('x', 9, 4, 4).details);
    for (const other of [
      null,
      'boom',
      'Run limit reached: something else',
      workspaceRunLimit(WORKSPACE_RUNNING_RUNS, 2).message,
    ]) {
      expect(recordedRunLimit(other, limits)).toBeNull();
    }
  });

  it('knows a per-run refusal by its code wherever it came from, and a workspace refusal for what it is', () => {
    const refusal = stepLimitReached(5);
    const replayed = Object.assign(new Error(refusal.message), {
      name: 'DomainError',
      details: refusal.details,
    });
    expect([isRunLimitReached(refusal), isRunLimitReached(replayed)]).toEqual([true, true]);
    expect(isRunLimitReached(workspaceRunLimit(WORKSPACE_RUNNING_RUNS, 2))).toBe(false);
    expect(isRunLimitReached(new Error('boom'))).toBe(false);
    expect(isRunLimitReached(null)).toBe(false);
  });
});
