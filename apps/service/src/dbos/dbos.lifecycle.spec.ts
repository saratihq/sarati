import type { ConfigService } from '@nestjs/config';
import { DBOS } from '@dbos-inc/dbos-sdk';

import type { EnvConfig } from '../config/env.config';
import type { JobsLifecycle } from '../jobs/jobs.module';
import { DbosLifecycle } from './dbos.lifecycle';
import type { DbosRuntime } from './dbos-runtime';
import { DBOS_APP_VERSION_DEFAULT } from './recovery-identity';

jest.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    setConfig: jest.fn(),
    launch: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('./dbos-runtime', () => ({ DbosRuntime: class {} }));

const setConfig = DBOS.setConfig as jest.Mock;
const launch = DBOS.launch as jest.Mock;
const shutdown = DBOS.shutdown as jest.Mock;

const configWith = (env: Partial<EnvConfig>): ConfigService<{ env: EnvConfig }, true> =>
  ({ get: () => env as EnvConfig }) as unknown as ConfigService<{ env: EnvConfig }, true>;

const runtime = (): DbosRuntime =>
  ({ launched: jest.fn(), notLaunched: jest.fn() }) as unknown as DbosRuntime;

const jobs = (stop = jest.fn(() => Promise.resolve())): JobsLifecycle =>
  ({ stop }) as unknown as JobsLifecycle;

const enabled = (over: Partial<EnvConfig> = {}): Partial<EnvConfig> => ({
  dbosEnabled: true,
  databaseUrl: 'postgresql://orchestr:orchestr@localhost:5432/orchestr_svc',
  dbosSystemDatabaseUrl: '',
  dbosAppVersion: '',
  dbosExecutorId: '',
  ...over,
});

describe('DbosLifecycle (B9 — pinned recovery identity)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is inert when DBOS is disabled', async () => {
    await new DbosLifecycle(configWith({ dbosEnabled: false }), runtime(), jobs()).onApplicationBootstrap();
    expect(setConfig).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('pins a STABLE applicationVersion (not DBOS code-hash) so a deploy recovers in-flight runs', async () => {
    await new DbosLifecycle(configWith(enabled()), runtime(), jobs()).onApplicationBootstrap();
    expect(setConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'orchestr',
        applicationVersion: DBOS_APP_VERSION_DEFAULT,
        executorID: 'local',
      }),
    );
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('honours env overrides for appVersion + executorId (multi-instance deploy)', async () => {
    await new DbosLifecycle(
      configWith(enabled({ dbosAppVersion: 'v42', dbosExecutorId: 'replica-a' })),
      runtime(),
      jobs(),
    ).onApplicationBootstrap();
    expect(setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ applicationVersion: 'v42', executorID: 'replica-a' }),
    );
  });

  it('launches DBOS without its admin server', async () => {
    await new DbosLifecycle(configWith(enabled()), runtime(), jobs()).onApplicationBootstrap();
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ runAdminServer: false }));
  });

  it('does not shut down DBOS when it was never launched, and still stops pg-boss', async () => {
    const stopJobs = jest.fn(() => Promise.resolve());
    const lc = new DbosLifecycle(configWith({ dbosEnabled: false }), runtime(), jobs(stopJobs));
    await lc.onApplicationBootstrap();
    await lc.onApplicationShutdown();
    expect(shutdown).not.toHaveBeenCalled();
    expect(stopJobs).toHaveBeenCalledTimes(1);
  });

  it('stops pg-boss before DBOS, whose stop waits for every workflow it is running', async () => {
    const order: string[] = [];
    shutdown.mockImplementationOnce(() => {
      order.push('DBOS');
      return Promise.resolve();
    });
    const stopJobs = jest.fn(() => {
      order.push('pg-boss');
      return Promise.resolve();
    });
    const lc = new DbosLifecycle(configWith(enabled()), runtime(), jobs(stopJobs));
    await lc.onApplicationBootstrap();
    await lc.onApplicationShutdown();
    expect(order).toEqual(['pg-boss', 'DBOS']);
  });
});
