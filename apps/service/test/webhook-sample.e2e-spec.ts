import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import type { EnvConfig } from '../src/config/env.config';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const SAMPLE = '/api/triggers/webhook-sample';

const node = (id: string, nodeType: string, parameters: Record<string, unknown>, x: number) => ({
  id,
  name: id,
  node_type: nodeType,
  type_version: 1,
  parameters,
  position: { x, y: 0 },
  metadata: {},
});

// `shape` serializes the whole trigger scope the run started with, its types kept.
const webhookDoc = {
  version: '1.0',
  name: 'pasted sample parity',
  description: '',
  nodes: [
    node('trigger', 'orchestr:webhook', {}, 0),
    node('shape', 'text.concat', { texts: [{ trigger: '{{trigger}}' }] }, 300),
  ],
  edges: [
    {
      id: 'e-trigger-shape',
      source_node_id: 'trigger',
      source_port: 0,
      target_node_id: 'shape',
      target_port: 0,
      port_type: 'main',
    },
  ],
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
};

interface Run {
  status: string;
  outputs: Record<string, unknown>;
}

describe('a pasted webhook sample is the trigger a webhook run of the same body sees (e2e)', () => {
  let app: INestApplication;
  let db: Client;
  let env: EnvConfig;
  let orgId = '';
  let hook = '';
  const userId = randomUUID();
  const fullKey = 'ork_e2e_webhooksample_full_aaaaaaaa';
  const readKey = 'ork_e2e_webhooksample_read_aaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const paste = (text: string, key = fullKey): request.Test =>
    http()
      .post(SAMPLE)
      .set('Authorization', `Bearer ${key}`)
      .set('X-Org-Id', orgId)
      .set('Content-Type', 'application/json')
      .send(text);

  async function triggerOfRun(text: string): Promise<unknown> {
    const fired = await http().post(hook).set('Content-Type', 'application/json').send(text).expect(202);
    for (;;) {
      const run = (
        await http()
          .get(`/api/runs/${fired.body.run_id as string}`)
          .set('Authorization', `Bearer ${fullKey}`)
          .set('X-Org-Id', orgId)
          .expect(200)
      ).body as Run;
      if (run.status === 'completed')
        return (JSON.parse(run.outputs.shape as string) as { trigger: unknown }).trigger;
      if (run.status === 'error') throw new Error(`the webhook run failed: ${JSON.stringify(run)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'paste@e2e.local', 'Paste', now(), now())`,
      [userId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, scopes, created_at)
       VALUES (gen_random_uuid(), $1, 'full', $2, $3, NULL, now()),
              (gen_random_uuid(), $1, 'read', $4, $5, $6::json, now())`,
      [
        userId,
        hash(fullKey),
        fullKey.slice(0, 12),
        hash(readKey),
        readKey.slice(0, 12),
        JSON.stringify(['workflow:read']),
      ],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.DBOS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    env = configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    orgId = (
      await http()
        .post('/api/orgs')
        .set('Authorization', `Bearer ${fullKey}`)
        .send({ name: 'Acme' })
        .expect(201)
    ).body.id as string;
    const deployed = await http()
      .post('/api/deploy')
      .set('Authorization', `Bearer ${fullKey}`)
      .set('X-Org-Id', orgId)
      .send({ workflow_json: webhookDoc })
      .expect(201);
    hook = `/api/hooks/${deployed.body.workflow_id as string}/production`;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it.each([
    [
      'an object',
      '{"email": "sara@acme.com", "plan": "pro"}',
      { email: 'sara@acme.com', plan: 'pro', body: { email: 'sara@acme.com', plan: 'pro' } },
    ],
    ['a string', '"ping"', { body: 'ping' }],
    ['a number', '42', { body: 42 }],
    ['null', 'null', { body: null }],
    ['an array', '[1, 2]', { body: [1, 2] }],
  ])('%s is shaped as the run of it sees it', async (_kind, text, shaped) => {
    const pasted = await paste(text).expect(200);

    expect(pasted.body).toEqual({ payload: shaped });
    expect(await triggerOfRun(text)).toEqual(shaped);
  });

  it('refuses invalid JSON as a delivery is refused, readably from the client origin', async () => {
    const [origin] = env.corsOriginList;

    const refused = await paste('{"email":').set('Origin', origin!).expect(400);

    expect(refused.body.detail).toBe('The request body is not valid JSON');
    expect(refused.headers['access-control-allow-origin']).toBe(origin);
  });

  it('refuses a content type a delivery is refused for', async () => {
    const refused = await paste('ping').set('Content-Type', 'application/octet-stream').expect(415);

    expect(refused.body.detail).toMatch(/Unsupported Content-Type "application\/octet-stream"/);
  });

  it('takes a body as large as a delivery may be, past a catch’s cap', async () => {
    const blob = 'x'.repeat(512 * 1024);

    const pasted = await paste(JSON.stringify({ blob })).expect(200);

    expect((pasted.body as { payload: { body: { blob: string } } }).payload.body.blob).toHaveLength(
      blob.length,
    );
  });

  it('refuses a body over the delivery limit', async () => {
    const text = JSON.stringify('x'.repeat(env.maxRequestBodyBytes));

    const refused = await paste(text).expect(413);

    expect(refused.body).toEqual({ detail: 'Request body too large' });
  });

  it('answers only a signed-in caller who may edit workflows', async () => {
    const anonymous = await http()
      .post(SAMPLE)
      .set('Content-Type', 'application/json')
      .send('{"email": "sara@acme.com"}')
      .expect(401);
    expect(anonymous.body.code).toBe('no_credentials');

    const readOnly = await paste('{"email": "sara@acme.com"}', readKey).expect(403);
    expect(String(readOnly.body.detail)).toMatch(/missing the "workflow:write" scope/i);
  });
});
