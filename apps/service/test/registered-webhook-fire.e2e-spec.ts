import { createHash, createHmac, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { EncryptionService } from '../src/common/crypto/encryption.service';
import { SDK_WEBHOOK_FETCH } from '../src/providers/sdk-webhook.provider';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';
const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** The secret Stripe "mints" and returns on webhook-endpoint creation (provider-minted, not ours). */
const STRIPE_MINTED_SECRET = 'whsec_e2e_minted';

/** A JSON FetchLikeResponse. */
function res(status: number, body: unknown): FetchLikeResponse {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    headers: { forEach: (cb) => cb('application/json', 'content-type') },
    text: () => Promise.resolve(text),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

/** Bound to SDK_WEBHOOK_FETCH so `onEnable` never leaves the process; answers create with the minted secret. */
const stubFetch: FetchLike = (input, init) => {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (String(input).includes('/v1/webhook_endpoints') && method === 'POST') {
    return Promise.resolve(res(200, { id: 'we_e2e', secret: STRIPE_MINTED_SECRET }));
  }
  return Promise.resolve(res(200, {}));
};

/** A canvas doc whose trigger is the SDK registered-webhook `stripe.new_customer`. */
function stripeWebhookDoc(): Record<string, unknown> {
  return {
    version: '1.0',
    name: 'stripe registered-webhook target',
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'When a customer is created',
        node_type: 'stripe.new_customer',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: { trigger: true },
      },
      {
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        // Reads the NORMALIZED event — the raw Stripe envelope has no top-level customerId.
        parameters: { texts: ['customer: ', '{{trigger.customerId}}'], separator: '' },
        type_version: 1,
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
  };
}

/** The SDK registered-webhook rail end to end: register, then verify + transform a real delivery. */
describe('SDK registered-webhook fire path (e2e, stubbed provider fetch)', () => {
  let app: INestApplication;
  let db: Client;

  const userA = randomUUID();
  const personalA = randomUUID();
  const keyA = 'ork_e2e_regwebhook_aaaaaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  let orgId = '';
  let wfId = '';

  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  /** A Stripe `Stripe-Signature: t=…,v1=…` header over `${t}.${rawBody}`. */
  const stripeSig = (rawBody: string, secret: string, t = '1700000000'): string =>
    `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;

  const fire = (rawBody: string, sigHeader: string): request.Test =>
    http()
      .post(`/api/hooks/${wfId}/production`)
      .set('Content-Type', 'application/json')
      .set('stripe-signature', sigHeader)
      .send(rawBody);

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'regwh@e2e.local', 'RegWH', now(), now())`,
      [userA],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'RegWH', true, now(), now())`,
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
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';
    process.env.FERNET_KEY = TEST_FERNET_KEY;
    process.env.COMPOSIO_API_KEY = '';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SDK_WEBHOOK_FETCH)
      .useValue(stubFetch)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    const org = await asA(http().post('/api/orgs').send({ name: 'Acme' })).expect(201);
    orgId = org.body.id as string;
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

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

  it('deploy + reconcile registers the stripe webhook against the env-slot connection', async () => {
    const deployed = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: stripeWebhookDoc() }),
    ).expect(201);
    wfId = deployed.body.workflow_id as string;

    // onEnable runs on the direct rail, so the prod env slot needs a DIRECT (token) connection.
    const envRow = await db.query(
      `SELECT id FROM environments WHERE org_id = $1 AND lower(name) = 'production'`,
      [orgId],
    );
    const prodEnvId = envRow.rows[0].id as string;
    const connId = randomUUID();
    const credential = app.get(EncryptionService).encryptToken(JSON.stringify({ value: 'sk_test_e2e' }));
    await db.query(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status, org_id)
       VALUES ($1, $2, 'stripe', 'token', $3, now(), 'active', $4)`,
      [connId, userA, credential, orgId],
    );
    await db.query(
      `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, 'stripe', $2)`,
      [prodEnvId, connId],
    );

    await app.get(TriggerReconcilerService).reconcile(wfId);

    const rows = await db.query(
      `SELECT a.kind, a.trigger_type, a.connection_id, a.paused, a.last_error FROM runtime_trigger_activations a WHERE a.workflow_id = $1`,
      [wfId],
    );
    expect(rows.rows).toEqual([
      {
        kind: 'registered_webhook',
        trigger_type: 'stripe.new_customer',
        connection_id: connId,
        paused: false,
        last_error: null,
      },
    ]);

    // Verify must use the PROVIDER-MINTED secret persisted here, not the one we generated.
    const store = await db.query(
      `SELECT value FROM runtime_activation_store s
         JOIN runtime_trigger_activations a ON a.id = s.activation_id
        WHERE a.workflow_id = $1 AND s.key = 'webhook.registration'`,
      [wfId],
    );
    expect(store.rows[0].value).toMatchObject({
      subscriptionId: 'we_e2e',
      signingSecret: STRIPE_MINTED_SECRET,
    });
  });

  it('a delivery signed with the MINTED secret verifies, is normalized, and fires the run', async () => {
    const raw = JSON.stringify({
      id: 'evt_e2e_1',
      object: 'event',
      type: 'customer.created',
      created: 1700000000,
      livemode: false,
      data: { object: { id: 'cus_e2e_1', email: 'jane@example.com' } },
    });

    const fired = await fire(raw, stripeSig(raw, STRIPE_MINTED_SECRET)).expect(202);
    const run = await awaitRun(fired.body.run_id as string);
    expect(run.status).toBe('completed');
    // Seeing the NORMALIZED customerId proves verify+transform ran.
    expect((run.outputs as Record<string, unknown>).announce).toBe('customer: cus_e2e_1');
  });

  it('a VALID delivery the trigger ignores acks with fired:0 and a null run_id', async () => {
    const before = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM runtime_runs WHERE workflow_id = $1 AND source = 'webhook'`,
      [wfId],
    );
    // Correctly signed, but an event type this trigger does not match — the SDK yields no
    // events. The ack used to carry a freshly minted id for a run that never existed.
    const raw = JSON.stringify({
      id: 'evt_e2e_unmatched',
      object: 'event',
      type: 'invoice.payment_failed',
      created: 1700000002,
      livemode: false,
      data: { object: { id: 'in_e2e_1' } },
    });
    const res = await fire(raw, stripeSig(raw, STRIPE_MINTED_SECRET)).expect(202);
    expect(res.body).toMatchObject({ status: 'accepted', fired: 0, run_id: null });
    expect(res.body.run_ids).toEqual([]);

    const after = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM runtime_runs WHERE workflow_id = $1 AND source = 'webhook'`,
      [wfId],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('a delivery signed with the WRONG secret is rejected 401 and fires nothing', async () => {
    const raw = JSON.stringify({
      id: 'evt_e2e_forged',
      object: 'event',
      type: 'customer.created',
      created: 1700000001,
      livemode: false,
      data: { object: { id: 'cus_forged' } },
    });
    await fire(raw, stripeSig(raw, 'whsec_wrong')).expect(401);

    const runs = await db.query(
      `SELECT count(*)::int AS n FROM runtime_runs WHERE workflow_id = $1 AND source = 'webhook'`,
      [wfId],
    );
    expect(runs.rows[0].n).toBe(1); // only the valid delivery above fired
  });

  it('an unsigned delivery is rejected 401 (verify is the trust boundary)', async () => {
    const raw = JSON.stringify({
      id: 'evt_e2e_unsigned',
      object: 'event',
      type: 'customer.created',
      created: 1700000002,
      livemode: false,
      data: { object: { id: 'cus_unsigned' } },
    });
    await http()
      .post(`/api/hooks/${wfId}/production`)
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(401);
  });
});
