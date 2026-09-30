import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { NOTHING_TO_REVIEW } from '../src/reviews/reviews.service';
import { NOTHING_TO_MERGE } from '../src/workflows/merge-orchestration.service';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const doc = (label: string): Record<string, unknown> => ({
  version: '1',
  name: 'nothing to merge',
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
      parameters: { language: 'js', code: `return { label: '${label}' };` },
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

/** A branch whose every change main already has offers nothing to review or merge — and says so. */
describe('a branch with nothing the target lacks (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    await request(app.getHttpServer()).get('/api/auth/me').expect(200);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  const http = () => request(app.getHttpServer());

  const workflow = async (): Promise<string> => {
    const res = await http()
      .post('/api/deploy')
      .send({ workflow_json: doc('main v1') })
      .expect(201);
    return res.body.workflow_id as string;
  };
  const branch = (wf: string, name: string, fromVersionId?: string) =>
    http()
      .post(`/api/workflows/${wf}/branches`)
      .send({ name, ...(fromVersionId ? { from_version_id: fromVersionId } : {}) })
      .expect(201);
  const commit = (wf: string, on: string, label: string) =>
    http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_json: doc(label), branch: on })
      .expect(201);
  const openReview = (wf: string, source: string) =>
    http()
      .post(`/api/workflows/${wf}/reviews`)
      .send({ source_branch: source, title: `review ${source}` });
  const mainVersions = async (wf: string): Promise<number> =>
    (await http().get(`/api/workflows/${wf}/versions?branch=main`).expect(200)).body.versions
      .length as number;

  it('a branch with no commits of its own has nothing to review', async () => {
    const wf = await workflow();
    await branch(wf, 'fresh');

    const res = await openReview(wf, 'fresh').expect(409);

    expect(res.body.code).toBe(NOTHING_TO_REVIEW);
    expect(res.body.detail).toContain("'fresh'");
  });

  it('nor does a branch main has moved past, though its content now differs from main', async () => {
    const wf = await workflow();
    await branch(wf, 'behind');
    await commit(wf, 'main', 'main v2');

    const res = await openReview(wf, 'behind').expect(409);

    expect(res.body.code).toBe(NOTHING_TO_REVIEW);
  });

  it('one commit on the branch makes it reviewable, and the review names both heads', async () => {
    const wf = await workflow();
    await branch(wf, 'change');
    const head = await commit(wf, 'change', 'branch v1');

    const created = await openReview(wf, 'change').expect(201);
    const detail = await http().get(`/api/workflows/${wf}/reviews/${created.body.id}`).expect(200);

    expect(detail.body.source_head_version_id).toBe(head.body.id);
    expect(detail.body.target_head_version_id).toEqual(expect.any(String));
    expect(detail.body.up_to_date).toBe(false);
  });

  it("a branch cut from another branch's commit has that commit to review, with none of its own", async () => {
    const wf = await workflow();
    await branch(wf, 'feature');
    const featureHead = await commit(wf, 'feature', 'feature v1');
    await branch(wf, 'child', featureHead.body.id as string);

    const created = await openReview(wf, 'child').expect(201);
    const detail = await http().get(`/api/workflows/${wf}/reviews/${created.body.id}`).expect(200);

    expect(detail.body.source_head_version_id).toBe(featureHead.body.id);
    expect(detail.body.up_to_date).toBe(false);
  });

  it('merging a branch main already has is refused, mints nothing and keeps the branch', async () => {
    const wf = await workflow();
    await branch(wf, 'idle');
    await commit(wf, 'main', 'main v2');
    const before = await mainVersions(wf);

    const res = await http()
      .post(`/api/workflows/${wf}/branches/idle/merge`)
      .send({ target_branch: 'main' })
      .expect(409);

    expect(res.body.code).toBe(NOTHING_TO_MERGE);
    expect(await mainVersions(wf)).toBe(before);
    const branches = await http().get(`/api/workflows/${wf}/branches`).expect(200);
    expect(branches.body.branches.map((b: { name: string }) => b.name)).toContain('idle');
  });

  it('a review whose changes reached main another way says it is up to date, and merging it mints nothing', async () => {
    const wf = await workflow();
    await branch(wf, 'twice');
    const twiceHead = await commit(wf, 'twice', 'twice v1');
    const review = await openReview(wf, 'twice').expect(201);
    await branch(wf, 'carrier', twiceHead.body.id as string);
    await http()
      .post(`/api/workflows/${wf}/branches/carrier/merge`)
      .send({ target_branch: 'main' })
      .expect(201);
    const before = await mainVersions(wf);

    const detail = await http().get(`/api/workflows/${wf}/reviews/${review.body.id}`).expect(200);
    expect(detail.body.up_to_date).toBe(true);

    await http()
      .post(`/api/workflows/${wf}/reviews/${review.body.id}/approve`)
      .send({ decision: 'approved' })
      .expect(201);
    const merged = await http()
      .post(`/api/workflows/${wf}/reviews/${review.body.id}/merge`)
      .send({})
      .expect(201);
    expect(merged.body.merged_version_id).toBeNull();
    expect(await mainVersions(wf)).toBe(before);
  });
});
