import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M045 = readFileSync(
  join(__dirname, '..', 'db', 'migrations', '045_composio_delivery_admitted.sql'),
  'utf8',
);

const COLUMN = `SELECT data_type, is_nullable, column_default FROM information_schema.columns
                 WHERE table_name = 'composio_webhook_deliveries' AND column_name = 'admitted_at'`;

// How a release before 045 claims a delivery: it names no admitted_at, and fires its runs as it claims.
const EARLIER_CLAIM = `INSERT INTO composio_webhook_deliveries (webhook_id, trigger_id, received_at) VALUES ($1, 'ti_1', now())`;

describe('migration 045: a Composio delivery records when its runs were admitted (scratch DB)', () => {
  let upgraded: Client;
  let fresh: Client;

  beforeAll(async () => {
    upgraded = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    fresh = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await Promise.all([upgraded.connect(), fresh.connect()]);
    await upgraded.query('ALTER TABLE composio_webhook_deliveries DROP COLUMN admitted_at');
    await upgraded.query(EARLIER_CLAIM, ['msg_before_upgrade']);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([upgraded.end(), fresh.end()]);
  });

  it("counts every claim an earlier release makes as admitted, before the upgrade and after a rollback, leaves this release's unadmitted, a re-run changes nothing, and the column matches a fresh schema", async () => {
    await upgraded.query(M045);
    await upgraded.query(EARLIER_CLAIM, ['msg_after_rollback']);
    await upgraded.query(
      `INSERT INTO composio_webhook_deliveries (webhook_id, trigger_id, received_at, admitted_at) VALUES ('msg_this_release', 'ti_1', now(), NULL)`,
    );
    await upgraded.query(M045);

    const claims = await upgraded.query<{ webhook_id: string; admitted: boolean }>(
      `SELECT webhook_id, admitted_at IS NOT NULL AS admitted FROM composio_webhook_deliveries ORDER BY webhook_id`,
    );
    expect(claims.rows).toEqual([
      { webhook_id: 'msg_after_rollback', admitted: true },
      { webhook_id: 'msg_before_upgrade', admitted: true },
      { webhook_id: 'msg_this_release', admitted: false },
    ]);
    const column = (await upgraded.query(COLUMN)).rows;
    expect(column).toEqual([
      { data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: 'now()' },
    ]);
    expect(column).toEqual((await fresh.query(COLUMN)).rows);
  });
});
