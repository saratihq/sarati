import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { RunReaperService } from '../src/runs/run-reaper.service';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const irNode = (id: string, node_type: string, parameters: Record<string, unknown>) => ({
  id,
  name: id,
  node_type,
  type_version: 1,
  parameters,
  position: { x: 0, y: 0 },
  metadata: {},
});
const irEdge = (from: string, to: string) => ({
  id: `${from}->${to}`,
  source_node_id: from,
  source_port: 0,
  target_node_id: to,
  target_port: 0,
  port_type: 'main',
});
// Three seconds sleeps in place: the run stays in flight through it.
const inPlaceWait = (id: string) =>
  irNode(id, 'orchestr:wait_for_duration', { amount: 0.05, unit: 'minutes' });

const approvalIr = {
  version: '1.0',
  name: 'resumed run',
  description: '',
  nodes: [
    irNode('approval', 'orchestr:wait_for_event', { topic: 'approve', timeout_ms: 600_000 }),
    inPlaceWait('after'),
    inPlaceWait('spanning'),
  ],
  edges: [irEdge('approval', 'after')],
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
};

/** The reaper errors out crashed non-terminal runs; RUN_MAX_DURATION_SECONDS defaults to 3600. */
describe('run durability reaper (B8, e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;
  let reaper: RunReaperService;
  const userId = randomUUID();

  const insertRun = async (over: {
    status: string;
    startedAgo: string; // interval, e.g. '2 hours'
    resumedAgo?: string;
    waitingTimeoutAt?: string | null; // SQL expr or null
    /** What the run is parked on — a timer wakes itself; anything else waits on a person. */
    waitingTopic?: string;
  }): Promise<string> => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at, waiting_timeout_at, waiting_node_id, waiting_topic, resumed_at)
       VALUES ($1, $2, $3, 'plan-x', $4, now() - ($5)::interval, ${over.waitingTimeoutAt ?? 'NULL'},
               ${over.status === 'waiting' ? `'n1'` : 'NULL'}, $6, now() - ($7)::interval)`,
      [
        id,
        `rid-${id.slice(0, 8)}`,
        userId,
        over.status,
        over.startedAgo,
        over.waitingTopic ?? null,
        over.resumedAgo ?? null,
      ],
    );
    return id;
  };
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
    process.env.THROTTLE_LIMIT = '10000';
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
    await listenOnLoopback(app);
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
      waitingTimeoutAt: `now() - interval '5 minutes'`,
    });
    const pending = await insertRun({
      status: 'waiting',
      startedAgo: '30 minutes',
      waitingTimeoutAt: `now() + interval '1 hour'`,
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
      waitingTimeoutAt: `now() + interval '1 day'`,
      waitingTopic: 'orchestr:timer:pause',
    });
    await reaper.reapStale();
    expect(await statusOf(sleeping)).toMatchObject({ status: 'waiting', finished: false });
  });

  it('leaves the wait STEP running too — a parked run has not stalled', async () => {
    const sleeping = await insertRun({
      status: 'waiting',
      startedAgo: '3 days',
      waitingTimeoutAt: `now() + interval '1 day'`,
      waitingTopic: 'orchestr:timer:pause',
    });
    await db.query(
      `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at)
       VALUES (gen_random_uuid(), $1, 'pause', 'pause', 'delay', 'running', now() - interval '3 days')`,
      [sleeping],
    );
    await reaper.reapStale();
    const step = await db.query(`SELECT status FROM runtime_run_steps WHERE run_id = $1`, [sleeping]);
    expect(step.rows[0].status).toBe('running');
  });

  it('does reap a timer wait that is far past its wake — nothing brought it back', async () => {
    const overdue = await insertRun({
      status: 'waiting',
      startedAgo: '5 days',
      waitingTimeoutAt: `now() - interval '2 days'`,
      waitingTopic: 'orchestr:timer:pause',
    });
    await reaper.reapStale();
    const row = await statusOf(overdue);
    expect(row.status).toBe('error');
    expect(row.error).toMatch(/never woke/i);
  });

  it('counts only the time in flight since a run resumed: one approved after a long wait finishes, never reaped', async () => {
    const http = (): ReturnType<typeof request> => request(app.getHttpServer());
    const finished = http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: approvalIr, run_id: 'resumed-1' })
      .then((r) => r);
    const runRow = async (): Promise<{ id: string; status: string; error: string | null }> =>
      (await db.query(`SELECT id, status, error FROM runtime_runs WHERE run_id = 'resumed-1'`)).rows[0] ?? {};
    const stepStatuses = async (): Promise<Record<string, string>> => {
      const rows = await db.query(
        `SELECT s.node_id, s.status FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id
          WHERE r.run_id = 'resumed-1'`,
      );
      return Object.fromEntries(
        rows.rows.map((r: { node_id: string; status: string }) => [r.node_id, r.status]),
      );
    };
    const until = async (done: () => Promise<boolean>): Promise<void> => {
      for (let i = 0; i < 200 && !(await done()); i++) await new Promise((r) => setTimeout(r, 10));
      if (!(await done())) throw new Error('condition never held');
    };

    // Parked for longer than the max: the run and both steps began two hours ago.
    await until(async () => (await runRow()).status === 'waiting');
    const { id } = await runRow();
    await db.query(`UPDATE runtime_runs SET started_at = now() - interval '2 hours' WHERE id = $1`, [id]);
    await db.query(`UPDATE runtime_run_steps SET started_at = now() - interval '2 hours' WHERE run_id = $1`, [
      id,
    ]);

    await http().post('/api/runs/resumed-1/events').send({ topic: 'approve', payload: {} }).expect(200);
    await until(async () => (await stepStatuses()).after === 'running');

    await reaper.reapStale();
    expect(await runRow()).toMatchObject({ status: 'running', error: null });
    expect(await stepStatuses()).toMatchObject({
      approval: 'completed',
      after: 'running',
      spanning: 'running',
    });

    expect((await finished).status).toBe(201);
    expect(await runRow()).toMatchObject({ status: 'completed', error: null });
    expect(await stepStatuses()).toEqual({
      approval: 'completed',
      after: 'completed',
      spanning: 'completed',
    });
  });

  it('still reaps a run in flight past the max since it resumed — the worker died after the wait', async () => {
    const run = await insertRun({ status: 'running', startedAgo: '5 hours', resumedAgo: '2 hours' });
    await db.query(
      `INSERT INTO runtime_run_steps (id, run_id, step_key, node_id, kind, status, started_at)
       VALUES (gen_random_uuid(), $1, 'k1', 'n1', 'action', 'running', now() - interval '2 hours')`,
      [run],
    );
    await reaper.reapStale();
    expect(await statusOf(run)).toMatchObject({ status: 'error', finished: true });
    const step = await db.query(`SELECT status FROM runtime_run_steps WHERE run_id = $1`, [run]);
    expect(step.rows[0].status).toBe('error');
  });

  it('is idempotent — a second sweep reaps nothing new', async () => {
    const result = await reaper.reapStale();
    expect(result.crashedRuns).toBe(0);
    expect(result.timedOutWaits).toBe(0);
    expect(result.orphanSteps).toBe(0);
  });
});
