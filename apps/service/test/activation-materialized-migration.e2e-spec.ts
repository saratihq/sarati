import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M030 = readFileSync(
  join(__dirname, '..', 'db', 'migrations', '030_activation_materialized.sql'),
  'utf8',
);

describe('migration 030: an activation records what it stood up (scratch DB)', () => {
  let db: Client;
  const activation = randomUUID();

  beforeAll(async () => {
    db = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await db.connect();
    await db.query('ALTER TABLE runtime_trigger_activations DROP COLUMN materialized');
    const [org, workflow, env] = [randomUUID(), randomUUID(), randomUUID()];
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'o', false, now(), now())`,
      [org],
    );
    await db.query(`INSERT INTO workflows (id, name, org_id) VALUES ($1, 'w', $2)`, [workflow, org]);
    await db.query(`INSERT INTO environments (id, org_id, name) VALUES ($1, $2, 'production')`, [env, org]);
    await db.query(
      `INSERT INTO runtime_trigger_activations (id, workflow_id, environment_id, trigger_node_id, kind, trigger_type)
       VALUES ($1, $2, $3, 'trigger', 'registered_webhook', 'stripe.new_customer')`,
      [activation, workflow, env],
    );
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it('adds the column once, leaves an existing row unknown, and a re-run changes nothing', async () => {
    await db.query(M030);
    await db.query(M030);
    const column = await db.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'runtime_trigger_activations' AND column_name = 'materialized'`,
    );
    expect(column.rows).toEqual([{ data_type: 'jsonb' }]);
    const row = await db.query(`SELECT materialized FROM runtime_trigger_activations WHERE id = $1`, [
      activation,
    ]);
    expect(row.rows).toEqual([{ materialized: null }]);
  });
});
