import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { RunReaperService } from '../src/runs/run-reaper.service';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** The reaper errors out crashed non-terminal runs; RUN_MAX_DURATION_SECONDS defaults to 3600. */
describe('run durability reaper (B8, e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;
  let reaper: RunReaperService;
  const userId = randomUUID();

  /** A step parked on `topic` (a timer wakes itself; anything else waits on a person) until `timeoutAt`, a SQL expr. */
  interface ParkedWait {
    stepKey?: string;
    topic?: string;
    timeoutAt: string;
  }

  const insertRun = async (over: {
    status: string;
    startedAgo: string; // interval, e.g. '2 hours'
    parked?: ParkedWait[];
  }): Promise<string> => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at)
       VALUES ($1, $2, $3, 'plan-x', $4, now() - ($5)::interval)`,
      [id, `rid-${id.slice(0, 8)}`, userId, over.status, over.startedAgo],
    );
    for (const wait of over.parked ?? []) {
      const topic = wait.topic ?? 'approve';
      const stepKey = wait.stepKey ?? 'n1';
      await db.query(
        `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at,
                                        waiting_topic, waiting_since, waiting_timeout_at)
         VALUES (gen_random_uuid(), $1, $2, $2, $3, 'running', now() - ($4)::interval,
                 $5, now() - ($4)::interval, ${wait.timeoutAt})`,
        [id, stepKey, topic.startsWith('orchestr:timer:') ? 'delay' : 'waitForEvent', over.startedAgo, topic],
      );
    }
    return id;
  };
  const stepsOf = async (id: string): Promise<Array<{ status: string; waiting_topic: string | null }>> =>
    (
      await db.query(
        `SELECT status, waiting_topic FROM runtime_run_steps WHERE run_id = $1 ORDER BY step_key`,
        [id],
      )
    ).rows as Array<{ status: string; waiting_topic: string | null }>;
  const statusOf = async (
    id: string,
  ): Promise<{ status: string; finished: boolean; error: string | null }> => {
    const r = await db.query(`SELECT status, finished_at, error FROM runtime_runs WHERE id = $1`, [id]);
    return { status: r.rows[0].status, finished: r.rows[0].finished_at !== null, error: r.rows[0].error };
  };

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.MOCK_AUTH = 'true';
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'reaper@e2e.local', 'Reaper', now(), now())`,
      [userId],
    );
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    reaper = app.get(RunReaperService);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  it('reaps a crashed (stale running) run to error, leaves a live (recent running) run alone', async () => {
    const stale = await insertRun({ status: 'running', startedAgo: '2 hours' });
    const live = await insertRun({ status: 'running', startedAgo: '1 minute' });

    const result = await reaper.reapStale();
    expect(result.crashedRuns).toBeGreaterThanOrEqual(1);

    const s = await statusOf(stale);
    expect(s.status).toBe('error');
    expect(s.finished).toBe(true);
    expect(s.error).toMatch(/crashed|killed|did not complete/i);

    expect((await statusOf(live)).status).toBe('running'); // untouched — could still be running
  });

  it('terminates a waiting run whose approval window elapsed; leaves a fresh waiting run paused', async () => {
    const expired = await insertRun({
      status: 'waiting',
      startedAgo: '30 minutes',
      parked: [{ timeoutAt: `now() - interval '5 minutes'` }],
    });
    const pending = await insertRun({
      status: 'waiting',
      startedAgo: '30 minutes',
      parked: [{ timeoutAt: `now() + interval '1 hour'` }],
    });

    const result = await reaper.reapStale();
    expect(result.timedOutWaits).toBeGreaterThanOrEqual(1);

    const e = await statusOf(expired);
    expect(e.status).toBe('error');
    expect(e.error).toMatch(/approval window/i);

    expect((await statusOf(pending)).status).toBe('waiting'); // still awaiting a decision
  });

  it('reaps an orphaned (stale running) step to error', async () => {
    const run = await insertRun({ status: 'running', startedAgo: '3 hours' }); // `run` is the uuid id
    await db.query(
      `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at)
       VALUES ($1, $2, 'k1', 'n1', 'action', 'running', now() - interval '3 hours')`,
      [randomUUID(), run], // steps.run_id FKs runtime_runs(id)
    );
    const result = await reaper.reapStale();
    expect(result.orphanSteps).toBeGreaterThanOrEqual(1);
    const step = await db.query(`SELECT status FROM runtime_run_steps WHERE run_id = $1`, [run]);
    expect(step.rows[0].status).toBe('error');
  });

  it('leaves a run that is asleep on purpose alone, however long the sleep', async () => {
    // A four-day wait: parked, far past the wall-clock cap, and nowhere near its own wake time.
    const sleeping = await insertRun({
      status: 'waiting',
      startedAgo: '3 days',
      parked: [{ topic: 'orchestr:timer:pause', timeoutAt: `now() + interval '1 day'` }],
    });
    await reaper.reapStale();
    expect(await statusOf(sleeping)).toMatchObject({ status: 'waiting', finished: false });
  });

  it('leaves the wait STEP running too — a parked run has not stalled', async () => {
    const sleeping = await insertRun({
      status: 'waiting',
      startedAgo: '3 days',
      parked: [{ topic: 'orchestr:timer:pause', timeoutAt: `now() + interval '1 day'` }],
    });
    await reaper.reapStale();
    expect(await stepsOf(sleeping)).toEqual([{ status: 'running', waiting_topic: 'orchestr:timer:pause' }]);
  });

  it('does reap a timer wait that is far past its wake — nothing brought it back', async () => {
    const overdue = await insertRun({
      status: 'waiting',
      startedAgo: '5 days',
      parked: [{ topic: 'orchestr:timer:pause', timeoutAt: `now() - interval '2 days'` }],
    });
    await reaper.reapStale();
    const row = await statusOf(overdue);
    expect(row.status).toBe('error');
    expect(row.error).toMatch(/never woke/i);
  });

  it('leaves a run parked on a timer and an approval alone while both are within their windows', async () => {
    const both = await insertRun({
      status: 'waiting',
      startedAgo: '3 days',
      parked: [
        { stepKey: 'approve', timeoutAt: `now() + interval '1 hour'` },
        { stepKey: 'pause', topic: 'orchestr:timer:pause', timeoutAt: `now() + interval '1 day'` },
      ],
    });
    await reaper.reapStale();
    expect(await statusOf(both)).toMatchObject({ status: 'waiting', finished: false });
    expect(await stepsOf(both)).toEqual([
      { status: 'running', waiting_topic: 'approve' },
      { status: 'running', waiting_topic: 'orchestr:timer:pause' },
    ]);
  });

  it('reaps a run once ANY parked wait has lapsed, and ends every step it had parked', async () => {
    const lapsed = await insertRun({
      status: 'waiting',
      startedAgo: '30 minutes',
      parked: [
        { stepKey: 'approve', timeoutAt: `now() - interval '5 minutes'` },
        { stepKey: 'pause', topic: 'orchestr:timer:pause', timeoutAt: `now() + interval '1 day'` },
      ],
    });
    await reaper.reapStale();
    const row = await statusOf(lapsed);
    expect(row).toMatchObject({ status: 'error', finished: true });
    expect(row.error).toMatch(/approval window/i);
    expect(await stepsOf(lapsed)).toEqual([
      { status: 'error', waiting_topic: null },
      { status: 'error', waiting_topic: null },
    ]);
  });

  it('never reaps a run over a lapsed wait left on a step that already finished', async () => {
    const parkedLater = await insertRun({
      status: 'waiting',
      startedAgo: '30 minutes',
      parked: [{ stepKey: 'approve2', topic: 'approval2', timeoutAt: `now() + interval '1 hour'` }],
    });
    await db.query(
      `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at, finished_at,
                                      waiting_topic, waiting_since, waiting_timeout_at)
       VALUES (gen_random_uuid(), $1, 'approve', 'approve', 'waitForEvent', 'completed', now() - interval '30 minutes',
               now() - interval '20 minutes', 'approval', now() - interval '30 minutes', now() - interval '5 minutes')`,
      [parkedLater],
    );
    await reaper.reapStale();
    expect(await statusOf(parkedLater)).toMatchObject({ status: 'waiting', finished: false });
  });

  it('reaps a waiting run with nothing parked once past the max duration — nothing can bring it back', async () => {
    const stranded = await insertRun({ status: 'waiting', startedAgo: '2 hours' });
    const fresh = await insertRun({ status: 'waiting', startedAgo: '1 minute' });
    await reaper.reapStale();
    const row = await statusOf(stranded);
    expect(row.status).toBe('error');
    expect(row.error).toMatch(/did not complete/i);
    expect((await statusOf(fresh)).status).toBe('waiting');
  });

  it('is idempotent — a second sweep reaps nothing new', async () => {
    const result = await reaper.reapStale();
    expect(result.crashedRuns).toBe(0);
    expect(result.timedOutWaits).toBe(0);
    expect(result.orphanSteps).toBe(0);
  });
});
