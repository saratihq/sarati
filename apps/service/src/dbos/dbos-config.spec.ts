import { DBOS } from '@dbos-inc/dbos-sdk';

import { launchDbos } from './dbos-config';

jest.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    adminServer: undefined,
    setConfig: jest.fn(),
    launch: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
  },
}));

const dbos = DBOS as unknown as { adminServer: unknown; launch: jest.Mock; shutdown: jest.Mock };

describe('launchDbos', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dbos.adminServer = undefined;
  });

  it('launches DBOS with its admin server off, whatever the config asks', async () => {
    await launchDbos({ name: 'n', runAdminServer: true, adminPort: 3017 });
    expect(DBOS.setConfig).toHaveBeenCalledWith({ name: 'n', runAdminServer: false, adminPort: 3017 });
    expect(dbos.launch).toHaveBeenCalledTimes(1);
    expect(dbos.shutdown).not.toHaveBeenCalled();
  });

  it('shuts DBOS down and throws when its admin server starts anyway', async () => {
    dbos.launch.mockImplementationOnce(() => {
      dbos.adminServer = {};
      return Promise.resolve();
    });
    await expect(launchDbos({ name: 'n' })).rejects.toThrow('DBOS started its admin server');
    expect(dbos.shutdown).toHaveBeenCalledTimes(1);
  });
});
