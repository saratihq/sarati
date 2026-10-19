import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { EntityManager } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { RunReaperService } from '../src/runs/run-reaper.service';
import { CLEAR_WAIT, RunRecorderService } from '../src/runtime/run-recorder.service';
import { listenOnLoopback } from './support/listen';
import { expectLastWaitStartsTheClock, expectResumedRunFinishes } from './support/resumed-run';
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

  const blocksSomeone = async (pid: number): Promise<boolean> => {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const waiting = await db.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
        [pid],
      );
      if (waiting.rows.length > 0) return true;
    }
    return false;
  };

  const createApp = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const created = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(created);
    return created;
  };

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'reaper@e2e.local', 'Reaper', now(), now())`,
      [userId],
    );
    app = await createApp();
    await app.init();
    await listenOnLoopback(app);
    reaper = app.get(RunReaperService);
    await reaper.booted();
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
    await db.query(
      `UPDATE runtime_runs SET waiting_node_id = 'approve', waiting_topic = 'approve' WHERE id = $1`,
      [lapsed],
    );
    await reaper.reapStale();
    const row = await statusOf(lapsed);
    expect(row).toMatchObject({ status: 'error', finished: true });
    expect(row.error).toMatch(/approval window/i);
    const slot = await db.query(`SELECT waiting_node_id, waiting_topic FROM runtime_runs WHERE id = $1`, [
      lapsed,
    ]);
    expect(slot.rows).toEqual([{ waiting_node_id: null, waiting_topic: null }]);
    expect(await stepsOf(lapsed)).toEqual([
      { status: 'error', waiting_topic: null },
      { status: 'error', waiting_topic: null },
    ]);
  });

  it('never reaps a run holding a decision it has not taken yet, so the decider is kept for it', async () => {
    const decided = await insertRun({
      status: 'waiting',
      startedAgo: '30 minutes',
      parked: [
        { stepKey: 'approve', timeoutAt: `now() - interval '5 minutes'` },
        { stepKey: 'legal', topic: 'legal', timeoutAt: `now() - interval '5 minutes'` },
      ],
    });
    await db.query(
      `UPDATE runtime_run_steps SET claimed_at = now(), claimed_by = $2, claimed_payload = '{"d":1}'
        WHERE run_id = $1 AND step_key = 'approve'`,
      [decided, userId],
    );
    await reaper.reapStale();
    expect(await statusOf(decided)).toMatchObject({ status: 'waiting', finished: false });
    const claims = await db.query(
      `SELECT step_key, claimed_by FROM runtime_run_steps WHERE run_id = $1 ORDER BY step_key`,
      [decided],
    );
    expect(claims.rows).toEqual([
      { step_key: 'approve', claimed_by: userId },
      { step_key: 'legal', claimed_by: null },
    ]);
    expect(await stepsOf(decided)).toEqual([
      { status: 'running', waiting_topic: 'approve' },
      { status: 'running', waiting_topic: 'legal' },
    ]);
  });

  it('ends a run holding a decision nothing can resume once past its window by the max, keeping who decided', async () => {
    const stranded = await insertRun({
      status: 'waiting',
      startedAgo: '3 hours',
      parked: [{ stepKey: 'approve', timeoutAt: `now() - interval '2 hours'` }],
    });
    await db.query(
      `UPDATE runtime_run_steps SET claimed_at = now() - interval '150 minutes', claimed_by = $2, claimed_payload = '{"d":1}'
        WHERE run_id = $1`,
      [stranded, userId],
    );
    const result = await reaper.reapStale();
    expect(result.strandedDecisions).toBeGreaterThanOrEqual(1);
    const row = await db.query(`SELECT status, error, decided_by FROM runtime_runs WHERE id = $1`, [
      stranded,
    ]);
    expect(row.rows[0]).toEqual({
      status: 'error',
      error: 'Decided by Reaper, but the run could not resume to take the decision — run it again',
      decided_by: userId,
    });
    expect(await stepsOf(stranded)).toEqual([{ status: 'error', waiting_topic: null }]);
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

  it('never reaps a run an older version parked in the run slot, however long it waits', async () => {
    const olderImage = await insertRun({ status: 'waiting', startedAgo: '3 hours' });
    await db.query(
      `UPDATE runtime_runs SET waiting_node_id = 'approve', waiting_topic = 'approval',
              waiting_timeout_at = now() + interval '1 day' WHERE id = $1`,
      [olderImage],
    );
    await reaper.reapStale();
    expect(await statusOf(olderImage)).toMatchObject({ status: 'waiting', finished: false });
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

  it('takes a run before its steps, so a wait change holding the run finishes first and the reap follows', async () => {
    for (const pass of ['lapsed', 'stranded']) {
      const held = await insertRun({
        status: 'waiting',
        startedAgo: '3 hours',
        parked: [{ stepKey: 'approve', timeoutAt: `now() - interval '2 hours'` }],
      });
      if (pass === 'stranded') {
        await db.query(
          `UPDATE runtime_run_steps SET claimed_at = now() - interval '150 minutes', claimed_by = $2 WHERE run_id = $1`,
          [held, userId],
        );
      }
      const wait = new Client({ connectionString: process.env.DATABASE_URL });
      await wait.connect();
      try {
        const pid = (await wait.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await wait.query('BEGIN');
        await wait.query(`SELECT 1 FROM runtime_runs WHERE id = $1 FOR NO KEY UPDATE`, [held]);
        const reaping = reaper.reapStale();
        expect(await blocksSomeone(pid)).toBe(true);
        await wait.query(`UPDATE runtime_run_steps SET attempts = attempts WHERE run_id = $1`, [held]);
        await wait.query('COMMIT');
        await reaping;
      } finally {
        await wait.end();
      }
      expect((await statusOf(held)).status).toBe('error');
    }
  });

  it('leaves a run that finished while the reaper waited on it as it finished, its steps untouched', async () => {
    for (const pass of ['crashed', 'lapsed', 'stranded']) {
      const held = await insertRun({
        status: pass === 'crashed' ? 'running' : 'waiting',
        startedAgo: '3 hours',
        parked: pass === 'crashed' ? [] : [{ stepKey: 'approve', timeoutAt: `now() - interval '2 hours'` }],
      });
      await db.query(`UPDATE runtime_run_steps SET started_at = now() WHERE run_id = $1`, [held]);
      if (pass === 'stranded') {
        await db.query(
          `UPDATE runtime_run_steps SET claimed_at = now() - interval '150 minutes', claimed_by = $2 WHERE run_id = $1`,
          [held, userId],
        );
      }
      const finish = new Client({ connectionString: process.env.DATABASE_URL });
      await finish.connect();
      try {
        const pid = (await finish.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await finish.query('BEGIN');
        await finish.query(
          `UPDATE runtime_runs SET status = 'completed', finished_at = now() WHERE id = $1`,
          [held],
        );
        const reaping = reaper.reapStale();
        expect(await blocksSomeone(pid)).toBe(true);
        await finish.query('COMMIT');
        expect(await reaping).toMatchObject({ crashedRuns: 0, timedOutWaits: 0, strandedDecisions: 0 });
      } finally {
        await finish.end();
      }
      expect(await statusOf(held)).toMatchObject({ status: 'completed', error: null });
      expect(await stepsOf(held)).toEqual(
        pass === 'crashed' ? [] : [{ status: 'running', waiting_topic: 'approve' }],
      );
    }
  });

  it('keeps a run whose stranded decision it takes while the reaper waits on it', async () => {
    const held = await insertRun({
      status: 'waiting',
      startedAgo: '3 hours',
      parked: [
        { stepKey: 'approve', timeoutAt: `now() - interval '2 hours'` },
        { stepKey: 'legal', topic: 'legal', timeoutAt: `now() + interval '1 hour'` },
      ],
    });
    await db.query(
      `UPDATE runtime_run_steps SET claimed_at = now() - interval '150 minutes', claimed_by = $2
        WHERE run_id = $1 AND step_key = 'approve'`,
      [held, userId],
    );
    const resume = new Client({ connectionString: process.env.DATABASE_URL });
    await resume.connect();
    try {
      const pid = (await resume.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await resume.query('BEGIN');
      await resume.query(`SELECT 1 FROM runtime_runs WHERE id = $1 FOR NO KEY UPDATE`, [held]);
      const reaping = reaper.reapStale();
      expect(await blocksSomeone(pid)).toBe(true);
      await resume.query(
        `UPDATE runtime_run_steps SET ${CLEAR_WAIT}, resumed_at = now() WHERE run_id = $1 AND step_key = 'approve'`,
        [held],
      );
      await resume.query('COMMIT');
      expect((await reaping).strandedDecisions).toBe(0);
    } finally {
      await resume.end();
    }
    expect(await statusOf(held)).toMatchObject({ status: 'waiting', finished: false, error: null });
    expect(await stepsOf(held)).toEqual([
      { status: 'running', waiting_topic: null },
      { status: 'running', waiting_topic: 'legal' },
    ]);
  });

  it('counts only the time in flight since a run resumed: one approved after a long wait finishes, never reaped', () =>
    expectResumedRunFinishes(app, db, reaper, 'resumed-1'));

  it('counts a run with two waits from the later one to end, never the first', () =>
    expectLastWaitStartsTheClock(app, db, reaper, 'two-waits-1'));

  it('still reaps a run in flight past the max since it resumed — the worker died after the wait', async () => {
    const run = await insertRun({ status: 'running', startedAgo: '5 hours' });
    await db.query(
      `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at, finished_at, resumed_at)
       VALUES (gen_random_uuid(), $1, 'approve', 'approve', 'waitForEvent', 'completed',
               now() - interval '5 hours', now() - interval '2 hours', now() - interval '2 hours'),
              (gen_random_uuid(), $1, 'next', 'next', 'action', 'running', now() - interval '2 hours', NULL, NULL)`,
      [run],
    );
    await reaper.reapStale();
    expect(await statusOf(run)).toMatchObject({ status: 'error', finished: true });
    expect((await stepsOf(run)).map((s) => s.status)).toEqual(['completed', 'error']);
  });

  it('records when a wait ended even if its unpark write was lost, so the run is not reaped once it resumes', async () => {
    const run = await insertRun({
      status: 'waiting',
      startedAgo: '2 hours',
      parked: [{ stepKey: 'approve', timeoutAt: `now() + interval '1 hour'` }],
    });
    await app.get(RunRecorderService).stepFinished(run, 'approve', { ok: true }, null);
    const step = await db.query(
      `SELECT waiting_topic, resumed_at > now() - interval '1 minute' AS just_resumed FROM runtime_run_steps WHERE run_id = $1`,
      [run],
    );
    expect(step.rows[0]).toEqual({ waiting_topic: null, just_resumed: true });
    expect((await statusOf(run)).status).toBe('running');
    await reaper.reapStale();
    expect((await statusOf(run)).status).toBe('running');
    await db.query(`UPDATE runtime_runs SET status = 'completed', finished_at = now() WHERE id = $1`, [run]);
  });

  it('after an upgrade, never reaps a run an older image resumed — its wait counts from where its step ended', async () => {
    const run = await insertRun({ status: 'running', startedAgo: '2 hours' });
    await db.query(
      `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at, finished_at, output)
       VALUES (gen_random_uuid(), $1, 'approve', 'approve', 'waitForEvent', 'completed',
               now() - interval '2 hours', now() - interval '3 minutes', CAST('{}' AS json)),
              (gen_random_uuid(), $1, 'next', 'next', 'action', 'running', now() - interval '3 minutes', NULL, NULL)`,
      [run],
    );
    await db.query(
      readFileSync(join(__dirname, '..', 'db', 'migrations', '039_run_step_resumed_backfill.sql'), 'utf8'),
    );
    await reaper.reapStale();
    expect((await statusOf(run)).status).toBe('running');
    expect((await stepsOf(run)).map((s) => s.status)).toEqual(['completed', 'running']);
    await db.query(`UPDATE runtime_runs SET status = 'completed', finished_at = now() WHERE id = $1`, [run]);
  });

  it('is idempotent — a second sweep reaps nothing new', async () => {
    const result = await reaper.reapStale();
    expect(result.crashedRuns).toBe(0);
    expect(result.timedOutWaits).toBe(0);
    expect(result.orphanSteps).toBe(0);
  });

  it('starts serving while its boot pass is still held, and shuts down only once the pass has run', async () => {
    const query = EntityManager.prototype.query;
    let arrive!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const spy = jest.spyOn(EntityManager.prototype, 'query').mockImplementation(async function (
      this: EntityManager,
      text: string,
      params?: Parameters<EntityManager['query']>[1],
    ) {
      if (/^SELECT r\.id FROM runtime_runs r WHERE/.test(text)) {
        arrive();
        await released;
      }
      return query.call(this, text, params);
    });
    const second = await createApp();
    const settles = (promise: Promise<unknown>, ms: number): Promise<boolean> =>
      Promise.race([
        promise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ]);
    let passRan = false;
    let closing: Promise<void> | undefined;
    try {
      expect(await settles(second.init(), 5_000)).toBe(true);
      await arrived;
      void second
        .get(RunReaperService)
        .booted()
        .then(() => (passRan = true));
      closing = second.close();
      expect(await settles(closing, 500)).toBe(false);
    } finally {
      release();
      spy.mockRestore();
    }
    await closing;
    expect(passRan).toBe(true);
  });
});
