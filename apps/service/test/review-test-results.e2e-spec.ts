import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ReviewTestService } from '../src/reviews/review-test.service';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/**
 * What a protected merge reads (constitution #15): every pre-merge test is kept by the two versions it tested,
 * and the latest DECISIVE one of the current heads' content decides; an approval covers the version it was given on.
 * Results are written straight to the table so each rule — order, ties, decisiveness, scope, survival, content — is
 * pinned on its own; the review detail answers as the gate.
 */
describe('pre-merge test results (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let db: Client;
  const http = () => request(app.getHttpServer());

  const doc = (marker: string) => ({
    version: '1',
    name: 'results probe',
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
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: [marker], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e1',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'announce',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  });

  /** main protected, lane one commit ahead, an approved review lane → main. */
  const setUp = async (): Promise<{ wf: string; review: string; lane: string; main: string }> => {
    const wf = (
      await http()
        .post('/api/deploy')
        .send({ workflow_json: doc('v1') })
        .expect(201)
    ).body.workflow_id as string;
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: doc('lane'), branch: 'lane' })
      .expect(201);
    await http()
      .patch(`/api/workflows/${wf}/branches/main/protection`)
      .send({ is_protected: true })
      .expect(200);
    const review = await http()
      .post(`/api/workflows/${wf}/reviews`)
      .send({ source_branch: 'lane', target_branch: 'main', title: 'lane → main' })
      .expect(201);
    await http()
      .post(`/api/workflows/${wf}/reviews/${review.body.id}/approve`)
      .send({ decision: 'approved' })
      .expect(201);
    const heads = await db.query<{ name: string; head_version_id: string }>(
      `SELECT name, head_version_id FROM workflow_branches WHERE workflow_id = $1`,
      [wf],
    );
    const head = (name: string) => heads.rows.find((r) => r.name === name)!.head_version_id;
    return { wf, review: review.body.id as string, lane: head('lane'), main: head('main') };
  };

  const record = async (
    wf: string,
    reviewId: string | null,
    versions: { source: string; target: string },
    verdict: 'red' | 'green',
    testedAt: string,
    decisive = true,
  ): Promise<void> => {
    await db.query(
      `INSERT INTO review_test_results
         (id, workflow_id, review_id, source_version_id, target_version_id, verdict, decisive, tested_at, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::json)`,
      [randomUUID(), wf, reviewId, versions.source, versions.target, verdict, decisive, testedAt],
    );
  };

  const detail = async (wf: string, review: string): Promise<Record<string, unknown>> =>
    (await http().get(`/api/workflows/${wf}/reviews/${review}`).expect(200)).body as Record<string, unknown>;

  const blocked = async (wf: string, review: string): Promise<unknown> =>
    (await detail(wf, review)).merge_blocked_by_test;

  const commitLane = async (wf: string, marker: string): Promise<string> =>
    (
      await http()
        .post(`/api/workflows/${wf}/commit`)
        .send({ workflow_ir: doc(marker), branch: 'lane' })
        .expect(201)
    ).body.id as string;

  const approve = (wf: string, review: string, shown?: string) =>
    http()
      .post(`/api/workflows/${wf}/reviews/${review}/approve`)
      .send({ decision: 'approved', source_version_id: shown });

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }),
      })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
  }, 30_000);

  afterAll(async () => {
    await db.end();
    await app.close();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  it('lets the newest decisive test of these versions decide, and a tie fail closed', async () => {
    const { wf, review, lane, main } = await setUp();
    const versions = { source: lane, target: main };
    expect(await blocked(wf, review)).toBeNull();

    await record(wf, review, versions, 'red', '2026-10-08T10:00:00Z');
    expect(await blocked(wf, review)).toMatchObject({
      review_id: review,
      title: 'lane → main',
      source_branch: 'lane',
    });

    await record(wf, review, versions, 'green', '2026-10-08T11:00:00Z');
    expect(await blocked(wf, review)).toBeNull();

    // A later test where main failed too decides nothing; one of other versions says nothing.
    await record(wf, review, versions, 'red', '2026-10-08T12:00:00Z');
    await record(wf, review, versions, 'green', '2026-10-08T13:00:00Z', false);
    await record(wf, review, { source: lane, target: randomUUID() }, 'green', '2026-10-08T14:00:00Z');
    expect(await blocked(wf, review)).toMatchObject({ review_id: review });

    // Two at the same moment, one each way: the failure wins.
    await record(wf, review, versions, 'green', '2026-10-08T15:00:00Z');
    await record(wf, review, versions, 'red', '2026-10-08T15:00:00Z');
    expect(await blocked(wf, review)).toMatchObject({ review_id: review });
    const refused = await http()
      .post(`/api/workflows/${wf}/branches/lane/merge`)
      .send({ target_branch: 'main' })
      .expect(400);
    expect(refused.body).toMatchObject({ code: 'merge_test_failing', review_id: review });
    expect(refused.body.detail).toContain('is on review "lane → main" (lane → main)');
  });

  it('counts a test of these versions from any review, and keeps it after that review and its branch are gone', async () => {
    const { wf, review, lane, main } = await setUp();
    // A branch forked at lane's head, reviewed into main and tested there, then deleted with its review.
    await http()
      .post(`/api/workflows/${wf}/branches`)
      .send({ name: 'fork', from_version_id: lane })
      .expect(201);
    const fork = await http()
      .post(`/api/workflows/${wf}/reviews`)
      .send({ source_branch: 'fork', target_branch: 'main', title: 'fork → main' })
      .expect(201);
    await record(wf, fork.body.id as string, { source: lane, target: main }, 'red', '2026-10-08T10:00:00Z');
    expect(await blocked(wf, review)).toMatchObject({
      review_id: fork.body.id,
      source_branch: 'fork',
      target_branch: 'main',
    });

    await http().delete(`/api/workflows/${wf}/branches/fork`).expect(200);
    expect(await blocked(wf, review)).toMatchObject({
      review_id: null,
      title: null,
      source_branch: null,
      target_branch: null,
    });
    const refused = await http().post(`/api/workflows/${wf}/reviews/${review}/merge`).send({}).expect(400);
    expect(refused.body.detail).toContain('was run from a branch that has since been deleted');

    // Only a newer passing test of the same versions lifts it.
    await record(wf, review, { source: lane, target: main }, 'green', '2026-10-08T11:00:00Z');
    expect(
      (await http().post(`/api/workflows/${wf}/reviews/${review}/merge`).send({}).expect(201)).body.status,
    ).toBe('merged');
  });

  it('follows content, not version ids: a branch put back to content a failing test covered is refused again', async () => {
    const { wf, review, lane, main } = await setUp();
    await record(wf, review, { source: lane, target: main }, 'red', '2026-10-08T10:00:00Z');

    await commitLane(wf, 'lane-2');
    expect(await blocked(wf, review)).toBeNull();
    const restored = await commitLane(wf, 'lane');
    expect(restored).not.toBe(lane);
    expect(await blocked(wf, review)).toMatchObject({ review_id: review });

    await approve(wf, review).expect(201);
    const refused = await http()
      .post(`/api/workflows/${wf}/branches/lane/merge`)
      .send({ target_branch: 'main' })
      .expect(400);
    expect(refused.body.code).toBe('merge_test_failing');

    // A newer passing test of the same content lifts it, whichever versions it ran on.
    await record(wf, review, { source: restored, target: main }, 'green', '2026-10-08T11:00:00Z');
    expect(await blocked(wf, review)).toBeNull();
  });

  it("says whether the review's last test covers what the branches hold now, by content as the gate decides", async () => {
    const { wf, review, lane, main } = await setUp();
    expect((await detail(wf, review)).last_test_current).toBeNull();
    await http()
      .post(`/api/workflows/${wf}/reviews/${review}/test`)
      .send({ trigger_payload: {} })
      .expect(201);
    // A newer failing result for the same pair, so the gate blocks exactly while that test is current.
    await record(wf, review, { source: lane, target: main }, 'red', '2099-01-01T00:00:00Z');
    const agrees = async (current: boolean): Promise<void> => {
      const d = await detail(wf, review);
      expect(d.last_test_current).toBe(current);
      expect(d.merge_blocked_by_test !== null).toBe(current);
    };
    const commitMain = async (marker: string): Promise<void> => {
      await http()
        .patch(`/api/workflows/${wf}/branches/main/protection`)
        .send({ is_protected: false })
        .expect(200);
      await http()
        .post(`/api/workflows/${wf}/commit`)
        .send({ workflow_ir: doc(marker), branch: 'main' })
        .expect(201);
      await http()
        .patch(`/api/workflows/${wf}/branches/main/protection`)
        .send({ is_protected: true })
        .expect(200);
    };
    await agrees(true);

    await commitLane(wf, 'lane-2');
    await agrees(false);
    await commitLane(wf, 'lane');
    await agrees(true);
    await commitMain('hotfix');
    await agrees(false);
    await commitMain('v1');
    await agrees(true);
  });

  it('refuses an approval of a version the reviewer was not shown, and says when one is from before the latest changes', async () => {
    const { wf, review, lane } = await setUp();
    const moved = await commitLane(wf, 'lane-2');
    expect(await detail(wf, review)).toMatchObject({
      approval_current: false,
      approval_stale_reason: 'moved',
    });

    const refused = await approve(wf, review, lane).expect(409);
    expect(refused.body.code).toBe('review_moved');
    expect(refused.body.detail).toContain("'lane' has changed since you loaded this review");

    await approve(wf, review, moved).expect(201);
    expect(await detail(wf, review)).toMatchObject({ approval_current: true, approval_stale_reason: null });
  });

  it('asks again for an approval given before approvals named a version, and says that is why', async () => {
    const { wf, review } = await setUp();
    await db.query(`UPDATE review_approvals SET source_version_id = NULL WHERE review_id = $1`, [review]);
    expect(await detail(wf, review)).toMatchObject({
      approval_current: false,
      approval_stale_reason: 'unversioned',
    });

    const refused = await http().post(`/api/workflows/${wf}/reviews/${review}/merge`).send({}).expect(409);
    expect(refused.body).toMatchObject({ code: 'approval_stale', reason: 'unversioned' });
    expect(refused.body.detail).toContain('approved before an approval covered one exact version');

    await approve(wf, review).expect(201);
    expect(
      (await http().post(`/api/workflows/${wf}/reviews/${review}/merge`).send({}).expect(201)).body.status,
    ).toBe('merged');
  });

  it('records every test run from a review — two at once included — and a closed review keeps its own', async () => {
    const { wf, review, lane, main } = await setUp();
    const runTest = () =>
      http().post(`/api/workflows/${wf}/reviews/${review}/test`).send({ trigger_payload: {} }).expect(201);
    await Promise.all([runTest(), runTest()]);
    const rows = await db.query<{ review_id: string; source_version_id: string; target_version_id: string }>(
      `SELECT review_id, source_version_id, target_version_id FROM review_test_results WHERE workflow_id = $1`,
      [wf],
    );
    expect(rows.rows).toEqual([
      { review_id: review, source_version_id: lane, target_version_id: main },
      { review_id: review, source_version_id: lane, target_version_id: main },
    ]);
    await http().post(`/api/workflows/${wf}/reviews/${review}/close`).send({}).expect(201);
    const after = await db.query(`SELECT 1 FROM review_test_results WHERE review_id = $1`, [review]);
    expect(after.rowCount).toBe(2);
  });

  it('keeps a test that finishes after its review is gone, with no review to name', async () => {
    const { wf, lane, main } = await setUp();
    await http()
      .post(`/api/workflows/${wf}/branches`)
      .send({ name: 'gone', from_version_id: lane })
      .expect(201);
    const doomed = await http()
      .post(`/api/workflows/${wf}/reviews`)
      .send({ source_branch: 'gone', target_branch: 'main', title: 'gone → main' })
      .expect(201);
    await http().delete(`/api/workflows/${wf}/branches/gone`).expect(200);
    // The run outlived its review: what the test service stores at the end of a run.
    await app.get(ReviewTestService).storeTest(wf, doomed.body.id as string, {
      verdict: 'red',
      tested_at: '2026-10-08T10:00:00.000Z',
      environment_id: null,
      source_version_id: lane,
      target_version_id: main,
      base: { run_id: 'b', status: 'completed', error: null },
      head: { run_id: 'h', status: 'error', error: 'boom' },
      regression: { changed: [], added: [], removed: [] },
    });
    const kept = await db.query<{ review_id: string | null; verdict: string }>(
      `SELECT review_id, verdict FROM review_test_results WHERE workflow_id = $1`,
      [wf],
    );
    expect(kept.rows).toEqual([{ review_id: null, verdict: 'red' }]);
  });
});
