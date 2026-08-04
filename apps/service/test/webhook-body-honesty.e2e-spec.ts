import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';

/** `good` reads both trigger-scope paths (stable `.body` + spread); `bad` reads a path that resolves to nothing. */
const webhookDoc = (): Record<string, unknown> => ({
  version: '1.0',
  name: 'webhook body honesty',
  description: '',
  nodes: [
    {
      id: 'trigger',
      name: 'When a request arrives',
      node_type: 'orchestr:webhook',
      type_version: 1,
      parameters: {},
      position: { x: 0, y: 0 },
      metadata: {},
    },
    {
      id: 'good',
      name: 'Echo the marker',
      node_type: 'text.concat',
      type_version: 1,
      // '{{trigger.body.marker}}' = STABLE raw-payload path; '{{trigger.marker}}' = spread path.
      parameters: { texts: ['{{trigger.body.marker}}', '/', '{{trigger.marker}}'], separator: '' },
      position: { x: 300, y: 0 },
      metadata: {},
    },
    {
      id: 'bad',
      name: 'Reference a wrong path',
      node_type: 'text.concat',
      type_version: 1,
      // A whole-field ref to a path that does not exist → resolves to nothing → warning.
      parameters: { texts: ['{{trigger.body.nope}}'], separator: '' },
      position: { x: 600, y: 0 },
      metadata: {},
    },
  ],
  edges: [
    {
      id: 'e-trigger-good',
      source_node_id: 'trigger',
      source_port: 0,
      target_node_id: 'good',
      target_port: 0,
      port_type: 'main',
    },
    {
      id: 'e-good-bad',
      source_node_id: 'good',
      source_port: 0,
      target_node_id: 'bad',
      target_port: 0,
      port_type: 'main',
    },
  ],
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
});

interface RunStep {
  node_id: string;
  status: string;
  warnings: string[] | null;
}

describe('webhook body honesty (ROOT-A stable {{trigger.body}} + ROOT-B unresolved-ref warning, e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const userA = randomUUID();
  const personalA = randomUUID();
  const keyA = 'ork_e2e_bodyhonesty_aaaaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');
  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  let orgId = '';
  let wfId = '';

  const fire = (body: unknown): request.Test =>
    http()
      .post(`/api/hooks/${wfId}/production`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));

  async function awaitRun(runId: string): Promise<Record<string, unknown>> {
    let run: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      const r = await asA(http().get(`/api/runs/${runId}`)).expect(200);
      run = r.body as Record<string, unknown>;
      if (run.status === 'completed' || run.status === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return run;
  }

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'body@e2e.local', 'Body', now(), now())`,
      [userA],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Body', true, now(), now())`,
      [personalA],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [personalA, userA],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (gen_random_uuid(), $1, 'a', $2, $3, now())`,
      [userA, hash(keyA), keyA.slice(0, 12)],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    const org = await asA(http().post('/api/orgs').send({ name: 'Acme' })).expect(201);
    orgId = org.body.id as string;
    const deployed = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: webhookDoc() }),
    ).expect(201);
    wfId = deployed.body.workflow_id as string;
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('an OBJECT body resolves BOTH {{trigger.body.<field>}} and {{trigger.<field>}} downstream', async () => {
    const fired = await fire({ marker: 'HELLO' }).expect(202);
    const run = await awaitRun(fired.body.run_id as string);
    expect(run.status).toBe('completed');
    // ROOT-A: the stable `.body` path AND the spread path both resolve to the posted value.
    expect((run.outputs as Record<string, unknown>).good).toBe('HELLO/HELLO');
  });

  it('a wrong full-string {{trigger.body.nope}} surfaces a non-fatal warning on the run — good step stays clean', async () => {
    const fired = await fire({ marker: 'HELLO' }).expect(202);
    const run = await awaitRun(fired.body.run_id as string);
    expect(run.status).toBe('completed'); // non-fatal — the run still completed

    const steps = run.steps as RunStep[];
    const bad = steps.find((s) => s.node_id === 'bad');
    const good = steps.find((s) => s.node_id === 'good');
    expect(bad).toBeDefined();
    // ROOT-B: the silently-empty field is surfaced as a warning naming the ref.
    expect(bad?.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining('{{trigger.body.nope}}')]),
    );
    // A step whose refs all resolve carries NO warning (never cry wolf).
    expect(good?.warnings ?? null).toBeNull();
  });
});
