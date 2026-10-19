import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M039 = readFileSync(
  join(__dirname, '..', 'db', 'migrations', '039_run_step_resumed_backfill.sql'),
  'utf8',
);
const PARKED_DELAY = { slept_until: '2026-01-01T00:00:00.000Z' };

/** 039 gives a wait an older image resumed the end of its step; `db:migrate` re-runs it on every boot. Scratch DB only. */
describe('migration 039: a wait an older image resumed records when it ended (scratch DB)', () => {
  let db: Client;
  const user = randomUUID();

  const run = (id: string, status: string, dryRun = false) =>
    db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at, dry_run)
       VALUES ($1, $1, $2, 'p', $3, now() - interval '5 hours', $4)`,
      [id, user, status, dryRun],
    );
  const step = (
    runId: string,
    key: string,
    kind: string,
    finishedAgo: string | null,
    output: unknown = null,
    resumedAgo: string | null = null,
  ) =>
    db.query(
      `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at, finished_at, output, resumed_at)
       VALUES (gen_random_uuid(), $1, $2, $2, $3, $4, now() - interval '4 hours', now() - ($5)::interval,
               CAST($6 AS json), now() - ($7)::interval)`,
      [
        runId,
        key,
        kind,
        finishedAgo ? 'completed' : 'running',
        finishedAgo,
        JSON.stringify(output),
        resumedAgo,
      ],
    );
  const resumedAgoMinutes = async (runId: string, key: string): Promise<number | null> => {
    const r = await db.query<{ ago: number | null }>(
      `SELECT round(extract(epoch FROM now() - resumed_at) / 60)::int AS ago
         FROM runtime_run_steps WHERE run_id = $1 AND step_key = $2`,
      [runId, key],
    );
    return r.rows[0]!.ago;
  };

  beforeAll(async () => {
    db = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await db.connect();
    await db.query('DROP INDEX ix_runtime_run_steps_resumed');

    await run('resumed', 'running');
    await step('resumed', 'approve', 'waitForEvent', '3 hours', { decision: 'yes' });
    await step('resumed', 'nap', 'delay', '20 minutes', PARKED_DELAY);
    await step('resumed', 'blink', 'delay', '10 minutes');
    await step('resumed', 'send', 'action', '5 minutes');
    await step('resumed', 'recorded', 'waitForEvent', '30 minutes', null, '31 minutes');
    await run('dry', 'running', true);
    await step('dry', 'approve', 'waitForEvent', '10 minutes', { dry_run: true, withheld: 'wait' });
    await run('still-parked', 'waiting');
    await step('still-parked', 'approve', 'waitForEvent', null);
    await step('still-parked', 'earlier', 'waitForEvent', '15 minutes');
    await run('ended', 'completed');
    await step('ended', 'approve', 'waitForEvent', '30 minutes');

    await db.query(M039);
    await db.query(M039);
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it('gives each wait a live run parked and an older image resumed the end of its step, and nothing else', async () => {
    expect(await resumedAgoMinutes('resumed', 'approve')).toBe(180);
    expect(await resumedAgoMinutes('resumed', 'nap')).toBe(20);
    expect(await resumedAgoMinutes('resumed', 'blink')).toBeNull();
    expect(await resumedAgoMinutes('resumed', 'send')).toBeNull();
    expect(await resumedAgoMinutes('resumed', 'recorded')).toBe(31);
    expect(await resumedAgoMinutes('dry', 'approve')).toBeNull();
    expect(await resumedAgoMinutes('still-parked', 'approve')).toBeNull();
    expect(await resumedAgoMinutes('still-parked', 'earlier')).toBe(15);
    expect(await resumedAgoMinutes('ended', 'approve')).toBeNull();
  });

  it('creates the index the reaper reads a run’s latest resume through', async () => {
    const r = await db.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'ix_runtime_run_steps_resumed'`);
    expect(r.rowCount).toBe(1);
  });
});
