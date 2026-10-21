import type { DBOSConfig } from '@dbos-inc/dbos-sdk';

/** `config` with DBOS's admin server off: its HTTP API reads, cancels, resumes and forks any workflow with no authentication. */
export function withoutAdminServer(config: DBOSConfig): DBOSConfig {
  return { ...config, runAdminServer: false };
}
