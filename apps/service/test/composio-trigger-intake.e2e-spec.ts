import { createHash, createHmac, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConnectionsService } from '../src/connections/connections.service';
import { listenOnLoopback } from './support/listen';
import { seedPlatformKeyEverywhere } from './support/platform-keys';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const WEBHOOK_SECRET = 'whsec_e2e_composio_secret';

/** The fire TARGET; the activation is seeded directly, so the workflow needs no trigger node. */
const workflowDoc = (): Record<string, unknown> => ({
  version: '1.0',
  name: 'composio intake target',
  description: '',
  nodes: [
    {
      id: 'trigger',
      name: 'Manual',
      node_type: 'orchestr:trigger',
      type_version: 1,
      parameters: {},
      position: { x: 0, y: 0 },
      metadata: {},
    },
    {
      id: 'say',
      name: 'Say',
      node_type: 'text.concat',
      type_version: 1,
      parameters: { texts: ['fired: ', '{{trigger.action}}'], separator: '' },
      position: { x: 300, y: 0 },
      metadata: {},
    },
  ],
  edges: [
    {
      id: 'e-trigger-say',
      source_node_id: 'trigger',
      source_port: 0,
      target_node_id: 'say',
      target_port: 0,
      port_type: 'main',
    },
  ],
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
});

