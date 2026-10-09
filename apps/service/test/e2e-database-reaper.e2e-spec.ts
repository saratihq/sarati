import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase, e2eDatabaseName } from './support/test-db';

/** Every suite reaps leftovers on start; a database another suite just created must never be one of them. */
describe('e2e database cleanup (real Postgres)', () => {
  const exists = async (admin: Client, name: string): Promise<boolean> =>
    (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1;

  it("keeps another suite's fresh database it hasn't connected to yet, and reaps an old leftover", async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const fresh = e2eDatabaseName();
    const old = fresh.replace(/_(\d{13})_/, `_${Date.now() - 3 * 60 * 60 * 1000}_`);
    try {
      await admin.query(`CREATE DATABASE ${fresh}`);
      await admin.query(`CREATE DATABASE ${old}`);

      await createE2eDatabase(ADMIN_URL);

      expect(await exists(admin, fresh)).toBe(true);
      expect(await exists(admin, old)).toBe(false);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${fresh} WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS ${old} WITH (FORCE)`);
      await admin.end();
    }
  });
});
