import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M029 = readFileSync(
  join(__dirname, '..', 'db', 'migrations', '029_review_approval_version.sql'),
  'utf8',
);

/** 029 lets an approval name the version it covered; `db:migrate` re-runs it on every boot. Scratch DB only. */
describe('migration 029: approvals record the version they covered (scratch DB)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await db.connect();
    await db.query('ALTER TABLE review_approvals DROP COLUMN source_version_id');
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it('adds the column once, and a re-run changes nothing', async () => {
    await db.query(M029);
    await db.query(M029);
    const column = await db.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'review_approvals' AND column_name = 'source_version_id'`,
    );
    expect(column.rows).toEqual([{ data_type: 'uuid' }]);
  });
});
