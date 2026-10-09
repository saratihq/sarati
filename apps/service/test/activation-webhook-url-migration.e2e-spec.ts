import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M032 = readFileSync(
  join(__dirname, '..', 'db', 'migrations', '032_activation_webhook_url.sql'),
  'utf8',
);

describe('migration 032: an activation records the intake URL it was registered at (scratch DB)', () => {
  let db: Client;
  const activation = randomUUID();

  beforeAll(async () => {
    db = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await db.connect();
    await db.query('ALTER TABLE runtime_trigger_activations DROP COLUMN webhook_url');
    const [org, workflow, env] = [randomUUID(), randomUUID(), randomUUID()];
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'o', false, now(), now())`,
      [org],
    );
    await db.query(`INSERT INTO workflows (id, name, org_id) VALUES ($1, 'w', $2)`, [workflow, org]);
    await db.query(`INSERT INTO environments (id, org_id, name) VALUES ($1, $2, 'staging')`, [env, org]);
    await db.query(
      `INSERT INTO runtime_trigger_activations (id, workflow_id, environment_id, trigger_node_id, kind, trigger_type)
       VALUES ($1, $2, $3, 'trigger', 'registered_webhook', 'github.new_push')`,
      [activation, workflow, env],
    );
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it('adds the column once, leaves an existing row without a URL, and a re-run changes nothing', async () => {
    await db.query(M032);
    await db.query(M032);
    const column = await db.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'runtime_trigger_activations' AND column_name = 'webhook_url'`,
    );
    expect(column.rows).toEqual([{ data_type: 'text' }]);
    const row = await db.query(`SELECT webhook_url FROM runtime_trigger_activations WHERE id = $1`, [
      activation,
    ]);
    expect(row.rows).toEqual([{ webhook_url: null }]);
  });
});
