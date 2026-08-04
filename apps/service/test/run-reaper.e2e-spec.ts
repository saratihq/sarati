import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { RunReaperService } from '../src/runs/run-reaper.service';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';

/** The reaper errors out crashed non-terminal runs; RUN_MAX_DURATION_SECONDS defaults to 3600. */
describe('run durability reaper (B8, e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;
  let reaper: RunReaperService;
  const userId = randomUUID();

  const insertRun = async (over: {
    status: string;
    startedAgo: string; // interval, e.g. '2 hours'
    waitingTimeoutAt?: string | null; // SQL expr or null
  }): Promise<string> => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at, waiting_timeout_at, waiting_node_id)
       VALUES ($1, $2, $3, 'plan-x', $4, now() - ($5)::interval, ${over.waitingTimeoutAt ?? 'NULL'},
               ${over.status === 'waiting' ? `'n1'` : 'NULL'})`,
      [id, `rid-${id.slice(0, 8)}`, userId, over.status, over.startedAgo],
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

  it('is idempotent — a second sweep reaps nothing new', async () => {
    const result = await reaper.reapStale();
    expect(result.crashedRuns).toBe(0);
    expect(result.timedOutWaits).toBe(0);
    expect(result.orphanSteps).toBe(0);
  });
});
