import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const MIGRATION = readFileSync(
  join(__dirname, '..', 'db', 'migrations', '005_env_promotion_pointers.sql'),
  'utf8',
);

/**
 * Retrofit migration 004 (H1 env-promotion pointers) proven against a scratch DB rolled back
 * to the pre-migration shape — NEVER a live one.
 */
describe('migration 004 — env promotion pointers (scratch DB)', () => {
  let db: Client;

  const wfLive = randomUUID(); // has an active version → backfilled
  const wfDraft = randomUUID(); // never published → NOT backfilled
  const vLive = randomUUID();
  const userId = randomUUID();

  beforeAll(async () => {
    const url = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: url });
    await db.connect();

    // Roll the scratch DB back to the PRE-migration shape.
    await db.query(`DROP TABLE public.workflow_env_pointers`);
    await db.query(`ALTER TABLE public.runtime_runs DROP COLUMN workflow_version_id`);

    // Seed a pre-H1 production shape: one published workflow, one draft-only.
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'mig@e2e.local', 'Mig', now(), now())`,
      [userId],
    );
    await db.query(
      `INSERT INTO workflows (id, name, source, user_id, created_at, updated_at)
       VALUES ($1, 'live wf', 'generated', $3, now(), now()),
              ($2, 'draft wf', 'generated', $3, now(), now())`,
      [wfLive, wfDraft, userId],
    );
    await db.query(
      `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json, created_at)
       VALUES ($1, $2, 1, '{}', now())`,
      [vLive, wfLive],
    );
    await db.query(`UPDATE workflows SET active_version_id = $2 WHERE id = $1`, [wfLive, vLive]);
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it('applies cleanly: table + column exist, and prod rows are backfilled from active_version_id', async () => {
    await db.query(MIGRATION);

    const pointers = await db.query(
      `SELECT workflow_id, environment, version_id FROM workflow_env_pointers ORDER BY workflow_id`,
    );
    expect(pointers.rows).toEqual([{ workflow_id: wfLive, environment: 'prod', version_id: vLive }]);

    const col = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'runtime_runs' AND column_name = 'workflow_version_id'`,
    );
    expect(col.rows).toHaveLength(1);
  });

  it('re-applying is a no-op and never clobbers a pointer that moved off the alias', async () => {
    // With the alias deliberately lagging, the backfill's ON CONFLICT DO NOTHING must not restore it.
    const v2 = randomUUID();
    await db.query(
      `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json, created_at)
       VALUES ($1, $2, 2, '{}', now())`,
      [v2, wfLive],
    );
    await db.query(
      `UPDATE workflow_env_pointers SET version_id = $2 WHERE workflow_id = $1 AND environment = 'prod'`,
      [wfLive, v2],
    );

    await db.query(MIGRATION); // second apply

    const pointers = await db.query(`SELECT workflow_id, environment, version_id FROM workflow_env_pointers`);
    expect(pointers.rows).toEqual([{ workflow_id: wfLive, environment: 'prod', version_id: v2 }]);
  });

  it('FKs behave: version delete cascades the pointer; workflow delete cascades everything', async () => {
    const wf = randomUUID();
    const v = randomUUID();
    await db.query(
      `INSERT INTO workflows (id, name, source, user_id, created_at, updated_at)
       VALUES ($1, 'fk wf', 'generated', $2, now(), now())`,
      [wf, userId],
    );
    await db.query(
      `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json, created_at)
       VALUES ($1, $2, 1, '{}', now())`,
      [v, wf],
    );
    await db.query(
      `INSERT INTO workflow_env_pointers (workflow_id, environment, version_id) VALUES ($1, 'staging', $2)`,
      [wf, v],
    );

    await db.query(`DELETE FROM workflow_versions WHERE id = $1`, [v]);
    const afterVersionDelete = await db.query(`SELECT 1 FROM workflow_env_pointers WHERE workflow_id = $1`, [
      wf,
    ]);
    expect(afterVersionDelete.rows).toHaveLength(0);

    await db.query(`DELETE FROM workflows WHERE id = $1`, [wf]);
  });
});
