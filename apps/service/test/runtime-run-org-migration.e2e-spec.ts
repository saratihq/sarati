import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M028 = readFileSync(join(__dirname, '..', 'db', 'migrations', '028_runtime_run_org.sql'), 'utf8');

/** 028 gives every run the org it ran in, from its workflow; `db:migrate` re-runs it on every boot. Scratch DB only. */
describe('migration 028: runs remember their org (scratch DB)', () => {
  let db: Client;
  const user = randomUUID();
  const org = randomUUID();
  const [inOrg, orgless] = [randomUUID(), randomUUID()];

  const run = (id: string, workflowId: string | null) =>
    db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, workflow_id) VALUES ($1, $1, $2, 'p', 'completed', $3)`,
      [id, user, workflowId],
    );
  const orgOf = async (id: string): Promise<string | null> =>
    (await db.query<{ org_id: string | null }>(`SELECT org_id FROM runtime_runs WHERE id = $1`, [id]))
      .rows[0]!.org_id;

  beforeAll(async () => {
    db = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await db.connect();
    await db.query('DROP INDEX IF EXISTS ix_runtime_runs_org');
    await db.query('ALTER TABLE runtime_runs DROP COLUMN org_id');
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'o', false, now(), now())`,
      [org],
    );
    await db.query(
      `INSERT INTO workflows (id, name, org_id) VALUES ($1, 'in org', $3), ($2, 'org-less', NULL)`,
      [inOrg, orgless, org],
    );
    await run('r-in-org', inOrg);
    await run('r-orgless', orgless);
    await run('r-adhoc', null);
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it("copies each run's workflow org once, and leaves the rest org-less", async () => {
    await db.query(M028);
    await db.query(M028);
    expect(await orgOf('r-in-org')).toBe(org);
    expect(await orgOf('r-orgless')).toBeNull();
    expect(await orgOf('r-adhoc')).toBeNull();
  });

  it('keeps a recorded org when the workflow is later deleted, and never overwrites one', async () => {
    await db.query(`DELETE FROM workflows WHERE id = $1`, [inOrg]);
    const other = randomUUID();
    await db.query(`UPDATE runtime_runs SET org_id = $2 WHERE id = $1`, ['r-adhoc', other]);
    await db.query(M028);
    expect(await orgOf('r-in-org')).toBe(org);
    expect(await orgOf('r-adhoc')).toBe(other);
  });
});
