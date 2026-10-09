import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const M033 = readFileSync(join(__dirname, '..', 'db', 'migrations', '033_run_step_waits.sql'), 'utf8');

interface StepWait {
  step_key: string;
  waiting_topic: string | null;
  waiting_since: Date | null;
  waiting_timeout_at: Date | null;
}

/** 033 puts each wait on the step that parked it; `db:migrate` re-runs it on every boot. Scratch DB only. */
describe('migration 033: a wait lives on the step that parked (scratch DB)', () => {
  let db: Client;
  const user = randomUUID();
  const since = new Date('2026-10-09T08:00:00.000Z');
  const due = new Date('2026-10-09T09:00:00.000Z');

  const run = (id: string, status: string, wait: { node: string; topic: string } | null) =>
    db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, waiting_node_id, waiting_topic, waiting_since, waiting_timeout_at)
       VALUES ($1, $1, $2, 'p', $3, $4, $5, $6, $7)`,
      [id, user, status, wait?.node ?? null, wait?.topic ?? null, wait ? since : null, wait ? due : null],
    );
  const step = (runId: string, stepKey: string, kind: string, status: string) =>
    db.query(
      `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, finished_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::varchar, CASE WHEN $5::varchar = 'running' THEN NULL ELSE now() END)`,
      [runId, stepKey, stepKey.split('/').pop(), kind, status],
    );
  const slotOf = async (runId: string): Promise<string | null> =>
    (
      await db.query<{ waiting_topic: string | null }>(
        `SELECT waiting_topic FROM runtime_runs WHERE id = $1`,
        [runId],
      )
    ).rows[0]!.waiting_topic;
  const waitsOf = async (runId: string): Promise<StepWait[]> =>
    (
      await db.query<StepWait>(
        `SELECT step_key, waiting_topic, waiting_since, waiting_timeout_at
           FROM runtime_run_steps WHERE run_id = $1 ORDER BY step_key`,
        [runId],
      )
    ).rows;
  const parked = (stepKey: string, topic: string): StepWait => ({
    step_key: stepKey,
    waiting_topic: topic,
    waiting_since: since,
    waiting_timeout_at: due,
  });
  const idle = (stepKey: string): StepWait => ({
    step_key: stepKey,
    waiting_topic: null,
    waiting_since: null,
    waiting_timeout_at: null,
  });

  beforeAll(async () => {
    db = new Client({ connectionString: await createE2eDatabase(ADMIN_URL) });
    await db.connect();
    await db.query('DROP INDEX IF EXISTS ix_runtime_run_steps_waiting');
    await db.query(
      `ALTER TABLE runtime_run_steps DROP COLUMN waiting_topic, DROP COLUMN waiting_since,
                                     DROP COLUMN waiting_timeout_at, DROP COLUMN claimed_at`,
    );

    await run('r-approval', 'waiting', { node: 'approve', topic: 'approval' });
    await step('r-approval', 'fetch', 'action', 'completed');
    await step('r-approval', 'approve', 'waitForEvent', 'running');

    await run('r-loop-timer', 'waiting', { node: 'pause', topic: 'orchestr:timer:loop#1/pause' });
    await step('r-loop-timer', 'loop#0/pause', 'delay', 'completed');
    await step('r-loop-timer', 'loop#1/pause', 'delay', 'running');

    // An earlier round whose finish write was lost reads `running` too; only the slot's own step is parked.
    await run('r-lost-finish', 'waiting', { node: 'pause', topic: 'orchestr:timer:loop#1/pause' });
    await db.query(
      `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status)
       VALUES (gen_random_uuid(), 'r-lost-finish', 'loop#0/pause', 'pause', 'delay', 'running')`,
    );
    await step('r-lost-finish', 'loop#1/pause', 'delay', 'running');

    await run('r-done', 'completed', null);
    await step('r-done', 'approve', 'waitForEvent', 'completed');
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it('parks the step that held each in-flight wait, and only that step', async () => {
    await db.query(M033);
    await db.query(M033);
    expect(await waitsOf('r-approval')).toEqual([parked('approve', 'approval'), idle('fetch')]);
    expect(await waitsOf('r-loop-timer')).toEqual([
      idle('loop#0/pause'),
      parked('loop#1/pause', 'orchestr:timer:loop#1/pause'),
    ]);
    expect(await waitsOf('r-lost-finish')).toEqual([
      idle('loop#0/pause'),
      parked('loop#1/pause', 'orchestr:timer:loop#1/pause'),
    ]);
    expect(await waitsOf('r-done')).toEqual([idle('approve')]);
  });

  it("keeps the run's own slot as it was, for an older image to read", async () => {
    const slots = await db.query(`SELECT id, status, waiting_topic FROM runtime_runs ORDER BY id`);
    expect(slots.rows).toEqual([
      { id: 'r-approval', status: 'waiting', waiting_topic: 'approval' },
      { id: 'r-done', status: 'completed', waiting_topic: null },
      { id: 'r-loop-timer', status: 'waiting', waiting_topic: 'orchestr:timer:loop#1/pause' },
      { id: 'r-lost-finish', status: 'waiting', waiting_topic: 'orchestr:timer:loop#1/pause' },
    ]);
  });

  it('moves a wait an older image recorded in the run slot onto its step on the next boot', async () => {
    await run('r-old-image', 'waiting', { node: 'approve', topic: 'approval' });
    await step('r-old-image', 'approve', 'waitForEvent', 'running');
    await db.query(M033);
    expect(await waitsOf('r-old-image')).toEqual([parked('approve', 'approval')]);
    expect(await slotOf('r-old-image')).toBe('approval');
  });

  it('clears a wait an older image ended, so nothing reads a finished step as parked', async () => {
    await run('r-rolled-back', 'waiting', { node: 'approve2', topic: 'approval2' });
    await step('r-rolled-back', 'approve', 'waitForEvent', 'completed');
    await db.query(
      `UPDATE runtime_run_steps SET waiting_topic = 'approval', waiting_since = $2,
              waiting_timeout_at = now() - interval '1 hour'
        WHERE run_id = $1 AND step_key = 'approve'`,
      ['r-rolled-back', since],
    );
    await step('r-rolled-back', 'approve2', 'waitForEvent', 'running');
    await run('r-ended', 'completed', null);
    await step('r-ended', 'pause', 'delay', 'running');
    await db.query(
      `UPDATE runtime_run_steps SET waiting_topic = 'orchestr:timer:pause', waiting_since = $1, waiting_timeout_at = $2
        WHERE run_id = 'r-ended'`,
      [since, due],
    );

    await db.query(M033);
    expect(await waitsOf('r-rolled-back')).toEqual([idle('approve'), parked('approve2', 'approval2')]);
    expect(await waitsOf('r-ended')).toEqual([idle('pause')]);
  });

  it('never re-parks a step whose wait has ended, even when the slot still names it', async () => {
    await db.query(
      `UPDATE runtime_run_steps SET waiting_topic = NULL, waiting_since = NULL, waiting_timeout_at = NULL,
              status = 'completed', finished_at = now()
        WHERE run_id = 'r-approval' AND step_key = 'approve'`,
    );
    await db.query(M033);
    expect(await waitsOf('r-approval')).toEqual([idle('approve'), idle('fetch')]);
  });
});
