import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** trigger → Code node whose snippet fully determines the run output (or throws). No external effects. */
const codeWf = (code: string): Record<string, unknown> => ({
  version: '1',
  name: 'CI test',
  description: '',
  nodes: [
    {
      id: 'trigger',
      name: 'Trigger',
      node_type: 'orchestr:trigger',
      type_version: 1,
      parameters: {},
      position: { x: 0, y: 0 },
      metadata: {},
    },
    {
      id: 'code',
      name: 'Compute',
      node_type: 'orchestr:code',
      type_version: 1,
      parameters: { language: 'js', code },
      position: { x: 300, y: 0 },
      metadata: {},
    },
  ],
  edges: [
    {
      id: 'e1',
      source_node_id: 'trigger',
      source_port: 0,
      target_node_id: 'code',
      target_port: 0,
      port_type: 'main',
    },
  ],
  settings: { execution_order: 'v1', extra: {} },
  metadata: { engine: 'orchestr' },
});

describe('review pre-merge test — "Test this branch" (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let db: Client;
  let wfId = '';

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';

    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    await request(app.getHttpServer()).get('/api/auth/me').expect(200);

    // main's head: Code returns { msg: 'base' }.
    const res = await request(app.getHttpServer())
      .post('/api/deploy')
      .send({ workflow_json: codeWf("return { msg: 'base' };") })
      .expect(201);
    wfId = res.body.workflow_id;
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  const server = () => app.getHttpServer();

  const branchWithCode = async (name: string, code: string): Promise<void> => {
    await request(server()).post(`/api/workflows/${wfId}/branches`).send({ name }).expect(201);
    await request(server())
      .post(`/api/workflows/${wfId}/commit`)
      .send({ workflow_json: codeWf(code), branch: name })
      .expect(201);
  };

  const createReview = async (source: string, title: string): Promise<string> => {
    const r = await request(server())
      .post(`/api/workflows/${wfId}/reviews`)
      .send({ source_branch: source, title })
      .expect(201);
    return r.body.id as string;
  };

  const test = (reviewId: string) =>
    request(server()).post(`/api/workflows/${wfId}/reviews/${reviewId}/test`).send({});

  it('green: a changed output → verdict green + field-level regression + two review-linked runs', async () => {
    await branchWithCode('change', "return { msg: 'changed' };");
    const reviewId = await createReview('change', 'Change output');

    const res = await test(reviewId).expect(201);
    expect(res.body.verdict).toBe('green');
    expect(res.body.base.status).toBe('completed');
    expect(res.body.head.status).toBe('completed');
    // The "code" node output changed base→changed — the "was X, now Y" regression.
    expect(res.body.regression.changed).toContainEqual(
      expect.objectContaining({ node_id: 'code', path: 'msg', before: 'base', after: 'changed' }),
    );

    // Both sides are recorded as review-linked test runs.
    const runs = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM runtime_runs WHERE review_id = $1 AND source = 'review_test'`,
      [reviewId],
    );
    expect(runs.rows[0]?.n).toBe(2);

    // The detail surfaces the latest test.
    const detail = await request(server()).get(`/api/workflows/${wfId}/reviews/${reviewId}`).expect(200);
    expect(detail.body.last_test.verdict).toBe('green');
  }, 30_000);

  it('red: the branch head errors where the baseline passes → verdict red', async () => {
    await branchWithCode('broken', "throw new Error('boom');");
    const reviewId = await createReview('broken', 'Break it');

    const res = await test(reviewId).expect(201);
    expect(res.body.verdict).toBe('red');
    expect(res.body.base.status).toBe('completed');
    expect(res.body.head.status).toBe('error');
    expect(res.body.head.error).toContain('boom');
  }, 30_000);

  it('links a review-test run even when a side FAILS at run (regression: review_id was lost)', async () => {
    // A side that fails before producing output must STILL persist its review-linked run. A stored
    // branch head always compiles (P1.3 gates that at commit), so the failing side is a run-time throw.
    await request(server()).post(`/api/workflows/${wfId}/branches`).send({ name: 'failhead' }).expect(201);
    await request(server())
      .post(`/api/workflows/${wfId}/commit`)
      .send({ workflow_json: codeWf("throw new Error('head blew up');"), branch: 'failhead' })
      .expect(201);
    const reviewId = await createReview('failhead', 'Failing head');

    const res = await test(reviewId).expect(201);
    // Head throws (a run outcome, recorded as failed); baseline (main Code) is fine → RED.
    expect(res.body.head.status).toBe('error');
    expect(res.body.verdict).toBe('red');

    // BOTH runs — including the failed head — must carry review_id.
    const runs = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM runtime_runs WHERE review_id = $1 AND source = 'review_test'`,
      [reviewId],
    );
    expect(runs.rows[0]?.n).toBe(2);
  }, 30_000);

  it("cross-tenant: a foreign/unknown environment_id is rejected 404 (never runs under another org's connections)", async () => {
    await branchWithCode('envscope', 'return { ok: true };');
    const reviewId = await createReview('envscope', 'Env scope guard');
    // A foreign environment_id must never resolve its slot connections — an indistinguishable 404.
    await request(server())
      .post(`/api/workflows/${wfId}/reviews/${reviewId}/test`)
      .send({ environment_id: '00000000-0000-4000-8000-000000000000' })
      .expect(404);
  }, 30_000);

  it('protected gate: a fresh RED test blocks merge; fixing + re-testing green allows it', async () => {
    await branchWithCode('gated', "throw new Error('kaboom');");
    const reviewId = await createReview('gated', 'Gated change');

    // Protect main + approve, so the merge reaches the TEST gate (not the approval gate).
    await request(server())
      .patch(`/api/workflows/${wfId}/branches/main/protection`)
      .send({ is_protected: true })
      .expect(200);
    await request(server())
      .post(`/api/workflows/${wfId}/reviews/${reviewId}/approve`)
      .send({ decision: 'approved' })
      .expect(201);

    // A fresh red test blocks the protected merge.
    await test(reviewId).expect(201);
    const blocked = await request(server())
      .post(`/api/workflows/${wfId}/reviews/${reviewId}/merge`)
      .expect(400);
    expect(blocked.body.detail).toContain('pre-merge test');

    // Fix the branch head → the old red test is now STALE (different source head); re-test green → merge allowed.
    await request(server())
      .post(`/api/workflows/${wfId}/commit`)
      .send({ workflow_json: codeWf("return { msg: 'fixed' };"), branch: 'gated' })
      .expect(201);
    const retest = await test(reviewId).expect(201);
    expect(retest.body.verdict).toBe('green');

    const merged = await request(server())
      .post(`/api/workflows/${wfId}/reviews/${reviewId}/merge`)
      .expect(201);
    expect(merged.body.status).toBe('merged');
  }, 40_000);
});
