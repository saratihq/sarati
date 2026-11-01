import type { ConfigService } from '@nestjs/config';
import { DBOS } from '@dbos-inc/dbos-sdk';

import type { EnvConfig } from '../config/env.config';
import type { JobsLifecycle } from '../jobs/jobs.module';
import type { DagInterpreter } from '../runtime/dag-interpreter';
import { DbosLifecycle } from './dbos.lifecycle';
import { DbosRuntime } from './dbos-runtime';

jest.mock('@dbos-inc/dbos-sdk', () => {
  const done = (): Promise<unknown> => Promise.resolve(null);
  return {
    DBOS: {
      registerWorkflow: jest.fn((fn: unknown) => fn),
      isWithinWorkflow: jest.fn(() => false),
      setConfig: jest.fn(),
      launch: jest.fn(),
      shutdown: jest.fn(done),
      send: jest.fn(done),
      cancelWorkflow: jest.fn(done),
      startWorkflow: jest.fn(() => () => Promise.resolve({ getResult: done })),
      listWorkflows: jest.fn(() => Promise.resolve([])),
      getWorkflowStatus: jest.fn(done),
      retrieveWorkflow: jest.fn(() => ({ getStatus: done, getResult: done })),
    },
    DBOSClient: { create: jest.fn() },
    Error: {
      DBOSConflictingWorkflowError: class extends Error {},
      DBOSMaxRecoveryAttemptsExceededError: class extends Error {},
    },
    StatusString: {
      PENDING: 'PENDING',
      SUCCESS: 'SUCCESS',
      ERROR: 'ERROR',
      CANCELLED: 'CANCELLED',
      MAX_RECOVERY_ATTEMPTS_EXCEEDED: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
    },
  };
});

const DBOS_CALLS = [
  'send',
  'cancelWorkflow',
  'startWorkflow',
  'listWorkflows',
  'getWorkflowStatus',
  'retrieveWorkflow',
] as const;
const dbosCalled = (): number =>
  DBOS_CALLS.reduce((n, call) => n + (DBOS[call] as unknown as jest.Mock).mock.calls.length, 0);

const config = (env: Partial<EnvConfig>): ConfigService<{ env: EnvConfig }, true> =>
  ({
    get: () =>
      ({
        databaseUrl: 'postgresql://orchestr:orchestr@localhost:5432/orchestr_svc',
        dbosSystemDatabaseUrl: '',
        dbosAppVersion: '',
        dbosExecutorId: '',
        ...env,
      }) as EnvConfig,
  }) as unknown as ConfigService<{ env: EnvConfig }, true>;

const jobs = { stop: () => Promise.resolve() } as unknown as JobsLifecycle;

// Every method the runtime offers, so one added later is held to the launch as well.
const METHODS = Object.getOwnPropertyNames(DbosRuntime.prototype).filter(
  (name) => !['constructor', 'launched', 'notLaunched', 'outsideWorkflowOnceLaunched'].includes(name),
);

function callEach(runtime: DbosRuntime): Array<{ method: string; call: Promise<unknown> }> {
  return METHODS.map((method) => {
    const fn = (runtime as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method]!;
    const call = fn.call(runtime, 'run', { runId: 'run', externalUserId: 'u' }, {}, 'key');
    call.catch(() => undefined);
    return { method, call };
  });
}

const settled = async (call: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void call.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

describe('DbosRuntime, held to the launch', () => {
  beforeEach(() => jest.clearAllMocks());

  it('offers the calls the service makes of DBOS', () => {
    expect(METHODS.sort()).toEqual(
      [
        'canResume',
        'cancelWorkflow',
        'getRunStatus',
        'holdsWorkflow',
        'sendEvent',
        'startDurably',
        'wontResume',
      ].sort(),
    );
  });

  it('holds every call until DBOS has launched, then lets each through', async () => {
    let launch!: () => void;
    (DBOS.launch as jest.Mock).mockReturnValue(new Promise<void>((resolve) => (launch = resolve)));
    const runtime = new DbosRuntime({} as DagInterpreter);
    const lifecycle = new DbosLifecycle(config({ dbosEnabled: true }), runtime, jobs);
    const booting = lifecycle.onApplicationBootstrap();

    const calls = callEach(runtime);
    for (const { method, call } of calls) expect([method, await settled(call)]).toEqual([method, false]);
    expect(dbosCalled()).toBe(0);

    launch();
    await booting;
    for (const { call } of calls) await call;
    expect(dbosCalled()).toBeGreaterThanOrEqual(METHODS.length);
  });

  it('fails every call, rather than holding it, once DBOS will not launch', async () => {
    const runtime = (): DbosRuntime => new DbosRuntime({} as DagInterpreter);

    (DBOS.launch as jest.Mock).mockRejectedValue(new Error('no system database'));
    const failed = runtime();
    await expect(
      new DbosLifecycle(config({ dbosEnabled: true }), failed, jobs).onApplicationBootstrap(),
    ).rejects.toThrow('no system database');

    const off = runtime();
    await new DbosLifecycle(config({ dbosEnabled: false }), off, jobs).onApplicationBootstrap();

    const stopped = runtime();
    new DbosLifecycle(config({ dbosEnabled: true }), stopped, jobs).onModuleDestroy();

    for (const [runtimeOf, reason] of [
      [failed, 'DBOS failed to launch: no system database'],
      [off, 'DBOS is off (DBOS_ENABLED=false)'],
      [stopped, 'the service is stopping'],
    ] as const) {
      for (const { call } of callEach(runtimeOf)) await expect(call).rejects.toThrow(reason);
    }
    expect(dbosCalled()).toBe(0);
  });

  it('keeps every call going through once DBOS has launched, whatever a later stop says', async () => {
    (DBOS.launch as jest.Mock).mockResolvedValue(undefined);
    const runtime = new DbosRuntime({} as DagInterpreter);
    const lifecycle = new DbosLifecycle(config({ dbosEnabled: true }), runtime, jobs);
    await lifecycle.onApplicationBootstrap();
    lifecycle.onModuleDestroy();

    for (const { call } of callEach(runtime)) await call;
    expect(dbosCalled()).toBeGreaterThanOrEqual(METHODS.length);
  });
});