/** The generic Composio trigger intake; the activation row is seeded, so no live Composio call. */
describe('Composio trigger intake (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;
  const userId = randomUUID();
  const orgId = randomUUID();
  const keyA = 'ork_e2e_composio_aaaaaaaaaaaaaaaaaaaa';
  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  let wfId = '';
  const INSTANCE = 'ti_e2e_instance_123';

  const sign = (webhookId: string, ts: string, raw: string): string =>
    'v1,' + createHmac('sha256', WEBHOOK_SECRET).update(`${webhookId}.${ts}.${raw}`).digest('base64');

  // Each delivery needs its OWN `webhook-id` — the intake dedupes on it (migration 022).
  let deliveryCounter = 0;
  const nextId = (): string => `msg_auto_${++deliveryCounter}`;

  const deliver = (raw: string, sig: string, id = nextId()): request.Test => {
    const ts = String(Math.floor(Date.now() / 1000));
    return http()
      .post('/api/hooks/composio')
      .set('Content-Type', 'application/json')
      .set('webhook-id', id)
      .set('webhook-timestamp', ts)
      .set('webhook-signature', sig.startsWith('v1,') ? sig : sign(id, ts, raw))
      .send(raw);
  };

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    // A real hashed api key (sha256, matching the auth verifier).
    const keyHash = createHash('sha256').update(keyA, 'utf8').digest('hex');

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'composio@e2e.local', 'C', now(), now())`,
      [userId],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'C', true, now(), now())`,
      [orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(), $1, $2, 'owner', now())`,
      [orgId, userId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (gen_random_uuid(), $1, 'a', $2, $3, now())`,
      [userId, keyHash, keyA.slice(0, 12)],
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
    // The managed rail's key lives in the store, not the environment.
    await seedPlatformKeyEverywhere(app, 'composio_api_key', 'ck_e2e_fake_key');
    // The signing secret is the same Composio project's credential, so it is scoped too.
    await seedPlatformKeyEverywhere(app, 'composio_webhook_secret', WEBHOOK_SECRET);

    const deployed = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: workflowDoc() }),
    ).expect(201);
    wfId = deployed.body.workflow_id as string;

    // The production env pointer materialized by deploy — the activation's target.
    const pointer = await db.query<{ environment_id: string; version_id: string }>(
      `SELECT environment_id, version_id FROM workflow_env_pointers
        WHERE workflow_id = $1 AND environment_id IS NOT NULL LIMIT 1`,
      [wfId],
    );
    const target = pointer.rows[0];
    if (!target) throw new Error('deploy did not materialize a production env pointer');
    const { environment_id, version_id } = target;

    // Seed a live composio_subscription activation bound to a Composio instance id.
    await db.query(
      `INSERT INTO runtime_trigger_activations
         (id, workflow_id, environment_id, trigger_node_id, kind, trigger_type, version_id,
          props, composio_trigger_instance_id, connection_owner_user_id, paused, created_at, updated_at)
       VALUES ($1, $2, $3, 'ext-node', 'composio_subscription', 'github.github_commit_event', $4,
               '{}'::json, $5, $6, false, now(), now())`,
      [randomUUID(), wfId, environment_id, version_id, INSTANCE, userId],
    );
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  const runCount = async (): Promise<number> => {
    const res = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM runtime_runs WHERE workflow_id = $1`,
      [wfId],
    );
    return Number(res.rows[0]?.n ?? '0');
  };

  it('a VALID signed delivery fans out to the activation and fires a run', async () => {
    const raw = JSON.stringify({
      type: 'composio.trigger.message',
      metadata: { trigger_id: INSTANCE, trigger_slug: 'GITHUB_COMMIT_EVENT' },
      data: { action: 'push' },
    });
    const res = await deliver(raw, 'auto').expect(202);
    expect(res.body).toMatchObject({ status: 'accepted', fired: 1 });

    // The run is fire-and-forget (fast ack) — poll briefly for its record.
    let created = 0;
    for (let i = 0; i < 40 && created === 0; i++) {
      created = await runCount();
      if (created === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(created).toBe(1);
  });

  /** Delivery is at-least-once by contract, so the intake claims the stable Svix id before firing. */
  it('a REDELIVERED webhook-id is acked as a duplicate and fires exactly once', async () => {
    const before = await runCount();
    const raw = JSON.stringify({
      type: 'composio.trigger.message',
      metadata: { trigger_id: INSTANCE, trigger_slug: 'GITHUB_COMMIT_EVENT' },
      data: { action: 'push' },
    });
    const id = 'msg_redelivered_once';

    const first = await deliver(raw, 'auto', id).expect(202);
    expect(first.body).toMatchObject({ status: 'accepted', fired: 1 });
    expect(first.body.duplicate).toBeUndefined();

    // A retry must still ack successfully (an error only begets more retries) but fire nothing.
    const second = await deliver(raw, 'auto', id).expect(202);
    expect(second.body).toMatchObject({ status: 'accepted', fired: 0, duplicate: true });

    // Exactly ONE new run, not two. Poll: the fire is fire-and-forget.
    let created = 0;
    for (let i = 0; i < 40 && created === 0; i++) {
      created = (await runCount()) - before;
      if (created === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(created).toBe(1);
    await new Promise((r) => setTimeout(r, 300)); // let a wrongly-fired second run surface
    expect((await runCount()) - before).toBe(1);
  });

  it('a FORGED signature is rejected 401 and fires nothing', async () => {
    const before = await runCount();
    const raw = JSON.stringify({ metadata: { trigger_id: INSTANCE }, data: {} });
    const ts = String(Math.floor(Date.now() / 1000));
    const forged = 'v1,' + createHmac('sha256', 'wrong-secret').update(`msg_2.${ts}.${raw}`).digest('base64');
    await http()
      .post('/api/hooks/composio')
      .set('Content-Type', 'application/json')
      .set('webhook-id', 'msg_2')
      .set('webhook-timestamp', ts)
      .set('webhook-signature', forged)
      .send(raw)
      .expect(401);
    expect(await runCount()).toBe(before);
  });

  it('a valid delivery for an UNKNOWN instance id acks without firing (fired: 0)', async () => {
    const before = await runCount();
    const raw = JSON.stringify({ metadata: { trigger_id: 'ti_does_not_exist' }, data: {} });
    const res = await deliver(raw, 'auto').expect(202);
    expect(res.body).toMatchObject({ status: 'accepted', fired: 0 });
    expect(await runCount()).toBe(before);
  });

  // F5: an unverifiable delivery never fires, whatever rows exist for the instance.
  describe('per-scope signature verification (fails closed)', () => {
    const sign = (secret: string, raw: string, webhookId: string, ts: string): string =>
      'v1,' + createHmac('sha256', secret).update(`${webhookId}.${ts}.${raw}`).digest('base64');

    const deliverSignedWith = (secret: string): request.Test => {
      const raw = JSON.stringify({ metadata: { trigger_id: INSTANCE }, data: { action: 'push' } });
      const id = nextId();
      const ts = String(Math.floor(Date.now() / 1000));
      return http()
        .post('/api/hooks/composio')
        .set('Content-Type', 'application/json')
        .set('webhook-id', id)
        .set('webhook-timestamp', ts)
        .set('webhook-signature', sign(secret, raw, id, ts))
        .send(raw);
    };

    it("accepts a delivery signed with the OWNING scope's secret", async () => {
      const before = await runCount();
      const res = await deliverSignedWith(WEBHOOK_SECRET).expect(202);
      expect(res.body).toMatchObject({ status: 'accepted', fired: 1 });
      expect(await runCount()).toBe(before + 1);
    });

    it("rejects a delivery signed with a DIFFERENT scope's secret", async () => {
      const before = await runCount();
      await deliverSignedWith('whsec_some_other_tenants_secret').expect(401);
      expect(await runCount()).toBe(before);
    });

    it('rejects an unsigned delivery', async () => {
      const before = await runCount();
      const raw = JSON.stringify({ metadata: { trigger_id: INSTANCE }, data: { action: 'push' } });
      await http()
        .post('/api/hooks/composio')
        .set('Content-Type', 'application/json')
        .set('webhook-id', nextId())
        .send(raw)
        .expect(401);
      expect(await runCount()).toBe(before);
    });

    it('a rejected delivery does not burn its id — the genuine retry still fires', async () => {
      const raw = JSON.stringify({ metadata: { trigger_id: INSTANCE }, data: { action: 'push' } });
      const id = nextId();
      const ts = String(Math.floor(Date.now() / 1000));
      const post = (secret: string): request.Test =>
        http()
          .post('/api/hooks/composio')
          .set('Content-Type', 'application/json')
          .set('webhook-id', id)
          .set('webhook-timestamp', ts)
          .set('webhook-signature', sign(secret, raw, id, ts))
          .send(raw);

      await post('whsec_wrong').expect(401);
      const before = await runCount();
      const ok = await post(WEBHOOK_SECRET).expect(202);
      expect(ok.body).toMatchObject({ fired: 1 });
      expect(await runCount()).toBe(before + 1);

      // ...and the SAME id a second time is still deduped (migration 022 behaviour intact).
      const dup = await post(WEBHOOK_SECRET).expect(202);
      expect(dup.body).toMatchObject({ fired: 0, duplicate: true });
    });
  });

  // F7: an activation resolving a different account than the delivery names must be skipped, not fired.
  describe('connected-account cross-check (F7)', () => {
    const F7_INSTANCE = 'ti_f7_instance';
    const connId = randomUUID();
    let refSpy: jest.SpyInstance;

    beforeAll(async () => {
      // A second live activation on the same workflow/env, bound to a connection spied to `ca_expected`.
      await db.query(
        `INSERT INTO runtime_trigger_activations
           (id, workflow_id, environment_id, trigger_node_id, kind, trigger_type, version_id,
            props, composio_trigger_instance_id, connection_id, connection_owner_user_id,
            paused, created_at, updated_at)
         SELECT $1, $2, environment_id, 'f7-node', 'composio_subscription', 'github.github_commit_event',
                version_id, '{}'::json, $3, $4, $5, false, now(), now()
           FROM workflow_env_pointers
          WHERE workflow_id = $2 AND environment_id IS NOT NULL
          LIMIT 1`,
        [randomUUID(), wfId, F7_INSTANCE, connId, userId],
      );
      refSpy = jest.spyOn(app.get(ConnectionsService), 'managedRef').mockResolvedValue({
        id: connId,
        authType: 'managed',
        status: 'active',
        connectedAccountId: 'ca_expected',
      });
    });

    afterAll(() => refSpy.mockRestore());

    it('SKIPS an activation whose account ≠ the delivery account (fired: 0)', async () => {
      const before = await runCount();
      const raw = JSON.stringify({
        metadata: { trigger_id: F7_INSTANCE, connected_account_id: 'ca_wrong' },
        data: { action: 'push' },
      });
      const res = await deliver(raw, 'auto').expect(202);
      expect(res.body).toMatchObject({ status: 'accepted', fired: 0 });
      expect(await runCount()).toBe(before);
    });

    it('FIRES when the delivery account matches the activation account (fired: 1)', async () => {
      const before = await runCount();
      const raw = JSON.stringify({
        metadata: { trigger_id: F7_INSTANCE, connected_account_id: 'ca_expected' },
        data: { action: 'push' },
      });
      const res = await deliver(raw, 'auto').expect(202);
      expect(res.body).toMatchObject({ status: 'accepted', fired: 1 });
      // Let the fire-and-forget run settle (its history write) before teardown.
      for (let i = 0; i < 40 && (await runCount()) === before; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(await runCount()).toBe(before + 1);
    });
  });
});
