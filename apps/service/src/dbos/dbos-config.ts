import { DBOS, type DBOSConfig } from '@dbos-inc/dbos-sdk';

/** Launch DBOS on `config` without its admin server, an unauthenticated API over every run; shuts DBOS down and throws if one starts anyway. */
export async function launchDbos(config: DBOSConfig): Promise<void> {
  DBOS.setConfig({ ...config, runAdminServer: false });
  await DBOS.launch();
  if (DBOS.adminServer === undefined) return;
  await DBOS.shutdown();
  throw new Error('DBOS started its admin server, which answers without signing in, so DBOS was shut down');
}
