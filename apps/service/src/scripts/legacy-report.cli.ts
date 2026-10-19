import { Client } from 'pg';

import { errorMessage } from '../common/error-message';
import { pendingLegacyRuns, readResumability, type Sql } from '../dbos/recovery-guard';
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
  const system = new Client({ connectionString: systemUrl });
  await app.connect();
  await system.connect();
  try {
    const rows =
      (client: Client): Sql =>
      async (text, params) =>
        (await client.query<Record<string, unknown>>(text, params)).rows;
    const runs = await pendingLegacyRuns(systemUrl);
    let failing = 0;
    process.stdout.write('Runs in flight, as of now; each is judged again when it recovers.\n');
    for (const { runId, plan } of runs) {
      const verdict = await readResumability(rows(app), rows(system), runId, plan);
      if (verdict.resumable) {
        process.stdout.write(`would resume  ${runId}\n`);
      } else {
        failing += 1;
        process.stdout.write(`would fail    ${runId}  (${verdict.reason})\n`);
      }
    }
    process.stdout.write(`${runs.length - failing} would resume, ${failing} would fail.\n`);
  } finally {
    await Promise.all([app.end(), system.end()]);
  }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main().catch((err: unknown) => fail(errorMessage(err)));
