import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';
const MIGRATION = readFileSync(join(__dirname, '..', 'db', 'migrations', '006_environments.sql'), 'utf8');

/**
 * Retrofit migration 006 (ADR 0014) proven against a scratch DB rolled back to the pre-006
 * shape — NEVER a live one. `runtime_triggers` is gone (ADR 0024), so that backfill no-ops.
 */
describe('migration 006 — environments model (scratch DB)', () => {
  let db: Client;

  const userId = randomUUID();
  const orgId = randomUUID();
  const wfOrg = randomUUID(); // org workflow: prod + staging pointers
  const wfLoose = randomUUID(); // ORG-LESS workflow: its pointer must stay name-only
  const vOrg = randomUUID();
  const vLoose = randomUUID();
  const clusterConn = randomUUID(); // legacy (org, 'prod', slack) cluster row

  beforeAll(async () => {
    const url = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: url });
    await db.connect();

    // Post-006 tables (migrations 009 + 017) FK environments, so they must be dropped first.
    await db.query(`DROP TABLE IF EXISTS public.webhook_trigger_secrets`);
    await db.query(`DROP TABLE public.runtime_activation_store`);
    await db.query(`DROP TABLE public.runtime_trigger_activations`);
    await db.query(`ALTER TABLE public.workflow_env_pointers DROP COLUMN environment_id`);
    await db.query(`ALTER TABLE public.runtime_runs DROP COLUMN environment_id`);
    await db.query(`DROP TABLE public.environment_connections`);
    await db.query(`DROP TABLE public.environments`);

    // Seed a pre-006 production shape.
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'mig006@e2e.local', 'Mig', now(), now())`,
      [userId],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at)
       VALUES ($1, 'Mig Org', false, now(), now())`,
      [orgId],
    );
    await db.query(
      `INSERT INTO workflows (id, name, source, user_id, org_id, created_at, updated_at)
       VALUES ($1, 'org wf', 'generated', $3, $4, now(), now()),
              ($2, 'loose wf', 'generated', $3, NULL, now(), now())`,
      [wfOrg, wfLoose, userId, orgId],
    );
    await db.query(
      `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json, created_at)
       VALUES ($1, $2, 1, '{}', now()), ($3, $4, 1, '{}', now())`,
      [vOrg, wfOrg, vLoose, wfLoose],
    );
    await db.query(
      `INSERT INTO workflow_env_pointers (workflow_id, environment, version_id)
       VALUES ($1, 'prod', $2), ($1, 'staging', $2), ($3, 'staging', $4)`,
      [wfOrg, vOrg, wfLoose, vLoose],
    );
    // A legacy per-env CLUSTER connection (ADR 0005 shape: org_id + environment).
    await db.query(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status, org_id, environment)
       VALUES ($1, $2, 'slack', 'managed', 'enc', now(), 'active', $3, 'prod')`,
      [clusterConn, userId, orgId],
    );
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it('applies cleanly: env rows per distinct legacy string per org; pointers/triggers keyed; clusters become slots', async () => {
    await db.query(MIGRATION);

    // Exactly the org's two legacy names became rows; 'prod' anchors is_prod.
    const envs = await db.query(`SELECT org_id, name, is_prod FROM environments ORDER BY is_prod DESC, name`);
    expect(envs.rows).toEqual([
      { org_id: orgId, name: 'prod', is_prod: true },
      { org_id: orgId, name: 'staging', is_prod: false },
    ]);

    // The ORG-LESS workflow's pointer stays name-only — no org means no env rows.
    const pointers = await db.query(
      `SELECT p.workflow_id, p.environment, e.name AS env_name
         FROM workflow_env_pointers p LEFT JOIN environments e ON e.id = p.environment_id
        ORDER BY p.workflow_id = $1 DESC, p.environment`,
      [wfOrg],
    );
    expect(pointers.rows).toEqual([
      { workflow_id: wfOrg, environment: 'prod', env_name: 'prod' },
      { workflow_id: wfOrg, environment: 'staging', env_name: 'staging' },
      { workflow_id: wfLoose, environment: 'staging', env_name: null },
    ]);

    // The legacy cluster connection became prod's slack SLOT, its own row untouched.
    const slots = await db.query(
      `SELECT e.name AS env, ec.app, ec.connection_id FROM environment_connections ec
         JOIN environments e ON e.id = ec.environment_id`,
    );
    expect(slots.rows).toEqual([{ env: 'prod', app: 'slack', connection_id: clusterConn }]);
    const conn = await db.query(`SELECT org_id, environment FROM connections WHERE id = $1`, [clusterConn]);
    expect(conn.rows).toEqual([{ org_id: orgId, environment: 'prod' }]);
  });

  it('re-applying is a no-op (idempotent)', async () => {
    await db.query(MIGRATION); // second apply

    const counts = await db.query(
      `SELECT (SELECT COUNT(*) FROM environments)::int AS envs,
              (SELECT COUNT(*) FROM environment_connections)::int AS slots,
              (SELECT COUNT(*) FROM workflow_env_pointers)::int AS pointers`,
    );
    expect(counts.rows).toEqual([{ envs: 2, slots: 1, pointers: 3 }]);
  });

  it('FKs behave: env delete cascades slots + pointers and preserves run history names', async () => {
    const staging = await db.query(`SELECT id FROM environments WHERE name = 'staging'`);
    const stagingId = (staging.rows[0] as { id: string }).id;

    // A run that executed under staging — history must survive the env's death.
    await db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at, environment, environment_id)
       VALUES ($1, $2, $3, 'p', 'completed', now(), 'staging', $4)`,
      [`${userId}:mig-run`, 'mig-run', userId, stagingId],
    );

    await db.query(`DELETE FROM environments WHERE id = $1`, [stagingId]);

    const pointer = await db.query(
      `SELECT 1 FROM workflow_env_pointers WHERE workflow_id = $1 AND environment = 'staging'`,
      [wfOrg],
    );
    expect(pointer.rows).toHaveLength(0); // pointer died with its env (CASCADE)
    const run = await db.query(
      `SELECT environment, environment_id FROM runtime_runs WHERE run_id = 'mig-run'`,
    );
    expect(run.rows).toEqual([{ environment: 'staging', environment_id: null }]); // snapshot survives
  });
});
