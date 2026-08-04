import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';
const mig = (name: string): string => readFileSync(join(__dirname, '..', 'db', 'migrations', name), 'utf8');
const M005 = mig('005_env_promotion_pointers.sql');
const M006 = mig('006_environments.sql');
const M008 = mig('008_production_rename.sql');

/**
 * The `prod` → `production` chain (005 seed, 006 backfill, 008 rename) MUST survive the
 * ledger-free re-run `db:migrate` performs every time. Scratch DB only — NEVER a live one.
 */
describe('migration idempotency: prod → production re-run (scratch DB)', () => {
  let db: Client;

  const userId = randomUUID();
  // Org A: already-clean `production` (the post-008 shape a re-run must not disturb).
  const orgA = randomUUID();
  const wfA = randomUUID();
  const vA = randomUUID();
  const envProdA = randomUUID();
  // Org B: a SPLIT state — both `prod` and `production` env + pointer for one workflow.
  const orgB = randomUUID();
  const wfB = randomUUID();
  const vB = randomUUID();
  const envProdB = randomUUID();
  const envProductionB = randomUUID();
  const connB = randomUUID();

  const runChain = async (): Promise<void> => {
    await db.query(M005);
    await db.query(M006);
    await db.query(M008);
  };

  beforeAll(async () => {
    const url = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: url });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'mig@e2e.local', 'Mig', now(), now())`,
      [userId],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Org A', false, now(), now()), ($2, 'Org B', false, now(), now())`,
      [orgA, orgB],
    );
    await db.query(
      `INSERT INTO workflows (id, name, source, user_id, org_id, created_at, updated_at)
       VALUES ($1, 'wf a', 'generated', $3, $4, now(), now()),
              ($2, 'wf b', 'generated', $3, $5, now(), now())`,
      [wfA, wfB, userId, orgA, orgB],
    );
    await db.query(
      `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json, created_at)
       VALUES ($1, $2, 1, '{}', now()), ($3, $4, 1, '{}', now())`,
      [vA, wfA, vB, wfB],
    );
    // active_version_id is what 005 seeds a live pointer from.
    await db.query(`UPDATE workflows SET active_version_id = $2 WHERE id = $1`, [wfA, vA]);
    await db.query(`UPDATE workflows SET active_version_id = $2 WHERE id = $1`, [wfB, vB]);

    // Org A — the clean post-008 shape: one `production` env, one `production` pointer.
    await db.query(
      `INSERT INTO environments (id, org_id, name, is_prod) VALUES ($1, $2, 'production', true)`,
      [envProdA, orgA],
    );
    await db.query(
      `INSERT INTO workflow_env_pointers (workflow_id, environment, version_id, environment_id) VALUES ($1, 'production', $2, $3)`,
      [wfA, vA, envProdA],
    );

    // Org B — the SPLIT: `prod` AND `production` env (both is_prod), and both pointers.
    await db.query(
      `INSERT INTO environments (id, org_id, name, is_prod) VALUES ($1, $3, 'prod', true), ($2, $3, 'production', true)`,
      [envProdB, envProductionB, orgB],
    );
    await db.query(
      `INSERT INTO workflow_env_pointers (workflow_id, environment, version_id, environment_id)
       VALUES ($1, 'prod', $2, $3), ($1, 'production', $2, $4)`,
      [wfB, vB, envProdB, envProductionB],
    );
    // A slot on the DUP `prod` env — it must MOVE to `production` on merge, not vanish to CASCADE.
    await db.query(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status, org_id)
       VALUES ($1, $2, 'slack', 'managed', 'enc', now(), 'active', $3)`,
      [connB, userId, orgB],
    );
    await db.query(
      `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, 'slack', $2)`,
      [envProdB, connB],
    );
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it('a clean production DB re-runs without resurrecting prod (005 guard + 008 stays put)', async () => {
    await runChain();

    const ptrs = await db.query(
      `SELECT environment FROM workflow_env_pointers WHERE workflow_id = $1 ORDER BY environment`,
      [wfA],
    );
    expect(ptrs.rows).toEqual([{ environment: 'production' }]);
    const envs = await db.query(`SELECT name, is_prod FROM environments WHERE org_id = $1`, [orgA]);
    expect(envs.rows).toEqual([{ name: 'production', is_prod: true }]);
  });

  it('a split prod+production DB converges: the prod env folds into production, references move, nothing is lost', async () => {
    const envs = await db.query(`SELECT name FROM environments WHERE org_id = $1 ORDER BY name`, [orgB]);
    expect(envs.rows).toEqual([{ name: 'production' }]);

    const ptrs = await db.query(
      `SELECT environment FROM workflow_env_pointers WHERE workflow_id = $1 ORDER BY environment`,
      [wfB],
    );
    expect(ptrs.rows).toEqual([{ environment: 'production' }]);

    // The slot rode the merge over to production — not cascade-deleted with the prod env.
    const slot = await db.query(
      `SELECT e.name FROM environment_connections ec JOIN environments e ON e.id = ec.environment_id
        WHERE ec.app = 'slack' AND e.org_id = $1`,
      [orgB],
    );
    expect(slot.rows).toEqual([{ name: 'production' }]);
  });

  it('re-running the whole chain twice more is a no-op (the property db:migrate relies on)', async () => {
    await expect(runChain()).resolves.toBeUndefined();
    await runChain();

    const stray = await db.query(
      `SELECT
         (SELECT count(*)::int FROM environments WHERE lower(name) = 'prod') AS envs,
         (SELECT count(*)::int FROM workflow_env_pointers WHERE lower(environment) = 'prod') AS ptrs`,
    );
    expect(stray.rows[0]).toEqual({ envs: 0, ptrs: 0 });

    // Both workflows still hold exactly their single production pointer.
    const counts = await db.query(
      `SELECT count(*)::int AS n FROM workflow_env_pointers WHERE workflow_id = ANY($1)`,
      [[wfA, wfB]],
    );
    expect(counts.rows[0].n).toBe(2);
  });
});
