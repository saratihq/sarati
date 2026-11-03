import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M048 = readFileSync(join(__dirname, '..', 'db', 'migrations', '048_run_limits.sql'), 'utf8');

const SHAPE = `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
                WHERE table_name = 'runtime_runs' AND column_name IN ('active_since', 'limits', 'steps_used') ORDER BY column_name`;
const INDEX = `SELECT indexdef FROM pg_indexes
                WHERE indexname IN ('ix_runtime_runs_workspace_unfinished', 'ix_runtime_run_steps_open') ORDER BY indexname`;

// How a release before 048 records a run: it names its own columns, none of 048's.
const EARLIER_RUN = `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at)
                     VALUES ($1, $1, '00000000-0000-0000-0000-000000000001', 'p', 'running', now())`;

describe('migration 048: a run keeps the limits it was admitted under and the steps its tree took (scratch DB)', () => {
  let upgraded: Client;
  let fresh: Client;

  beforeAll(async () => {
    upgraded = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    fresh = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await Promise.all([upgraded.connect(), fresh.connect()]);
    await upgraded.query(`DROP INDEX ix_runtime_runs_workspace_unfinished, ix_runtime_run_steps_open`);
    await upgraded.query(
      `ALTER TABLE runtime_runs DROP COLUMN limits, DROP COLUMN steps_used, DROP COLUMN active_since`,
    );
    await upgraded.query(EARLIER_RUN, ['before-upgrade']);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([upgraded.end(), fresh.end()]);
  });

  it('048 adds its columns and indexes, runs twice to the same schema, and reads a row from before it as unlimited, with no steps used and its time counted from its start', async () => {
    await upgraded.query(M048);
    await upgraded.query(EARLIER_RUN, ['after-rollback']);
    await upgraded.query(M048);

    expect((await upgraded.query(SHAPE)).rows).toEqual([
      {
        column_name: 'active_since',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
        column_default: null,
      },
      { column_name: 'limits', data_type: 'json', is_nullable: 'YES', column_default: null },
      { column_name: 'steps_used', data_type: 'integer', is_nullable: 'NO', column_default: '0' },
    ]);
    expect((await upgraded.query(SHAPE)).rows).toEqual((await fresh.query(SHAPE)).rows);
    expect((await upgraded.query(INDEX)).rows).toEqual((await fresh.query(INDEX)).rows);
    expect((await upgraded.query(INDEX)).rows).toHaveLength(2);
    const runs = await upgraded.query(
      `SELECT id, limits, steps_used, active_since FROM runtime_runs ORDER BY id`,
    );
    expect(runs.rows).toEqual([
      { id: 'after-rollback', limits: null, steps_used: 0, active_since: null },
      { id: 'before-upgrade', limits: null, steps_used: 0, active_since: null },
    ]);
  });
});
