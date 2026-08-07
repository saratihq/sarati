import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Client } from 'pg';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** POST /api/runs/:runId/cancel with DBOS off — the direct mark-cancelled branch plus the authz resolver. */
describe('run cancel (B7, e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let db: Client;
  let callerId: string;
  const otherUserId = randomUUID();

  const insertRun = async (userId: string, status: string): Promise<string> => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO runtime_runs (id, run_id, user_id, plan_id, status, started_at, waiting_node_id)
       VALUES ($1, $2, $3, 'plan-x', $4, now(), ${status === 'waiting' ? `'n1'` : 'NULL'})`,
      [id, `rid-${id.slice(0, 8)}`, userId, status],
    );
    return id;
  };
  const statusOf = async (id: string): Promise<{ status: string; finished: boolean }> => {
    const r = await db.query(`SELECT status, finished_at FROM runtime_runs WHERE id = $1`, [id]);
    return { status: r.rows[0].status, finished: r.rows[0].finished_at !== null };
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
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'other@e2e.local', 'Other', now(), now())`,
      [otherUserId],
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    // The mock caller provisions on first request — read its real id.
    const me = await request(app.getHttpServer()).get('/api/auth/me').expect(200);
    callerId = me.body.user.id as string;
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  it('cancels the caller’s running run → cancelled + finished', async () => {
    const id = await insertRun(callerId, 'running');
    const res = await request(app.getHttpServer()).post(`/api/runs/${id}/cancel`).expect(200);
    expect(res.body.status).toBe('cancelled');
    const s = await statusOf(id);
    expect(s.status).toBe('cancelled');
    expect(s.finished).toBe(true);
  });

  it('cancels a waiting (HITL) run', async () => {
    const id = await insertRun(callerId, 'waiting');
    await request(app.getHttpServer()).post(`/api/runs/${id}/cancel`).expect(200);
    expect((await statusOf(id)).status).toBe('cancelled');
  });

  it('is idempotent on an already-terminal run — returns its status, no rewrite', async () => {
    const id = await insertRun(callerId, 'completed');
    const res = await request(app.getHttpServer()).post(`/api/runs/${id}/cancel`).expect(200);
    expect(res.body.status).toBe('completed');
    expect((await statusOf(id)).status).toBe('completed');
  });

  it('404s another user’s run (never cancellable, indistinguishable from nonexistent)', async () => {
    const id = await insertRun(otherUserId, 'running');
    await request(app.getHttpServer()).post(`/api/runs/${id}/cancel`).expect(404);
    expect((await statusOf(id)).status).toBe('running'); // untouched
  });

  it('404s a nonexistent run id', async () => {
    await request(app.getHttpServer()).post(`/api/runs/${randomUUID()}/cancel`).expect(404);
  });
});
