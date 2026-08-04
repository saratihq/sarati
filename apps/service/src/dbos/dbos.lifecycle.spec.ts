import type { ConfigService } from '@nestjs/config';
import { DBOS } from '@dbos-inc/dbos-sdk';

import type { EnvConfig } from '../config/env.config';
import { DbosLifecycle, DBOS_APP_VERSION_DEFAULT } from './dbos.lifecycle';

jest.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    setConfig: jest.fn(),
    launch: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
  },
}));

const setConfig = DBOS.setConfig as jest.Mock;
const launch = DBOS.launch as jest.Mock;
const shutdown = DBOS.shutdown as jest.Mock;

const configWith = (env: Partial<EnvConfig>): ConfigService<{ env: EnvConfig }, true> =>
  ({ get: () => env as EnvConfig }) as unknown as ConfigService<{ env: EnvConfig }, true>;

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
    await new DbosLifecycle(configWith({ dbosEnabled: false })).onApplicationBootstrap();
    expect(setConfig).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('pins a STABLE applicationVersion (not DBOS code-hash) so a deploy recovers in-flight runs', async () => {
    await new DbosLifecycle(configWith(enabled())).onApplicationBootstrap();
    expect(setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'orchestr', applicationVersion: DBOS_APP_VERSION_DEFAULT }),
    );
    // executorID is omitted → DBOS keeps its stable 'local' default.
    expect(setConfig.mock.calls[0][0]).not.toHaveProperty('executorID');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('honours env overrides for appVersion + executorId (multi-instance deploy)', async () => {
    await new DbosLifecycle(
      configWith(enabled({ dbosAppVersion: 'v42', dbosExecutorId: 'replica-a' })),
    ).onApplicationBootstrap();
    expect(setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ applicationVersion: 'v42', executorID: 'replica-a' }),
    );
  });

  it('does not shut down DBOS when it was never launched', async () => {
    const lc = new DbosLifecycle(configWith({ dbosEnabled: false }));
    await lc.onApplicationBootstrap();
    await lc.onApplicationShutdown();
    expect(shutdown).not.toHaveBeenCalled();
  });
});
