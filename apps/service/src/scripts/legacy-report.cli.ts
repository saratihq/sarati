import { Client } from 'pg';

import { errorMessage } from '../common/error-message';
import {
  alreadyEnded,
  readLegacyHistory,
  readResumability,
  type LegacyHistory,
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
  await app.connect();
  try {
    await readLegacyHistory(systemUrl, (history) => report(history, app));
  } finally {
    await app.end();
  }
}

async function report(history: LegacyHistory, app: Client): Promise<void> {
  const rows: Sql = async (text, params) => (await app.query<Record<string, unknown>>(text, params)).rows;
  const counts = { resume: 0, fail: 0, ended: 0 };
  process.stdout.write(
    'Runs an earlier version started, in flight as of now; each is judged again when it recovers.\n',
  );
  for (const { runId, run } of await history.pending()) {
    if (await alreadyEnded(rows, runId)) {
      counts.ended += 1;
      process.stdout.write(`already ended ${runId}\n`);
      continue;
    }
    const verdict = await readResumability((read) => read(rows), history.opsOf, runId, run);
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
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main().catch((err: unknown) => fail(errorMessage(err)));
