import { ADMIN_URL, dropRunDatabases, e2eRunId } from './test-db';

/** Drops every database this jest run created; a failure is reported, and a later run's stale reap gets it. */
export default async function e2eDatabaseTeardown(): Promise<void> {
  try {
    const failed = await dropRunDatabases(ADMIN_URL, e2eRunId());
    if (failed.length > 0) console.warn(`e2e databases: could not drop ${failed.join('; ')}`);
  } catch (err) {
    console.warn(`e2e databases: could not drop this run's databases: ${(err as Error).message}`);
  }
}
