import type { Config } from '@jest/types';

import dropRunDatabases from './database-teardown';
import reportStrayEgress from './no-egress-teardown';

/** Fails the run on stray egress, and drops the run's databases either way. */
export default async function e2eGlobalTeardown(globalConfig: Config.GlobalConfig): Promise<void> {
  try {
    reportStrayEgress(globalConfig);
  } finally {
    await dropRunDatabases();
  }
}
