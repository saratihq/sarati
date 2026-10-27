/** Recovery version when `DBOS_APP_VERSION` is unset: a constant, never DBOS's code hash, or every deploy strands the runs in flight across it. */
export const DBOS_APP_VERSION_DEFAULT = 'orchestr-1';

// Recovery executor when `DBOS_EXECUTOR_ID` is unset, DBOS's own for a single instance.
const DBOS_EXECUTOR_ID_DEFAULT = 'local';

/** Which runs DBOS recovers as it launches: only those recorded under this application version, on this executor. */
export interface RecoveryIdentity {
  applicationVersion: string;
  executorId: string;
}

/** The identity this install launches DBOS with. */
export function recoveryIdentityOf(env: {
  dbosAppVersion: string;
  dbosExecutorId: string;
}): RecoveryIdentity {
  return {
    applicationVersion: env.dbosAppVersion || DBOS_APP_VERSION_DEFAULT,
    executorId: env.dbosExecutorId || DBOS_EXECUTOR_ID_DEFAULT,
  };
}
