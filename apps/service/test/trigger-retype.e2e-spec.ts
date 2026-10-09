import { createHash, createHmac, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { EncryptionService } from '../src/common/crypto/encryption.service';
import { ConnectionsService } from '../src/connections/connections.service';
import { ComposioTriggerProvider } from '../src/providers/composio-trigger.provider';
import { SDK_POLLING_FETCH } from '../src/providers/sdk-polling.provider';
import { SDK_WEBHOOK_FETCH } from '../src/providers/sdk-webhook.provider';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { TriggersService } from '../src/triggers/triggers.service';
import { listenOnLoopback } from './support/listen';
import { seedPlatformKeyEverywhere } from './support/platform-keys';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

// An allowlisted host, so the SDK's SSRF guard skips its DNS lookup; the fetch itself is stubbed.
const FEED_URL = 'http://localhost/retype-feed';

function respond(status: number, contentType: string, text: string): FetchLikeResponse {
  return {
    status,
    headers: { forEach: (cb) => cb(contentType, 'content-type') },
    text: () => Promise.resolve(text),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

/** Every call the fake Stripe API answered, in order. */
const stripeCalls: Array<{ method: string; url: string; body: string }> = [];
let endpointSeq = 0;

/** A fake Stripe: each endpoint create mints its own id and signing secret; a delete always succeeds. */
const stripeFetch: FetchLike = (input, init) => {
  const method = (init?.method ?? 'GET').toUpperCase();
  const url = String(input);
  stripeCalls.push({ method, url, body: typeof init?.body === 'string' ? init.body : '' });
  if (url.endsWith('/v1/webhook_endpoints') && method === 'POST') {
    endpointSeq += 1;
    const minted = { id: `we_retype_${endpointSeq}`, secret: `whsec_retype_${endpointSeq}` };
    return Promise.resolve(respond(200, 'application/json', JSON.stringify(minted)));
  }
  return Promise.resolve(respond(200, 'application/json', '{}'));
};

/** What the polled feed URL serves right now. */
let feed = { contentType: 'application/json', body: '[]' };
const feedFetch: FetchLike = () => Promise.resolve(respond(200, feed.contentType, feed.body));

const rss = (items: Array<{ guid: string; title: string }>): typeof feed => ({
  contentType: 'application/rss+xml',
  body: `<rss><channel>${items
    .map((i) => `<item><guid>${i.guid}</guid><title>${i.title}</title></item>`)
    .join('')}</channel></rss>`,
});

/** A doc whose `trigger` node is `nodeType`, feeding a step that echoes one field of the event. */
function triggerDoc(
  nodeType: string,
  parameters: Record<string, unknown>,
  name: string,
  echo = 'title',
): Record<string, unknown> {
  return {
    version: '1.0',
    name,
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'When it happens',
        node_type: nodeType,
        type_version: 1,
        parameters,
        position: { x: 0, y: 0 },
        metadata: { trigger: true },
      },
      {
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['fired: ', `{{trigger.${echo}}}`], separator: '' },
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

/** Changing a live trigger's TYPE in place (same node id, same props) is a change the live side must follow. */
describe('retyping a live trigger (e2e, isolated DB, fake providers)', () => {
  let app: INestApplication;
  let db: Client;

  const userA = randomUUID();
  const personalA = randomUUID();
  const keyA = 'ork_e2e_retype_aaaaaaaaaaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  let orgId = '';
  let createSpy: jest.SpyInstance;
  let deleteSpy: jest.SpyInstance;
  let listSpy: jest.SpyInstance;

  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  const deploy = async (doc: Record<string, unknown>): Promise<string> => {
    const res = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: doc }),
    ).expect(201);
    return res.body.workflow_id as string;
  };

  /** Commit `doc` on top of the head and publish it to production — the env-pointer move that reconciles. */
  const commitAndPublish = async (wfId: string, doc: Record<string, unknown>): Promise<void> => {
    const versions = await asA(http().get(`/api/workflows/${wfId}/versions`).set('X-Org-Id', orgId)).expect(
      200,
    );
    const head = (versions.body.versions as Array<{ id: string; version_number: number }>).reduce((a, b) =>
      b.version_number > a.version_number ? b : a,
    );
    await asA(
      http()
        .post(`/api/workflows/${wfId}/commit`)
        .set('X-Org-Id', orgId)
        .send({ workflow_ir: doc, commit_message: 'retype', base_version_id: head.id }),
    ).expect(201);
    await asA(http().post(`/api/workflows/${wfId}/publish`).set('X-Org-Id', orgId).send({})).expect(201);
    await app.get(TriggerReconcilerService).reconcile(wfId);
  };

  const activation = async (
    wfId: string,
  ): Promise<{
    id: string;
    kind: string;
    trigger_type: string;
    composio_trigger_instance_id: string | null;
    last_error: string | null;
  }> => {
    const rows = await db.query(
      `SELECT id, kind, trigger_type, composio_trigger_instance_id, last_error
         FROM runtime_trigger_activations WHERE workflow_id = $1`,
      [wfId],
    );
    expect(rows.rows).toHaveLength(1);
    return rows.rows[0];
  };

  const registration = async (activationId: string): Promise<Record<string, unknown> | null> => {
    const rows = await db.query(
      `SELECT value FROM runtime_activation_store WHERE activation_id = $1 AND key = 'webhook.registration'`,
      [activationId],
    );
    return (rows.rows[0]?.value as Record<string, unknown> | undefined) ?? null;
  };

  const subscribedEvents = (): string[] =>
    stripeCalls
      .filter((c) => c.method === 'POST' && c.url.endsWith('/v1/webhook_endpoints'))
      .map((c) => new URLSearchParams(c.body).get('enabled_events[0]') ?? '');

  const deletedEndpoints = (): string[] =>
    stripeCalls
      .filter((c) => c.method === 'DELETE')
      .map((c) => decodeURIComponent(c.url.slice(c.url.lastIndexOf('/') + 1)));

  const triggerRuns = async (wfId: string): Promise<Array<{ run_id: string }>> => {
    const rows = await db.query(
      `SELECT run_id FROM runtime_runs WHERE workflow_id = $1 AND source = 'trigger' ORDER BY started_at`,
      [wfId],
    );
    return rows.rows;
  };

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
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'retype@e2e.local', 'Retype', now(), now())`,
      [userA],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Retype', true, now(), now())`,
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SDK_WEBHOOK_FETCH)
      .useValue(stripeFetch)
      .overrideProvider(SDK_POLLING_FETCH)
      .useValue(feedFetch)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    const org = await asA(http().post('/api/orgs').send({ name: 'Acme' })).expect(201);
    orgId = org.body.id as string;
    await seedPlatformKeyEverywhere(app, 'composio_api_key', 'ck_e2e_fake_key');

    const composio = app.get(ComposioTriggerProvider);
    createSpy = jest
      .spyOn(composio, 'createTriggerInstance')
      .mockImplementation((_scope, input: { slug: string }) =>
        Promise.resolve(`ti_${input.slug.toLowerCase()}`),
      );
    deleteSpy = jest.spyOn(composio, 'deleteTriggerInstance').mockResolvedValue();
    listSpy = jest.spyOn(composio, 'listActiveInstances').mockResolvedValue([]);

    await asA(http().get('/api/environments').set('X-Org-Id', orgId)).expect(200);
    const env = await db.query(
      `SELECT id FROM environments WHERE org_id = $1 AND lower(name) = 'production'`,
      [orgId],
    );
    const prodEnvId = env.rows[0].id as string;

    // Stripe's registered webhooks run on the direct rail: a token connection in the prod slot.
    const stripeConn = randomUUID();
    const credential = app.get(EncryptionService).encryptToken(JSON.stringify({ value: 'sk_test_e2e' }));
    await db.query(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status, org_id)
       VALUES ($1, $2, 'stripe', 'token', $3, now(), 'active', $4)`,
      [stripeConn, userA, credential, orgId],
    );
    // The Composio subscription rail needs a managed, active connection.
    const managed = await app.get(ConnectionsService).createManaged(userA, 'acmecrm', 'ca_retype');
    await app.get(ConnectionsService).setStatus(managed.id, 'active');
    await db.query(
      `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, 'stripe', $2), ($1, 'acmecrm', $3)`,
      [prodEnvId, stripeConn, managed.id],
    );
  }, 30_000);

  afterAll(async () => {
    createSpy.mockRestore();
    deleteSpy.mockRestore();
    listSpy.mockRestore();
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('registered webhook: the old endpoint is deleted and the new event type is registered', async () => {
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'retype stripe', 'chargeId'));
    const before = await activation(wfId);
    const oldEndpoint = (await registration(before.id))?.subscriptionId;
    expect(oldEndpoint).toEqual(expect.stringMatching(/^we_retype_/));
    expect(subscribedEvents()).toEqual(['customer.created']);

    await commitAndPublish(wfId, triggerDoc('stripe.payment_succeeded', {}, 'retype stripe', 'chargeId'));

    const after = await activation(wfId);
    expect(after).toMatchObject({ kind: 'registered_webhook', trigger_type: 'stripe.payment_succeeded' });
    expect(after.last_error).toBeNull();
    expect(deletedEndpoints()).toEqual([oldEndpoint]);
    expect(subscribedEvents()).toEqual(['customer.created', 'charge.succeeded']);
    const fresh = await registration(after.id);
    expect(fresh?.subscriptionId).not.toBe(oldEndpoint);

    // A delivery for the NEW event, signed with the NEW endpoint's secret, verifies and fires.
    const raw = JSON.stringify({
      id: 'evt_retype_1',
      object: 'event',
      type: 'charge.succeeded',
      created: 1700000000,
      livemode: false,
      data: { object: { id: 'ch_retype_1', amount: 100, currency: 'usd', status: 'succeeded', paid: true } },
    });
    const t = '1700000000';
    const sig = createHmac('sha256', String(fresh?.signingSecret)).update(`${t}.${raw}`).digest('hex');
    const fired = await http()
      .post(`/api/hooks/${wfId}/production`)
      .set('Content-Type', 'application/json')
      .set('stripe-signature', `t=${t},v1=${sig}`)
      .send(raw)
      .expect(202);
    const run = await awaitRun(fired.body.run_id as string);
    expect(run.status).toBe('completed');
    expect((run.outputs as Record<string, unknown>).announce).toBe('fired: ch_retype_1');
  });

  it('Composio subscription: the old instance is deleted and the new trigger is subscribed', async () => {
    const props = { pipeline: 'default' };
    const wfId = await deploy(triggerDoc('acmecrm.new_deal', props, 'retype composio'));
    expect((await activation(wfId)).composio_trigger_instance_id).toBe('ti_new_deal');
    deleteSpy.mockClear();
    createSpy.mockClear();

    await commitAndPublish(wfId, triggerDoc('acmecrm.deal_won', props, 'retype composio'));

    expect(deleteSpy).toHaveBeenCalledWith(expect.any(Object), 'ti_new_deal');
    expect(createSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ slug: 'DEAL_WON', triggerConfig: props }),
    );
    expect(await activation(wfId)).toMatchObject({
      kind: 'composio_subscription',
      trigger_type: 'acmecrm.deal_won',
      composio_trigger_instance_id: 'ti_deal_won',
      last_error: null,
    });
  });

  it('polling: the cursor resets, so the new trigger primes and fires only what is new after the retype', async () => {
    feed = { contentType: 'application/json', body: JSON.stringify([{ id: 'j1', title: 'json backlog' }]) };
    const wfId = await deploy(triggerDoc('http.new_item', { url: FEED_URL }, 'retype poll'));
    expect((await activation(wfId)).trigger_type).toBe('http.new_item');

    feed = rss([{ guid: 'r1', title: 'rss backlog' }]);
    await commitAndPublish(wfId, triggerDoc('rss.new_item', { url: FEED_URL }, 'retype poll'));
    expect(await activation(wfId)).toMatchObject({ kind: 'polling', trigger_type: 'rss.new_item' });

    feed = rss([
      { guid: 'r1', title: 'rss backlog' },
      { guid: 'r2', title: 'rss new' },
    ]);
    await app.get(TriggersService).runActivationPollCycle();

    const runs = await triggerRuns(wfId);
    expect(runs).toHaveLength(1);
    const run = await awaitRun(runs[0]!.run_id);
    expect((run.outputs as Record<string, unknown>).announce).toBe('fired: rss new');
  });

  it('a retype that changes the rail tears down the OLD rail and stands up the new one', async () => {
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'retype rail'));
    const before = await activation(wfId);
    const oldEndpoint = (await registration(before.id))?.subscriptionId;
    expect(oldEndpoint).toEqual(expect.stringMatching(/^we_retype_/));
    createSpy.mockClear();
    // The prod stripe slot holds a direct connection; the Composio leg is shown it as managed.
    const refSpy = jest.spyOn(app.get(ConnectionsService), 'managedRef').mockResolvedValue({
      id: 'conn',
      authType: 'managed',
      status: 'active',
      connectedAccountId: 'ca_stripe',
    });
    try {
      await commitAndPublish(wfId, triggerDoc('stripe.subscription_created', {}, 'retype rail'));
    } finally {
      refSpy.mockRestore();
    }

    expect(deletedEndpoints()).toContain(oldEndpoint);
    expect(await registration(before.id)).toBeNull();
    expect(createSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ slug: 'SUBSCRIPTION_CREATED' }),
    );
    expect(await activation(wfId)).toMatchObject({
      kind: 'composio_subscription',
      trigger_type: 'stripe.subscription_created',
      composio_trigger_instance_id: 'ti_subscription_created',
      last_error: null,
    });
  });
});
