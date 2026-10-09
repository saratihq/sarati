import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M031 = readFileSync(
  join(__dirname, '..', 'db', 'migrations', '031_trigger_retired_webhooks.sql'),
  'utf8',
);

describe('migration 031: pending webhook deletes kept apart from activations (scratch DB)', () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await db.connect();
    await db.query('DROP TABLE trigger_retired_webhooks');
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it('creates the table once, a re-run changes nothing, and an entry needs no live workflow or environment', async () => {
    await db.query(M031);
    const entry = randomUUID();
    await db.query(
      `INSERT INTO trigger_retired_webhooks (id, workflow_id, environment_id, trigger_node_id, webhook)
       VALUES ($1, $2, $3, 'trigger', '{"triggerType":"stripe.new_customer"}')`,
      [entry, randomUUID(), randomUUID()],
    );
    await db.query(M031);

    const rows = await db.query(`SELECT id FROM trigger_retired_webhooks`);
    expect(rows.rows).toEqual([{ id: entry }]);
    const foreignKeys = await db.query(
      `SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'trigger_retired_webhooks' AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(foreignKeys.rows).toEqual([]);
    const index = await db.query(
      `SELECT 1 FROM pg_indexes WHERE tablename = 'trigger_retired_webhooks' AND indexname = 'ix_trigger_retired_webhooks_workflow'`,
    );
    expect(index.rows).toHaveLength(1);
  });
});
