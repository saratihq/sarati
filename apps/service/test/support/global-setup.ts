import { randomBytes } from 'node:crypto';

import { ADMIN_URL, E2E_RUN_ID_ENV, REAP_AFTER_MS, reapStaleE2eDatabases } from './test-db';

/** Lowers the stale threshold, so the reap can be exercised without waiting two hours. */
const REAP_AFTER_ENV = 'E2E_DB_REAP_AFTER_MS';

/** Gives this jest run the id its databases carry, then reaps what runs killed before their teardown left. */
export default async function e2eGlobalSetup(): Promise<void> {
  process.env[E2E_RUN_ID_ENV] = randomBytes(4).toString('hex');
  const override = Number(process.env[REAP_AFTER_ENV]);
  try {
    const { dropped, refused, remaining } = await reapStaleE2eDatabases(ADMIN_URL, {
      olderThanMs: override > 0 ? override : REAP_AFTER_MS,
    });
    if (dropped.length + remaining > 0) {
      // On stderr, so a run's own report on stdout (`--json`) stays parseable.
      console.warn(
        `e2e databases: dropped ${dropped.length} stale, ${remaining} left for the next run` +
          (refused.length > 0 ? `; refused: ${refused.join('; ')}` : ''),
      );
    }
  } catch (err) {
    // Fail-open: a stale leftover costs disk, never a run.
    console.warn(`e2e databases: stale cleanup failed: ${(err as Error).message}`);
  }
}
