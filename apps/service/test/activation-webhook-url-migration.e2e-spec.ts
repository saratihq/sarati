import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M032 = readFileSync(
  join(__dirname, '..', 'db', 'migrations', '032_activation_webhook_url.sql'),
  'utf8',
);

const URL = 'https://hooks.example.com/api/hooks/wf/production';
const LIVE = {
  kind: 'registered_webhook',
  triggerType: 'github.new_push',
  props: {},
  connection: null,
  paused: false,
};

describe('migration 032: an activation records the intake URL it was registered at (scratch DB)', () => {
  let db: Client;
  const [unrecorded, recorded, bareHandle] = [randomUUID(), randomUUID(), randomUUID()];

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
    for (const [id, node] of [
      [unrecorded, 'unrecorded'],
      [recorded, 'recorded'],
      [bareHandle, 'bare'],
    ]) {
      await db.query(
        `INSERT INTO runtime_trigger_activations
                (id, workflow_id, environment_id, trigger_node_id, kind, trigger_type, materialized)
         VALUES ($1, $2, $3, $4, 'registered_webhook', 'github.new_push', $5)`,
        [id, workflow, env, node, id === unrecorded ? null : JSON.stringify(LIVE)],
      );
    }
    await db.query(
      `INSERT INTO runtime_activation_store (activation_id, key, value) VALUES
         ($1, 'webhook.registration', $2), ($3, 'webhook.registration', $4)`,
      [
        recorded,
        JSON.stringify({ ...LIVE, webhookUrl: URL, secret: 's', registration: { subscriptionId: '101' } }),
        bareHandle,
        JSON.stringify({ subscriptionId: '102' }),
      ],
    );
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it('adds the column once, carries over the URL a live webhook recorded, and a re-run changes nothing', async () => {
    await db.query(M032);
    await db.query(M032);
    const column = await db.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'runtime_trigger_activations' AND column_name = 'webhook_url'`,
    );
    expect(column.rows).toEqual([{ data_type: 'text' }]);
    const rows = await db.query<{ id: string; webhook_url: string | null; recorded_url: string | null }>(
      `SELECT id, webhook_url, materialized ->> 'webhookUrl' AS recorded_url FROM runtime_trigger_activations`,
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(recorded)).toMatchObject({ webhook_url: URL, recorded_url: URL });
    expect(byId.get(unrecorded)).toMatchObject({ webhook_url: null, recorded_url: null });
    expect(byId.get(bareHandle)).toMatchObject({ webhook_url: null, recorded_url: null });
  });
});
