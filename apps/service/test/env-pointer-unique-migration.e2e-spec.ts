import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M037 = readFileSync(join(__dirname, '..', 'db', 'migrations', '037_env_pointer_unique.sql'), 'utf8');

interface PointerRow {
  workflow_id: string;
  environment: string;
  environment_id: string | null;
  version_id: string;
}

describe('migration 037: one pointer per (workflow, environment) (scratch DB)', () => {
  let db: Client;
  const warnings: string[] = [];
  const [org, first, second] = [randomUUID(), randomUUID(), randomUUID()];
  const [qa, staging] = [randomUUID(), randomUUID()];
  const [v1, v2, v3, w1] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

  const pointers = async (): Promise<PointerRow[]> =>
    (
      await db.query<PointerRow>(
        `SELECT workflow_id, environment, environment_id, version_id FROM workflow_env_pointers
          ORDER BY workflow_id, environment`,
      )
    ).rows;

  beforeAll(async () => {
    db = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await db.connect();
    db.on('notice', (notice) => {
      if (notice.severity === 'WARNING') warnings.push(notice.message ?? '');
    });
    await db.query('DROP INDEX uq_workflow_env_pointers_workflow_env');
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'o', false, now(), now())`,
      [org],
    );
    await db.query(`INSERT INTO workflows (id, name, org_id) VALUES ($1, 'first', $3), ($2, 'second', $3)`, [
      first,
      second,
      org,
    ]);
    await db.query(`INSERT INTO environments (id, org_id, name) VALUES ($1, $3, 'qa'), ($2, $3, 'staging')`, [
      qa,
      staging,
      org,
    ]);
    await db.query(
      `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json) VALUES
         ($1, $5, 1, '{}'), ($2, $5, 2, '{}'), ($3, $5, 3, '{}'), ($4, $6, 1, '{}')`,
      [v1, v2, v3, w1, first, second],
    );
    await db.query(
      `INSERT INTO workflow_env_pointers (workflow_id, environment, version_id, environment_id, updated_at) VALUES
         ($1, 'qa',       $3, $6, now() - interval '2 hours'),
         ($1, 'qa-old',   $5, $6, now()),
         ($1, 'stage-a',  $3, $7, now() - interval '2 hours'),
         ($1, 'stage-b',  $4, $7, now() - interval '1 hour'),
         ($2, 'qa-older', $8, $6, now()),
         ($2, 'legacy',   $8, NULL, now())`,
      [first, second, v1, v2, v3, qa, staging, w1],
    );
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it("keeps the row under the env's current name, else the newest, names it after the env, reports each drop, and a re-run changes nothing", async () => {
    await db.query(M037);
    const once = await pointers();
    const reported = warnings.length;
    await db.query(M037);

    expect(await pointers()).toEqual(once);
    expect(warnings).toHaveLength(reported);
    expect(once).toHaveLength(4);
    expect(once).toEqual(
      expect.arrayContaining([
        { workflow_id: first, environment: 'qa', environment_id: qa, version_id: v1 },
        { workflow_id: first, environment: 'staging', environment_id: staging, version_id: v2 },
        { workflow_id: second, environment: 'legacy', environment_id: null, version_id: w1 },
        { workflow_id: second, environment: 'qa', environment_id: qa, version_id: w1 },
      ]),
    );
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`workflow ${first}, environment ${qa} (as qa-old), version ${v3}`),
        expect.stringContaining(`workflow ${first}, environment ${staging} (as stage-a), version ${v1}`),
      ]),
    );
    expect(warnings).toHaveLength(2);
  });

  it('refuses a second pointer row on one environment', async () => {
    const duplicate = db.query(
      `INSERT INTO workflow_env_pointers (workflow_id, environment, version_id, environment_id)
       VALUES ($1, 'qa-again', $2, $3)`,
      [first, v3, qa],
    );
    await expect(duplicate).rejects.toMatchObject({
      code: '23505',
      constraint: 'uq_workflow_env_pointers_workflow_env',
    });
  });
});
