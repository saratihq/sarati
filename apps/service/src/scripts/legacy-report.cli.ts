import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { Client } from 'pg';

import { errorMessage } from '../common/error-message';
import {
  alreadyEnded,
  pendingLegacyRuns,
  readResumability,
  recordedOps,
  type Sql,
} from '../dbos/recovery-guard';
import { systemDatabaseUrlOf } from '../dbos/system-db-url';

/**
 * List the runs in flight on `orchestr.runPlan` and whether each would resume, reading only:
 *
 *   pnpm runs:legacy-report
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail('DATABASE_URL is not set — run this where the service runs.');
  const systemUrl = systemDatabaseUrlOf({
    databaseUrl,
    dbosSystemDatabaseUrl: process.env.DBOS_SYSTEM_DATABASE_URL ?? '',
  });
  const app = new Client({ connectionString: databaseUrl });
  const system = await DBOSClient.create({ systemDatabaseUrl: systemUrl });
  await app.connect();
  try {
    const rows: Sql = async (text, params) => (await app.query<Record<string, unknown>>(text, params)).rows;
    const runs = await pendingLegacyRuns(system);
    const counts = { resume: 0, fail: 0, ended: 0 };
    process.stdout.write('Runs in flight, as of now; each is judged again when it recovers.\n');
    for (const { runId, run } of runs) {
      if (await alreadyEnded(rows, runId)) {
        counts.ended += 1;
        process.stdout.write(`already ended ${runId}\n`);
        continue;
      }
      const verdict = await readResumability(
        (read) => read(rows),
        (id) => recordedOps(system, id),
        runId,
        run,
      );
      if (verdict.resumable) {
        counts.resume += 1;
        process.stdout.write(`would resume  ${runId}\n`);
      } else {
        counts.fail += 1;
        process.stdout.write(`would fail    ${runId}  (${verdict.reason})\n`);
      }
    }
    process.stdout.write(
      `${counts.resume} would resume, ${counts.fail} would fail, ${counts.ended} had already ended.\n`,
    );
  } finally {
    await Promise.all([app.end(), system.destroy()]);
  }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main().catch((err: unknown) => fail(errorMessage(err)));
