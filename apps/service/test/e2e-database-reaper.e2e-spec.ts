import { randomBytes } from 'node:crypto';

import { Client } from 'pg';

import {
  ADMIN_URL,
  dropRunDatabases,
  e2eDatabaseName,
  REAP_AFTER_MS,
  staleE2eDatabases,
  withDatabase,
} from './support/test-db';

describe('e2e database cleanup (real Postgres)', () => {
  const runId = (): string => randomBytes(4).toString('hex');

  it('reaps only stamped e2e databases older than the threshold, oldest first', () => {
    const now = Date.now();
    const run = runId();
    const older = e2eDatabaseName(run, now - REAP_AFTER_MS - 2_000);
    const old = `${e2eDatabaseName(run, now - REAP_AFTER_MS - 1_000)}_dbos`;
    const young = e2eDatabaseName(run, now - REAP_AFTER_MS + 60_000);
    const beforeRunIds = `orchestr_e2e_${now - REAP_AFTER_MS - 3_000}_1a2b3c4d`;
    const unstamped = 'orchestr_e2e_1a2b3c4d';

    expect(
      staleE2eDatabases([young, old, 'orchestr_svc', unstamped, older, beforeRunIds], now, REAP_AFTER_MS),
    ).toEqual([beforeRunIds, older, old]);
  });

  it("drops every database its run created, through a live connection, and none of another run's", async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const run = runId();
    const mine = e2eDatabaseName(run);
    const theirs = e2eDatabaseName(runId());
    const names = [mine, `${mine}_dbos`, theirs];
    const holder = new Client({ connectionString: withDatabase(ADMIN_URL, mine) });
    const terminated = new Promise<string | undefined>((resolve) =>
      holder.on('error', (err: Error & { code?: string }) => resolve(err.code)),
    );
    try {
      for (const name of names) await admin.query(`CREATE DATABASE ${name}`);
      await holder.connect();

      expect(await dropRunDatabases(ADMIN_URL, run)).toEqual([]);

      expect(await terminated).toBe('57P01');
      const left = await admin.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname = ANY($1)',
        [names],
      );
      expect(left.rows.map((row) => row.datname)).toEqual([theirs]);
    } finally {
      await holder.end();
      for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
});
