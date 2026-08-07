import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** Minimal built-in-engine IR document (a lone action) — versionable + runnable. */
function irDoc(marker: string): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'publish target',
    description: marker,
    nodes: [
      {
        id: 'step',
        name: 'Step',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: [marker], separator: '' },
        position: { x: 0, y: 0 },
        metadata: {},
      },
    ],
    edges: [],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

/** Save ≠ Live: publish/restore decouple the live pointer from commits. */
describe('publish / restore (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let db: Client;

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  /** Deploy a fresh orchestr workflow (create publishes v1) and return its id. */
  async function newWorkflow(): Promise<string> {
    const res = await http()
      .post('/api/deploy')
      .send({ workflow_json: irDoc('v1') })
      .expect(201);
    return res.body.workflow_id as string;
  }

  async function commit(wfId: string, marker: string): Promise<void> {
    await http()
      .post(`/api/workflows/${wfId}/commit`)
      .send({ workflow_ir: irDoc(marker), commit_message: marker })
      .expect(201);
  }

  async function state(wfId: string): Promise<{ live: number | null; latest: number; versions: number }> {
    const res = await http().get(`/api/workflows/${wfId}`).expect(200);
    return {
      live: res.body.live_version,
      latest: res.body.latest_version,
      versions: res.body.version_count,
    };
  }

  it('create publishes v1 — live and latest agree on a newborn workflow', async () => {
    const wfId = await newWorkflow();
    expect(await state(wfId)).toEqual({ live: 1, latest: 1, versions: 1 });
  });

  it('Save ≠ Live: commits advance latest (head) but never the live pointer', async () => {
    const wfId = await newWorkflow();
    await commit(wfId, 'v2');
    await commit(wfId, 'v3');
    // Head moved to v3; live is still the published v1.
    expect(await state(wfId)).toEqual({ live: 1, latest: 3, versions: 3 });
  });

  it('publish defaults to head, returns the now-live version, and is idempotent (no duplicate events)', async () => {
    const wfId = await newWorkflow();
    await commit(wfId, 'v2');
    await commit(wfId, 'v3');

    // Default publish → the head (v3).
    const pub = await http().post(`/api/workflows/${wfId}/publish`).send({}).expect(201);
    expect(pub.body).toEqual({ status: 'published', workflow_id: wfId, live_version: 3 });
    expect(await state(wfId)).toMatchObject({ live: 3, latest: 3 });

    // One published event so far.
    const countPublished = async (): Promise<number> => {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM domain_events WHERE subject_id = $1 AND type = 'workflow.published'`,
        [wfId],
      );
      return r.rows[0].n as number;
    };
    expect(await countPublished()).toBe(1);

    // Idempotent: re-publishing the already-live version emits no new event — the pointer didn't move.
    const again = await http().post(`/api/workflows/${wfId}/publish`).send({}).expect(201);
    expect(again.body.live_version).toBe(3);
    expect(await countPublished()).toBe(1);
  });

  it('publish accepts an explicit version_number (roll live back to an older version)', async () => {
    const wfId = await newWorkflow();
    await commit(wfId, 'v2');
    await http().post(`/api/workflows/${wfId}/publish`).send({}).expect(201); // live = 2

    const pub = await http().post(`/api/workflows/${wfId}/publish`).send({ version_number: 1 }).expect(201);
    expect(pub.body.live_version).toBe(1);
    expect(await state(wfId)).toMatchObject({ live: 1, latest: 2 });
  });

  it('publish 404s on a version that does not exist', async () => {
    const wfId = await newWorkflow();
    await http().post(`/api/workflows/${wfId}/publish`).send({ version_number: 99 }).expect(404);
  });

  it('restore is an INSTANT pointer move — it makes an older version live WITHOUT creating a version', async () => {
    const wfId = await newWorkflow();
    await commit(wfId, 'v2');
    await commit(wfId, 'v3');
    await http().post(`/api/workflows/${wfId}/publish`).send({}).expect(201); // live = 3
    const before = await state(wfId);
    expect(before).toMatchObject({ live: 3, latest: 3, versions: 3 });

    const res = await http().post(`/api/workflows/${wfId}/restore`).send({ version_number: 1 }).expect(201);
    expect(res.body).toEqual({ status: 'restored', workflow_id: wfId, live_version: 1 });

    // Live rolled back to v1; head + version count untouched (no new version).
    expect(await state(wfId)).toEqual({ live: 1, latest: 3, versions: 3 });

    const evt = await db.query(
      `SELECT count(*)::int AS n FROM domain_events WHERE subject_id = $1 AND type = 'workflow.restored'`,
      [wfId],
    );
    expect(evt.rows[0].n).toBe(1);
  });

  it('restore requires a version_number (400)', async () => {
    const wfId = await newWorkflow();
    await http().post(`/api/workflows/${wfId}/restore`).send({}).expect(400);
    await http().post(`/api/workflows/${wfId}/restore`).send({ version_number: 0 }).expect(400);
  });

  it('authz: a nonexistent id and one you cannot reach answer the same 404', async () => {
    await http().post(`/api/workflows/${randomUUID()}/publish`).send({}).expect(404);
    await http().post(`/api/workflows/not-a-uuid/publish`).send({}).expect(404);

    // Foreign workflow (another user, org-less) — the policy denies it.
    const foreignUser = randomUUID();
    const foreignWf = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'foreigner@e2e.local', 'Foreigner', now(), now())`,
      [foreignUser],
    );
    await db.query(
      `INSERT INTO workflows (id, name, source, user_id, created_at, updated_at)
       VALUES ($1, 'theirs', 'generated', $2, now(), now())`,
      [foreignWf, foreignUser],
    );
    await http().post(`/api/workflows/${foreignWf}/publish`).send({}).expect(404);
    await http().post(`/api/workflows/${foreignWf}/restore`).send({ version_number: 1 }).expect(404);
  });
});
