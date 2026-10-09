import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M034 = readFileSync(join(__dirname, '..', 'db', 'migrations', '034_run_resumed_at.sql'), 'utf8');
const PARKED_DELAY = { slept_until: '2026-01-01T00:00:00.000Z' };

/** 034 records when a run last resumed; `db:migrate` re-runs it on every boot. Scratch DB only. */
describe('migration 034: a run records when it last resumed (scratch DB)', () => {
  let db: Client;
  const user = randomUUID();

  const run = (id: string, status: string, dryRun = false) =>
    db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at, dry_run)
       VALUES ($1, $1, $2, 'p', $3, now() - interval '5 hours', $4)`,
      [id, user, status, dryRun],
    );
  const step = (runId: string, kind: string, finishedAgo: string | null, output: unknown = null) =>
    db.query(
      `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at, finished_at, output)
       VALUES (gen_random_uuid(), $1, $2, $2, $3, $4, now() - interval '4 hours', now() - ($5)::interval, CAST($6 AS json))`,
      [
        runId,
        `${kind}-${randomUUID().slice(0, 8)}`,
        kind,
        finishedAgo ? 'completed' : 'running',
        finishedAgo,
        JSON.stringify(output),
      ],
    );
  const resumedAgoMinutes = async (id: string): Promise<number | null> => {
    const r = await db.query<{ ago: number | null }>(
      `SELECT round(extract(epoch FROM now() - resumed_at) / 60)::int AS ago FROM runtime_runs WHERE id = $1`,
      [id],
    );
    return r.rows[0]!.ago;
  };

  beforeAll(async () => {
    db = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await db.connect();
    await db.query('ALTER TABLE runtime_runs DROP COLUMN resumed_at');

    await run('resumed', 'running');
    await step('resumed', 'waitForEvent', '3 hours', { decision: 'yes' });
    await step('resumed', 'delay', '20 minutes', PARKED_DELAY);
    await step('resumed', 'delay', '10 minutes');
    await step('resumed', 'action', '5 minutes');
    await run('slept-in-place', 'running');
    await step('slept-in-place', 'delay', '10 minutes');
    await run('dry', 'running', true);
    await step('dry', 'waitForEvent', '10 minutes', { dry_run: true, withheld: 'wait' });
    await run('still-parked', 'waiting');
    await step('still-parked', 'waitForEvent', null);
    await run('ended', 'completed');
    await step('ended', 'waitForEvent', '30 minutes');
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it('gives a running run the end of its last parked wait, and nothing else', async () => {
    await db.query(M034);
    await db.query(M034);
    expect(await resumedAgoMinutes('resumed')).toBe(20);
    expect(await resumedAgoMinutes('slept-in-place')).toBeNull();
    expect(await resumedAgoMinutes('dry')).toBeNull();
    expect(await resumedAgoMinutes('still-parked')).toBeNull();
    expect(await resumedAgoMinutes('ended')).toBeNull();
  });

  it('catches up a run an older image resumed after the upgrade, and never moves a stamp back', async () => {
    await run('old-image', 'running');
    await step('old-image', 'waitForEvent', '2 minutes');
    await db.query(`UPDATE runtime_runs SET resumed_at = now() - interval '4 hours' WHERE id = 'resumed'`);
    await step('resumed', 'waitForEvent', '3 minutes');
    await run('recorder', 'running');
    await step('recorder', 'waitForEvent', '30 minutes');
    await db.query(`UPDATE runtime_runs SET resumed_at = now() - interval '1 minute' WHERE id = 'recorder'`);

    await db.query(M034);
    expect(await resumedAgoMinutes('old-image')).toBe(2);
    expect(await resumedAgoMinutes('resumed')).toBe(3);
    expect(await resumedAgoMinutes('recorder')).toBe(1);
  });
});
