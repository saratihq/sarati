import { createHash, createHmac } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';
const SECRET = 'hunter2-signing-secret';

/** A webhook workflow whose trigger declares GitHub-preset HMAC verification. */
const webhookDoc = (): Record<string, unknown> => ({
  version: '1.0',
  name: 'hmac target',
  description: '',
  nodes: [
    {
      id: 'trigger',
      name: 'When a request arrives',
      node_type: 'orchestr:webhook',
      type_version: 1,
      parameters: { verification: { preset: 'github' } },
      position: { x: 0, y: 0 },
      metadata: {},
    },
    {
      id: 'announce',
      name: 'Announce',
      node_type: 'text.concat',
      type_version: 1,
      parameters: { texts: ['hooked: ', '{{trigger.title}}'], separator: '' },
      position: { x: 300, y: 0 },
      metadata: {},
    },
  ],
  edges: [
    {
      id: 'e-trigger-announce',
      source_node_id: 'trigger',
      source_port: 0,
      target_node_id: 'announce',
      target_port: 0,
      port_type: 'main',
    },
  ],
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
});

describe('webhook HMAC verification (ADR 0030, e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;
  const userA = randomUUID();
  const personalA = randomUUID();
  const keyA = 'ork_e2e_hmac_aaaaaaaaaaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');
  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  let orgId = '';
  let wfId = '';

  const githubSig = (raw: string, secret: string): string =>
    'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  const fire = (headers: Record<string, string>, raw: string): request.Test =>
    http()
      .post(`/api/hooks/${wfId}/production`)
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(raw);

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'hmac@e2e.local', 'HMAC', now(), now())`,
      [userA],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'HMAC', true, now(), now())`,
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

  it('with NO secret set, an unsigned delivery still fires (backward compatible — verification is opt-in)', async () => {
    const raw = JSON.stringify({ title: 'no-secret' });
    await fire({}, raw).expect(202);
  });

  it('status reports secret_present=false before any secret is stored (drives the editor fail-open warning)', async () => {
    const res = await asA(
      http()
        .get(`/api/workflows/${wfId}/webhook-secret?node_id=trigger&environment=production`)
        .set('X-Org-Id', orgId),
    ).expect(200);
    expect(res.body.secret_present).toBe(false);
  });

  it('once a secret is set, a VALID signature fires and a FORGED/absent one is rejected 401', async () => {
    await asA(http().put(`/api/workflows/${wfId}/webhook-secret`).set('X-Org-Id', orgId))
      .send({ node_id: 'trigger', secret: SECRET, environment: 'production' })
      .expect(200);

    // The status read-back now reports a secret is present (never the value).
    const status = await asA(
      http()
        .get(`/api/workflows/${wfId}/webhook-secret?node_id=trigger&environment=production`)
        .set('X-Org-Id', orgId),
    ).expect(200);
    expect(status.body).toEqual({ secret_present: true });

    const raw = JSON.stringify({ title: 'signed' });
    // valid GitHub signature over the exact raw body → fires
    await fire({ 'x-hub-signature-256': githubSig(raw, SECRET) }, raw).expect(202);
    // forged signature (wrong secret) → 401
    await fire({ 'x-hub-signature-256': githubSig(raw, 'wrong-secret') }, raw).expect(401);
    // no signature header at all, with verification configured + a secret → 401
    await fire({}, raw).expect(401);
    // tampered body against a good signature → 401
    await fire(
      { 'x-hub-signature-256': githubSig(raw, SECRET) },
      JSON.stringify({ title: 'tampered' }),
    ).expect(401);
  });

  it('clearing the secret reverts to unguarded firing', async () => {
    const cleared = await asA(
      http()
        .delete(`/api/workflows/${wfId}/webhook-secret?node_id=trigger&environment=production`)
        .set('X-Org-Id', orgId),
    ).expect(200);
    expect(cleared.body.status).toBe('cleared');
    const status = await asA(
      http()
        .get(`/api/workflows/${wfId}/webhook-secret?node_id=trigger&environment=production`)
        .set('X-Org-Id', orgId),
    ).expect(200);
    expect(status.body.secret_present).toBe(false);
    await fire({}, JSON.stringify({ title: 'after-clear' })).expect(202);
  });

  it('a foreign workflow id on the secret endpoint is an indistinguishable 404', async () => {
    await asA(http().put(`/api/workflows/${randomUUID()}/webhook-secret`).set('X-Org-Id', orgId))
      .send({ node_id: 'trigger', secret: SECRET })
      .expect(404);
  });
});
