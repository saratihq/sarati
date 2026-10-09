import { createHash, createHmac, randomUUID } from 'node:crypto';

import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';
import { Client } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { EncryptionService } from '../src/common/crypto/encryption.service';
import { ConnectionsService } from '../src/connections/connections.service';
import { PG_POOL } from '../src/database/tokens';
import { ComposioTriggerProvider } from '../src/providers/composio-trigger.provider';
import { SDK_POLLING_FETCH } from '../src/providers/sdk-polling.provider';
import { SDK_WEBHOOK_FETCH } from '../src/providers/sdk-webhook.provider';
import { withActivationLock } from '../src/triggers/activation-lock';
import { TriggerReconcilerJob } from '../src/triggers/canvas/trigger-reconciler.job';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { TriggersService } from '../src/triggers/triggers.service';
import { listenOnLoopback } from './support/listen';
import { seedPlatformKeyEverywhere } from './support/platform-keys';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

// An allowlisted host, so the SDK's SSRF guard skips its DNS lookup; the fetch itself is stubbed.
const FEED_URL = 'http://localhost/retype-feed';

function respond(
  status: number,
  contentType: string,
  text: string,
  headers: Record<string, string> = {},
): FetchLikeResponse {
  return {
    status,
    headers: {
      forEach: (cb) => {
        cb(contentType, 'content-type');
        for (const [name, value] of Object.entries(headers)) cb(value, name);
      },
    },
    text: () => Promise.resolve(text),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

const json = (status: number, body: unknown): FetchLikeResponse =>
  respond(status, 'application/json', JSON.stringify(body));

const headerOf = (headers: Record<string, string> | undefined, name: string): string =>
  Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1] ?? '';

const nowSec = (): number => Math.floor(Date.now() / 1000);

const providerCalls: Array<{ method: string; url: string; body: string; authorization: string }> = [];

// Live Stripe endpoints → the key that created them; another account's key cannot see one, so it 404s.
const stripeEndpoints = new Map<string, string>();
let endpointSeq = 0;
let stripeRefuses: { method: string; status: number } | null = null;
// When set, a DELETE of this endpoint waits for `release`, reporting through `reached` that it has started.
let stripeDeleteGate: { endpoint: string; reached: () => void; release: Promise<void> } | null = null;

// Live GitHub hooks, by their `/repos/<owner>/<repo>/hooks/<id>` path.
const githubHooks = new Set<string>();
let hookSeq = 100;
let githubRefuses: {
  method: string;
  status: number;
  message: string;
  headers?: Record<string, string>;
} | null = null;

// Live Typeform webhooks, `<formId>/<tag>` → the key that last wrote them; a PUT is an upsert, as the real one is.
const typeformHooks = new Map<string, string>();
let typeformRefuses: { method: string; status: number } | null = null;

function stripe(method: string, path: string, authorization: string): FetchLikeResponse {
  if (stripeRefuses?.method === method) {
    return json(stripeRefuses.status, { error: { message: 'Stripe refused the request' } });
  }
  if (method === 'POST' && path === '/v1/webhook_endpoints') {
    endpointSeq += 1;
    const id = `we_retype_${endpointSeq}`;
    stripeEndpoints.set(id, authorization);
    return json(200, { id, secret: `whsec_retype_${endpointSeq}` });
  }
  const id = decodeURIComponent(path.slice('/v1/webhook_endpoints/'.length));
  if (method === 'DELETE' && stripeEndpoints.get(id) === authorization) {
    stripeEndpoints.delete(id);
    return json(200, { id, deleted: true });
  }
  return json(404, { error: { message: 'No such webhook endpoint' } });
}

function github(method: string, path: string): FetchLikeResponse {
  if (githubRefuses?.method === method) {
    const { status, message, headers } = githubRefuses;
    return respond(status, 'application/json', JSON.stringify({ message }), headers);
  }
  if (method === 'POST' && path.endsWith('/hooks')) {
    hookSeq += 1;
    githubHooks.add(`${path}/${hookSeq}`);
    return json(201, { id: hookSeq });
  }
  if (method === 'DELETE' && githubHooks.delete(path)) return respond(204, 'application/json', '');
  return json(404, { message: 'Not Found' });
}

function typeform(method: string, path: string, authorization: string): FetchLikeResponse {
  if (typeformRefuses?.method === method) return json(typeformRefuses.status, { code: 'REFUSED' });
  const hook = /^\/forms\/([^/]+)\/webhooks\/([^/]+)$/.exec(path);
  const key = hook ? `${decodeURIComponent(hook[1]!)}/${decodeURIComponent(hook[2]!)}` : '';
  if (method === 'PUT' && hook) {
    typeformHooks.set(key, authorization);
    return json(200, { tag: decodeURIComponent(hook[2]!), enabled: true });
  }
  if (method === 'DELETE' && typeformHooks.delete(key)) return respond(204, 'application/json', '');
  return json(404, { code: 'NOT_FOUND' });
}

const webhookFetch: FetchLike = (input, init) => {
  const method = (init?.method ?? 'GET').toUpperCase();
  const url = new URL(String(input));
  const authorization = headerOf(init?.headers, 'authorization');
  providerCalls.push({
    method,
    url: url.toString(),
    body: typeof init?.body === 'string' ? init.body : '',
    authorization,
  });
  const gate = stripeDeleteGate;
  if (
    url.host === 'api.stripe.com' &&
    method === 'DELETE' &&
    gate &&
    url.pathname.endsWith(`/${gate.endpoint}`)
  ) {
    stripeDeleteGate = null;
    gate.reached();
    return gate.release.then(() => stripe(method, url.pathname, authorization));
  }
  if (url.host === 'api.stripe.com') return Promise.resolve(stripe(method, url.pathname, authorization));
  if (url.host === 'api.github.com') return Promise.resolve(github(method, url.pathname));
  if (url.host === 'api.typeform.com') return Promise.resolve(typeform(method, url.pathname, authorization));
  return Promise.resolve(json(404, {}));
};

let feed = { contentType: 'application/json', body: '[]' };
let feedDown = false;

const rss = (items: Array<{ guid: string; title: string }>): typeof feed => ({
  contentType: 'application/rss+xml',
  body: `<rss><channel>${items
    .map((i) => `<item><guid>${i.guid}</guid><title>${i.title}</title></item>`)
    .join('')}</channel></rss>`,
});

const conversations: Array<{ id: string; created_at: number }> = [];

// Intercom's search applies the `created_at >` filter it is sent, as the real one does.
function intercomSearch(body: unknown): FetchLikeResponse {
  const search = JSON.parse(String(body)) as { query: { value: Array<{ value: string }> } };
  const since = Number(search.query.value[0]!.value);
  const matched = conversations
    .filter((c) => c.created_at > since)
    .sort((a, b) => a.created_at - b.created_at);
  return json(200, { conversations: matched, pages: {} });
}

const contacts: Array<{ id: string; createdAt: string }> = [];

// When set, the next HubSpot search waits for `release`, reporting through `reached` that it has started.
let hubspotGate: { reached: () => void; release: Promise<void> } | null = null;

// HubSpot's search applies the `createdate GT` filter (epoch ms) it is sent, as the real one does.
function hubspotSearch(body: unknown): Promise<FetchLikeResponse> {
  const search = JSON.parse(String(body)) as { filterGroups: Array<{ filters: Array<{ value: string }> }> };
  const since = Number(search.filterGroups[0]!.filters[0]!.value);
  const results = contacts
    .filter((c) => Date.parse(c.createdAt) > since)
    .map((c) => ({ ...c, properties: {} }));
  const gate = hubspotGate;
  hubspotGate = null;
  if (!gate) return Promise.resolve(json(200, { results }));
  gate.reached();
  return gate.release.then(() => json(200, { results }));
}

const pollingFetch: FetchLike = (input, init) => {
  const url = String(input);
  if (url === 'https://api.intercom.io/conversations/search')
    return Promise.resolve(intercomSearch(init?.body));
  if (url === 'https://api.hubapi.com/crm/v3/objects/contacts/search') return hubspotSearch(init?.body);
  if (feedDown) return Promise.resolve(respond(503, 'text/plain', 'unavailable'));
  return Promise.resolve(respond(200, feed.contentType, feed.body));
};

function triggerDoc(
  nodeType: string,
  parameters: Record<string, unknown>,
  name: string,
  echo = 'title',
  triggerId = 'trigger',
): Record<string, unknown> {
  return {
    version: '1.0',
    name,
    description: '',
    nodes: [
      {
        id: triggerId,
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
        source_node_id: triggerId,
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

// A schedule whose run sits in a six-second wait before it announces.
function waitingScheduleDoc(intervalMinutes: number): Record<string, unknown> {
  const doc = triggerDoc(
    'orchestr:schedule',
    { interval_minutes: intervalMinutes },
    'waiting run',
    'scheduled_at',
  );
  const [trigger, announce] = doc.nodes as Array<Record<string, unknown>>;
  const edge = (from: string, to: string): Record<string, unknown> => ({
    id: `e-${from}-${to}`,
    source_node_id: from,
    source_port: 0,
    target_node_id: to,
    target_port: 0,
    port_type: 'main',
  });
  return {
    ...doc,
    nodes: [
      trigger,
      {
        id: 'pause',
        name: 'Pause',
        node_type: 'orchestr:wait_for_duration',
        type_version: 1,
        parameters: { amount: 0.1, unit: 'minutes' },
        position: { x: 150, y: 0 },
        metadata: {},
      },
      announce,
    ],
    edges: [edge('trigger', 'pause'), edge('pause', 'announce')],
  };
}

describe('changing a live trigger (e2e, isolated DB, fake providers)', () => {
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
  const warnSpy = jest.spyOn(Logger.prototype, 'warn');
  const warnings = (since = 0): string[] => warnSpy.mock.calls.slice(since).map((call) => String(call[0]));

  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const reconcile = (wfId: string): Promise<void> => app.get(TriggerReconcilerService).reconcile(wfId);

  const deploy = async (doc: Record<string, unknown>, org = orgId): Promise<string> => {
    const res = await asA(
      http().post('/api/deploy').set('X-Org-Id', org).send({ workflow_json: doc }),
    ).expect(201);
    return res.body.workflow_id as string;
  };

  const commitAndPublish = async (wfId: string, doc: Record<string, unknown>, org = orgId): Promise<void> => {
    const versions = await asA(http().get(`/api/workflows/${wfId}/versions`).set('X-Org-Id', org)).expect(
      200,
    );
    const head = (versions.body.versions as Array<{ id: string; version_number: number }>).reduce((a, b) =>
      b.version_number > a.version_number ? b : a,
    );
    await asA(
      http()
        .post(`/api/workflows/${wfId}/commit`)
        .set('X-Org-Id', org)
        .send({ workflow_ir: doc, commit_message: 'retype', base_version_id: head.id }),
    ).expect(201);
    await asA(http().post(`/api/workflows/${wfId}/publish`).set('X-Org-Id', org).send({})).expect(201);
    await reconcile(wfId);
  };

  interface ActivationRow {
    id: string;
    kind: string;
    trigger_type: string;
    composio_trigger_instance_id: string | null;
    last_error: string | null;
    materialized: Record<string, unknown> | null;
  }

  const activations = async (wfId: string): Promise<ActivationRow[]> =>
    (
      await db.query<ActivationRow>(
        `SELECT id, kind, trigger_type, composio_trigger_instance_id, last_error, materialized
           FROM runtime_trigger_activations WHERE workflow_id = $1`,
        [wfId],
      )
    ).rows;

  const activation = async (wfId: string): Promise<ActivationRow> => {
    const rows = await activations(wfId);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };

  const stored = async <T>(activationId: string, key: string): Promise<T | null> => {
    const rows = await db.query<{ value: T }>(
      `SELECT value FROM runtime_activation_store WHERE activation_id = $1 AND key = $2`,
      [activationId, key],
    );
    return rows.rows[0]?.value ?? null;
  };

  // The app's handle inside the stored record (a bare handle where an earlier build stored one).
  const registration = async (activationId: string): Promise<Record<string, unknown> | null> => {
    const value = await stored<Record<string, unknown>>(activationId, 'webhook.registration');
    return (value?.registration as Record<string, unknown> | undefined) ?? value;
  };

  const endpointOf = async (activationId: string): Promise<string> =>
    String((await registration(activationId))?.subscriptionId);

  const typeformHookOf = async (activationId: string): Promise<string> => {
    const handle = await registration(activationId);
    return `${String(handle?.formId)}/${String(handle?.subscriptionId)}`;
  };

  const typeformDeletes = (since = 0): string[] =>
    providerCalls
      .slice(since)
      .filter((c) => c.method === 'DELETE' && c.url.includes('api.typeform.com'))
      .map((c) => c.url);

  const subscribedEvents = (since = 0): string[] =>
    providerCalls
      .slice(since)
      .filter((c) => c.method === 'POST' && c.url.endsWith('/v1/webhook_endpoints'))
      .map((c) => new URLSearchParams(c.body).get('enabled_events[0]') ?? '');

  const deletedEndpoints = (since = 0): string[] =>
    providerCalls
      .slice(since)
      .filter((c) => c.method === 'DELETE' && c.url.includes('/v1/webhook_endpoints/'))
      .map((c) => decodeURIComponent(c.url.slice(c.url.lastIndexOf('/') + 1)));

  const retired = async (wfId: string): Promise<Array<{ hook: string; last_error: string | null }>> =>
    (
      await db.query<{ hook: string; last_error: string | null }>(
        `SELECT webhook->'registration'->>'subscriptionId' AS hook, last_error
           FROM trigger_retired_webhooks WHERE workflow_id = $1 ORDER BY created_at`,
        [wfId],
      )
    ).rows;

  const deliverStripe = (wfId: string, secret: unknown, event: Record<string, unknown>): request.Test => {
    const raw = JSON.stringify({ object: 'event', created: 1700000000, livemode: false, ...event });
    const t = '1700000000';
    const sig = createHmac('sha256', String(secret)).update(`${t}.${raw}`).digest('hex');
    return http()
      .post(`/api/hooks/${wfId}/production`)
      .set('Content-Type', 'application/json')
      .set('stripe-signature', `t=${t},v1=${sig}`)
      .send(raw);
  };

  // A signed Typeform submission to the workflow's production intake, answered with the run it started.
  const fireTypeform = async (
    wfId: string,
    activationId: string,
    token: string,
  ): Promise<Record<string, unknown>> => {
    const record = await stored<{ secret: string }>(activationId, 'webhook.registration');
    const raw = JSON.stringify({
      event_id: `evt_${token}`,
      event_type: 'form_response',
      form_response: { form_id: 'form', token, answers: [] },
    });
    const sig = `sha256=${createHmac('sha256', String(record?.secret)).update(raw).digest('base64')}`;
    const fired = await http()
      .post(`/api/hooks/${wfId}/production`)
      .set('Content-Type', 'application/json')
      .set('typeform-signature', sig)
      .send(raw)
      .expect(202);
    return awaitRun(fired.body.run_id as string);
  };

  // Resolves once a two-key advisory lock in this database has a waiter: a reconcile queued behind a poll.
  const activationLockWaiter = async (): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      const { rows } = await db.query(
        `SELECT 1 FROM pg_locks l JOIN pg_database d ON d.oid = l.database
          WHERE l.locktype = 'advisory' AND l.objsubid = 2 AND NOT l.granted AND d.datname = current_database()`,
      );
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const poll = (): Promise<void> => app.get(TriggersService).runActivationPollCycle();

  // Publish while the publish's own reconcile is held back, as a busy queue holds it.
  const publishUnreconciled = async (wfId: string, doc: Record<string, unknown>): Promise<void> => {
    const held = jest.spyOn(app.get(TriggerReconcilerService), 'reconcile').mockResolvedValue();
    try {
      await commitAndPublish(wfId, doc);
    } finally {
      held.mockRestore();
    }
  };

  const announced = async (runId: string): Promise<unknown> =>
    ((await awaitRun(runId)).outputs as Record<string, unknown>).announce;

  const triggerRuns = async (wfId: string): Promise<Array<{ run_id: string }>> => {
    const rows = await db.query<{ run_id: string }>(
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

  const tokenConnection = async (provider: string, token: string, org: string): Promise<string> => {
    const id = randomUUID();
    const credential = app.get(EncryptionService).encryptToken(JSON.stringify({ value: token }));
    await db.query(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status, org_id)
       VALUES ($1, $2, $3, 'token', $4, now(), 'active', $5)`,
      [id, userA, provider, credential, org],
    );
    return id;
  };

  const productionOf = async (org: string): Promise<string> => {
    await asA(http().get('/api/environments').set('X-Org-Id', org)).expect(200);
    const env = await db.query<{ id: string }>(
      `SELECT id FROM environments WHERE org_id = $1 AND lower(name) = 'production'`,
      [org],
    );
    return env.rows[0]!.id;
  };

  // A workspace of its own, so moving its slots reconciles no other test's workflows.
  const workspace = async (name: string): Promise<{ org: string; production: string }> => {
    const created = await asA(http().post('/api/orgs').send({ name })).expect(201);
    const org = created.body.id as string;
    return { org, production: await productionOf(org) };
  };

  const assignSlot = (org: string, envId: string, appSlug: string, connectionId: string): request.Test =>
    asA(
      http()
        .put(`/api/environments/${envId}/slots/${appSlug}`)
        .set('X-Org-Id', org)
        .send({ connection_id: connectionId }),
    ).expect(200);

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
      .useValue(webhookFetch)
      .overrideProvider(SDK_POLLING_FETCH)
      .useValue(pollingFetch)
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

    const production = await productionOf(orgId);
    // Registered webhooks and SDK polling run on the direct rail: a token connection per app slot.
    for (const [appSlug, token] of [
      ['stripe', 'sk_test_e2e'],
      ['github', 'ghp_e2e'],
      ['hubspot', 'pat-e2e'],
      ['intercom', 'ic_e2e'],
      ['typeform', 'tfp_e2e'],
    ]) {
      const conn = await tokenConnection(appSlug!, token!, orgId);
      await db.query(
        `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, $2, $3)`,
        [production, appSlug, conn],
      );
    }
    // The Composio subscription rail needs a managed, active connection.
    const managed = await app.get(ConnectionsService).createManaged(userA, 'acmecrm', 'ca_retype');
    await app.get(ConnectionsService).setStatus(managed.id, 'active');
    await db.query(
      `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, 'acmecrm', $2)`,
      [production, managed.id],
    );
  }, 30_000);

  afterAll(async () => {
    createSpy.mockRestore();
    deleteSpy.mockRestore();
    listSpy.mockRestore();
    warnSpy.mockRestore();
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  afterEach(() => {
    stripeRefuses = null;
    githubRefuses = null;
    typeformRefuses = null;
    feedDown = false;
  });

  it('registered webhook: the old endpoint is deleted and the new event type is registered', async () => {
    const mark = providerCalls.length;
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'retype stripe', 'chargeId'));
    const before = await activation(wfId);
    const oldEndpoint = await endpointOf(before.id);
    expect(oldEndpoint).toMatch(/^we_retype_/);
    expect(subscribedEvents(mark)).toEqual(['customer.created']);

    await commitAndPublish(wfId, triggerDoc('stripe.payment_succeeded', {}, 'retype stripe', 'chargeId'));

    const after = await activation(wfId);
    expect(after).toMatchObject({ kind: 'registered_webhook', trigger_type: 'stripe.payment_succeeded' });
    expect(after.last_error).toBeNull();
    expect(deletedEndpoints(mark)).toEqual([oldEndpoint]);
    expect(subscribedEvents(mark)).toEqual(['customer.created', 'charge.succeeded']);
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

  it('registered webhook: changed props delete the hook from the OLD repository and register it on the new one', async () => {
    const wfId = await deploy(
      triggerDoc('github.new_push', { owner: 'acme', repo: 'old' }, 'retarget github'),
    );
    const before = await activation(wfId);
    const oldHook = `/repos/acme/old/hooks/${await endpointOf(before.id)}`;
    expect(githubHooks.has(oldHook)).toBe(true);

    await commitAndPublish(
      wfId,
      triggerDoc('github.new_push', { owner: 'globex', repo: 'new' }, 'retarget github'),
    );

    expect(githubHooks.has(oldHook)).toBe(false);
    expect(githubHooks.has(`/repos/globex/new/hooks/${await endpointOf(before.id)}`)).toBe(true);
    expect((await activation(wfId)).last_error).toBeNull();
  });

  it("a slot swap deletes the endpoint with the OLD connection's key and registers anew with the new one", async () => {
    const { org, production } = await workspace('Slot swap');
    const first = await tokenConnection('stripe', 'sk_test_first', org);
    const second = await tokenConnection('stripe', 'sk_test_second', org);
    await assignSlot(org, production, 'stripe', first);
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'slot swap'), org);
    const { id } = await activation(wfId);
    const oldEndpoint = await endpointOf(id);
    expect(stripeEndpoints.get(oldEndpoint)).toBe('Bearer sk_test_first');

    await assignSlot(org, production, 'stripe', second);
    await reconcile(wfId);

    expect(stripeEndpoints.has(oldEndpoint)).toBe(false);
    expect(stripeEndpoints.get(await endpointOf(id))).toBe('Bearer sk_test_second');
    expect((await activation(wfId)).last_error).toBeNull();
  });

  it('an emptied slot deletes the endpoint with the connection that registered it', async () => {
    const { org, production } = await workspace('Emptied slot');
    await assignSlot(org, production, 'stripe', await tokenConnection('stripe', 'sk_test_only', org));
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'emptied slot'), org);
    const { id } = await activation(wfId);
    const endpoint = await endpointOf(id);

    await asA(http().delete(`/api/environments/${production}/slots/stripe`).set('X-Org-Id', org)).expect(200);
    await reconcile(wfId);

    expect(stripeEndpoints.has(endpoint)).toBe(false);
    expect(await registration(id)).toBeNull();
    expect((await activation(wfId)).last_error).toMatch(/No connection in this environment's slot/);
  });

  it('a retype whose new registration failed stands it up on the next reconcile', async () => {
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'failed retype'));
    const { id } = await activation(wfId);
    const mark = providerCalls.length;

    stripeRefuses = { method: 'POST', status: 500 };
    await commitAndPublish(wfId, triggerDoc('stripe.payment_succeeded', {}, 'failed retype'));
    stripeRefuses = null;
    expect((await activation(wfId)).last_error).toEqual(expect.any(String));
    expect(await registration(id)).toBeNull();

    await reconcile(wfId);

    expect(subscribedEvents(mark).at(-1)).toBe('charge.succeeded');
    expect(stripeEndpoints.has(await endpointOf(id))).toBe(true);
    expect(await activation(wfId)).toMatchObject({
      last_error: null,
      materialized: { kind: 'registered_webhook', triggerType: 'stripe.payment_succeeded' },
    });
  });

  it('a row an earlier build left pointing at the new type, with the old registration live, is repaired once', async () => {
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'left by an earlier build'));
    const { id } = await activation(wfId);
    const oldEndpoint = await endpointOf(id);

    // What a released build's promote left: the row retyped, nothing torn down, nothing recorded as live.
    await publishUnreconciled(wfId, triggerDoc('stripe.payment_succeeded', {}, 'left by an earlier build'));
    await db.query(
      `UPDATE runtime_trigger_activations a
          SET trigger_type = 'stripe.payment_succeeded', materialized = NULL, version_id = p.version_id
         FROM workflow_env_pointers p
        WHERE a.id = $1 AND p.workflow_id = a.workflow_id AND p.environment_id = a.environment_id`,
      [id],
    );
    await db.query(
      `UPDATE runtime_activation_store SET value = (value::jsonb -> 'registration')::json
        WHERE activation_id = $1 AND key = 'webhook.registration'`,
      [id],
    );
    const mark = providerCalls.length;

    await reconcile(wfId);
    await reconcile(wfId);

    expect(deletedEndpoints(mark)).toEqual([oldEndpoint]);
    expect(subscribedEvents(mark)).toEqual(['charge.succeeded']);
    expect(stripeEndpoints.has(oldEndpoint)).toBe(false);
    expect((await activation(wfId)).materialized).toMatchObject({ triggerType: 'stripe.payment_succeeded' });
  });

  it('an old webhook whose delete fails moves off the trigger, which goes live, and a later reconcile deletes it', async () => {
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'stubborn endpoint'));
    const { id } = await activation(wfId);
    const oldEndpoint = await endpointOf(id);

    stripeRefuses = { method: 'DELETE', status: 500 };
    await commitAndPublish(wfId, triggerDoc('stripe.payment_succeeded', {}, 'stubborn endpoint'));
    stripeRefuses = null;

    const fresh = await endpointOf(id);
    expect(fresh).not.toBe(oldEndpoint);
    expect(stripeEndpoints.has(oldEndpoint)).toBe(true);
    expect(stripeEndpoints.has(fresh)).toBe(true);
    expect(await activation(wfId)).toMatchObject({
      last_error: null,
      materialized: { triggerType: 'stripe.payment_succeeded' },
    });
    expect(await retired(wfId)).toEqual([
      { hook: oldEndpoint, last_error: expect.stringMatching(/HTTP 500/) },
    ]);

    await reconcile(wfId);

    expect(stripeEndpoints.has(oldEndpoint)).toBe(false);
    expect(stripeEndpoints.has(fresh)).toBe(true);
    expect(await retired(wfId)).toEqual([]);
    expect((await activation(wfId)).last_error).toBeNull();
  });

  it('a removed trigger whose webhook delete fails is gone at once, and adding it back stands up a live registration', async () => {
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'removed and re-added', 'customerId'));
    const oldEndpoint = await endpointOf((await activation(wfId)).id);

    stripeRefuses = { method: 'DELETE', status: 500 };
    await commitAndPublish(wfId, triggerDoc('orchestr:trigger', {}, 'removed and re-added'));
    expect(await activations(wfId)).toEqual([]);
    expect(stripeEndpoints.has(oldEndpoint)).toBe(true);
    expect(await retired(wfId)).toEqual([
      { hook: oldEndpoint, last_error: expect.stringMatching(/HTTP 500/) },
    ]);

    // The identical trigger comes back while the old delete is still refused.
    await commitAndPublish(wfId, triggerDoc('stripe.new_customer', {}, 'removed and re-added', 'customerId'));
    stripeRefuses = null;
    await reconcile(wfId);

    const back = await activation(wfId);
    const live = await registration(back.id);
    expect(live?.subscriptionId).not.toBe(oldEndpoint);
    expect(stripeEndpoints.has(String(live?.subscriptionId))).toBe(true);
    expect(stripeEndpoints.has(oldEndpoint)).toBe(false);
    expect(await retired(wfId)).toEqual([]);
    expect(back).toMatchObject({
      last_error: null,
      materialized: { kind: 'registered_webhook', triggerType: 'stripe.new_customer' },
    });

    const fired = await deliverStripe(wfId, live?.signingSecret, {
      id: 'evt_back_1',
      type: 'customer.created',
      data: { object: { id: 'cus_back_1' } },
    }).expect(202);
    const run = await awaitRun(fired.body.run_id as string);
    expect(run.status).toBe('completed');
    expect((run.outputs as Record<string, unknown>).announce).toBe('fired: cus_back_1');
  });

  it('a removed schedule never fires while the webhook it replaced still awaits its delete', async () => {
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'removed schedule'));
    const endpoint = await endpointOf((await activation(wfId)).id);

    stripeRefuses = { method: 'DELETE', status: 500 };
    await commitAndPublish(
      wfId,
      triggerDoc('orchestr:schedule', { interval_minutes: 5 }, 'removed schedule'),
    );
    expect(await activation(wfId)).toMatchObject({ kind: 'schedule' });
    await commitAndPublish(wfId, triggerDoc('orchestr:trigger', {}, 'removed schedule'));

    // Long past due, were anything still scheduled.
    await db.query(
      `UPDATE runtime_trigger_activations SET created_at = now() - interval '1 day' WHERE workflow_id = $1`,
      [wfId],
    );
    await poll();

    expect(await triggerRuns(wfId)).toEqual([]);
    expect(await activations(wfId)).toEqual([]);
    expect(await retired(wfId)).toEqual([{ hook: endpoint, last_error: expect.any(String) }]);
  });

  it("a pending delete whose account was deleted is given up, and the trigger on the slot's new account is healthy", async () => {
    const { org, production } = await workspace('Deleted account');
    const first = await tokenConnection('stripe', 'sk_test_deleted', org);
    await assignSlot(org, production, 'stripe', first);
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'deleted account'), org);
    const { id } = await activation(wfId);
    const original = await endpointOf(id);

    stripeRefuses = { method: 'DELETE', status: 500 };
    await commitAndPublish(wfId, triggerDoc('stripe.payment_succeeded', {}, 'deleted account'), org);
    stripeRefuses = null;
    const replaced = await endpointOf(id);

    const mark = warnSpy.mock.calls.length;
    await asA(http().delete(`/api/orgs/${org}/clusters/connections/${first}`)).expect(200);
    const second = await tokenConnection('stripe', 'sk_test_replacement', org);
    await assignSlot(org, production, 'stripe', second);
    await reconcile(wfId);

    expect(await activation(wfId)).toMatchObject({
      last_error: null,
      materialized: { triggerType: 'stripe.payment_succeeded', connection: { connectionId: second } },
    });
    expect(stripeEndpoints.get(await endpointOf(id))).toBe('Bearer sk_test_replacement');
    expect(await retired(wfId)).toEqual([]);
    // Nothing can delete the first account's endpoints any more, so the operator is told which they are.
    expect(stripeEndpoints.has(original)).toBe(true);
    expect(stripeEndpoints.has(replaced)).toBe(true);
    const abandoned = warnings(mark).filter((w) => w.includes('can never be deleted'));
    expect(abandoned).toEqual(
      expect.arrayContaining([expect.stringContaining(original), expect.stringContaining(replaced)]),
    );
  });

  it('a pending delete the app answers with 403 is given up and named in the log', async () => {
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'rejected credential'));
    const { id } = await activation(wfId);
    const original = await endpointOf(id);
    stripeRefuses = { method: 'DELETE', status: 500 };
    await commitAndPublish(wfId, triggerDoc('stripe.payment_succeeded', {}, 'rejected credential'));

    stripeRefuses = { method: 'DELETE', status: 403 };
    const mark = warnSpy.mock.calls.length;
    await reconcile(wfId);

    expect((await activation(wfId)).last_error).toBeNull();
    expect(warnings(mark)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`${original} .*can never be deleted.*HTTP 403`)),
      ]),
    );
    expect(stripeEndpoints.has(original)).toBe(true);
    expect(await retired(wfId)).toEqual([]);
  });

  it('a GitHub hook delete refused by a rate limit is retried, never given up', async () => {
    const wfId = await deploy(
      triggerDoc('github.new_push', { owner: 'acme', repo: 'limited' }, 'rate limited'),
    );
    const hookId = await endpointOf((await activation(wfId)).id);
    const hook = `/repos/acme/limited/hooks/${hookId}`;

    githubRefuses = {
      method: 'DELETE',
      status: 403,
      message: 'API rate limit exceeded',
      headers: { 'x-ratelimit-remaining': '0' },
    };
    await commitAndPublish(
      wfId,
      triggerDoc('github.new_issue', { owner: 'acme', repo: 'limited' }, 'rate limited'),
    );
    githubRefuses = null;
    expect(githubHooks.has(hook)).toBe(true);
    expect(await retired(wfId)).toEqual([{ hook: hookId, last_error: expect.stringMatching(/HTTP 403/) }]);

    await reconcile(wfId);

    expect(githubHooks.has(hook)).toBe(false);
    expect(await retired(wfId)).toEqual([]);
  });

  it('a GitHub hook that can never be deleted is named in the log with its repository', async () => {
    const wfId = await deploy(
      triggerDoc('github.new_push', { owner: 'acme', repo: 'revoked' }, 'revoked github'),
    );
    const hookId = await endpointOf((await activation(wfId)).id);

    githubRefuses = { method: 'DELETE', status: 401, message: 'Bad credentials' };
    const mark = warnSpy.mock.calls.length;
    await commitAndPublish(
      wfId,
      triggerDoc('github.new_issue', { owner: 'acme', repo: 'revoked' }, 'revoked github'),
    );

    expect(warnings(mark)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          new RegExp(`github.new_push webhook ${hookId} .*acme.*revoked.*can never be deleted`),
        ),
      ]),
    );
    expect(await retired(wfId)).toEqual([]);
  });

  it('a Typeform slot swap whose delete fails keeps the webhook the new account upserted under the same tag', async () => {
    const { org, production } = await workspace('Typeform swap');
    const first = await tokenConnection('typeform', 'tfp_first', org);
    const second = await tokenConnection('typeform', 'tfp_second', org);
    await assignSlot(org, production, 'typeform', first);
    const wfId = await deploy(
      triggerDoc('typeform.new_response', { formId: 'F1' }, 'typeform swap', 'token'),
      org,
    );
    const { id } = await activation(wfId);
    const hook = await typeformHookOf(id);
    expect(typeformHooks.get(hook)).toBe('Bearer tfp_first');

    typeformRefuses = { method: 'DELETE', status: 500 };
    // One reconcile: the old delete fails, and the new account upserts the same tag.
    const held = jest.spyOn(app.get(TriggerReconcilerService), 'reconcile').mockResolvedValue();
    try {
      await assignSlot(org, production, 'typeform', second);
    } finally {
      held.mockRestore();
    }
    await reconcile(wfId);
    typeformRefuses = null;

    expect(await typeformHookOf(id)).toBe(hook);
    expect(typeformHooks.get(hook)).toBe('Bearer tfp_second');
    expect(await retired(wfId)).toEqual([]);

    await reconcile(wfId);

    expect(typeformHooks.get(hook)).toBe('Bearer tfp_second');
    expect(await activation(wfId)).toMatchObject({
      last_error: null,
      materialized: { kind: 'registered_webhook', connection: { connectionId: second } },
    });

    // What a crash between the stand-up and dropping the old delete leaves: a pending delete of the live webhook.
    await db.query(
      `INSERT INTO trigger_retired_webhooks
              (id, workflow_id, environment_id, trigger_node_id, webhook, last_error, created_at, updated_at)
       SELECT gen_random_uuid(), a.workflow_id, a.environment_id, a.trigger_node_id,
              jsonb_set(s.value::jsonb, '{connection,connectionId}', to_jsonb($2::text)), 'HTTP 500', now(), now()
         FROM runtime_activation_store s JOIN runtime_trigger_activations a ON a.id = s.activation_id
        WHERE s.activation_id = $1 AND s.key = 'webhook.registration'`,
      [id, first],
    );
    expect(await retired(wfId)).toHaveLength(1);
    const mark = providerCalls.length;

    await reconcile(wfId);

    expect(typeformDeletes(mark)).toEqual([]);
    expect(typeformHooks.get(hook)).toBe('Bearer tfp_second');
    expect(await retired(wfId)).toEqual([]);
  });

  it('a removed Typeform trigger whose delete fails, added back on the same form, ends live and fires', async () => {
    const wfId = await deploy(
      triggerDoc('typeform.new_response', { formId: 'F2' }, 'typeform back', 'token'),
    );
    const hook = await typeformHookOf((await activation(wfId)).id);

    typeformRefuses = { method: 'DELETE', status: 500 };
    await commitAndPublish(wfId, triggerDoc('orchestr:trigger', {}, 'typeform back'));
    expect(await retired(wfId)).toEqual([
      { hook: hook.split('/')[1], last_error: expect.stringMatching(/HTTP 500/) },
    ]);
    await commitAndPublish(
      wfId,
      triggerDoc('typeform.new_response', { formId: 'F2' }, 'typeform back', 'token'),
    );
    typeformRefuses = null;
    await reconcile(wfId);

    const back = await activation(wfId);
    expect(await typeformHookOf(back.id)).toBe(hook);
    expect(typeformHooks.has(hook)).toBe(true);
    expect(await retired(wfId)).toEqual([]);
    expect(back).toMatchObject({ last_error: null, materialized: { kind: 'registered_webhook' } });
    const run = await fireTypeform(wfId, back.id, 'tok_back');
    expect((run.outputs as Record<string, unknown>).announce).toBe('fired: tok_back');
  });

  it('a Typeform trigger replaced by a new node on the same form keeps the webhook the new node registered', async () => {
    const wfId = await deploy(
      triggerDoc('typeform.new_response', { formId: 'F3' }, 'typeform replaced', 'token'),
    );
    const hook = await typeformHookOf((await activation(wfId)).id);

    await commitAndPublish(
      wfId,
      triggerDoc('typeform.new_response', { formId: 'F3' }, 'typeform replaced', 'token', 'trigger2'),
    );

    const replaced = await activation(wfId);
    expect(await typeformHookOf(replaced.id)).toBe(hook);
    expect(typeformHooks.has(hook)).toBe(true);
    expect(replaced.last_error).toBeNull();
    const run = await fireTypeform(wfId, replaced.id, 'tok_replaced');
    expect((run.outputs as Record<string, unknown>).announce).toBe('fired: tok_replaced');
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
    await poll();

    const runs = await triggerRuns(wfId);
    expect(runs).toHaveLength(1);
    expect(await announced(runs[0]!.run_id)).toBe('fired: rss new');
  });

  it("polling: a retype across apps starts the new trigger from nothing, never from the old one's cursor", async () => {
    conversations.push({ id: 'conv_backlog', created_at: nowSec() - 3600 });
    const wfId = await deploy(triggerDoc('hubspot.new_contact', {}, 'hubspot to intercom', 'id'));
    await poll();

    await commitAndPublish(wfId, triggerDoc('intercom.new_conversation', {}, 'hubspot to intercom', 'id'));
    expect(await activation(wfId)).toMatchObject({
      trigger_type: 'intercom.new_conversation',
      last_error: null,
    });

    conversations.push({ id: 'conv_new', created_at: nowSec() });
    await poll();

    const runs = await triggerRuns(wfId);
    expect(runs).toHaveLength(1);
    expect(await announced(runs[0]!.run_id)).toBe('fired: conv_new');
  });

  it('a retype that changes the rail tears down the OLD rail and stands up the new one', async () => {
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'retype rail'));
    const before = await activation(wfId);
    const oldEndpoint = await endpointOf(before.id);
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

    expect(stripeEndpoints.has(oldEndpoint)).toBe(false);
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
  it('a poll in flight when its trigger is retyped finishes before the old trigger is torn down', async () => {
    conversations.length = 0;
    conversations.push({ id: 'conv_gated_backlog', created_at: nowSec() - 3600 });
    const wfId = await deploy(triggerDoc('hubspot.new_contact', {}, 'gated retype', 'id'));
    await poll();

    let reached = (): void => undefined;
    let release = (): void => undefined;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    hubspotGate = { reached, release: new Promise<void>((resolve) => (release = resolve)) };
    const cycle = poll();
    await atGate;

    const retype = commitAndPublish(wfId, triggerDoc('intercom.new_conversation', {}, 'gated retype', 'id'));
    await Promise.race([retype, activationLockWaiter()]);
    release();
    await cycle;
    await retype;

    conversations.push({ id: 'conv_gated_new', created_at: nowSec() });
    await poll();

    const runs = await triggerRuns(wfId);
    expect(runs).toHaveLength(1);
    expect(await announced(runs[0]!.run_id)).toBe('fired: conv_gated_new');
  });

  it('a poll passes over an activation a reconcile is changing, and polls it on the next cycle', async () => {
    const wfId = await deploy(triggerDoc('orchestr:schedule', { interval_minutes: 5 }, 'held schedule'));
    const { id } = await activation(wfId);
    // Due since a day ago.
    await db.query(
      `UPDATE runtime_trigger_activations SET created_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    await db.query(`DELETE FROM runtime_activation_store WHERE activation_id = $1`, [id]);

    await withActivationLock(app.get(PG_POOL), id, poll);
    expect(await triggerRuns(wfId)).toEqual([]);

    await poll();
    expect(await triggerRuns(wfId)).toHaveLength(1);
  });

  it('a run a poll fired that sits in a wait never holds up a publish of its workflow', async () => {
    const wfId = await deploy(waitingScheduleDoc(5));
    const { id } = await activation(wfId);
    await db.query(
      `UPDATE runtime_trigger_activations SET created_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    await db.query(`DELETE FROM runtime_activation_store WHERE activation_id = $1`, [id]);

    const cycle = poll();
    let runs = await triggerRuns(wfId);
    for (let i = 0; i < 400 && runs.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      runs = await triggerRuns(wfId);
    }
    expect(runs).toHaveLength(1);
    const runStatus = async (): Promise<string> =>
      (
        await db.query<{ status: string }>(`SELECT status FROM runtime_runs WHERE run_id = $1`, [
          runs[0]!.run_id,
        ])
      ).rows[0]!.status;
    const heldActivationLocks = await db.query(
      `SELECT 1 FROM pg_locks l JOIN pg_database d ON d.oid = l.database
        WHERE l.locktype = 'advisory' AND l.objsubid = 2 AND l.granted AND d.datname = current_database()`,
    );
    expect(heldActivationLocks.rows).toEqual([]);

    await commitAndPublish(wfId, waitingScheduleDoc(10));

    expect(await runStatus()).toBe('running');
    expect(await activation(wfId)).toMatchObject({
      last_error: null,
      materialized: { props: { interval_minutes: 10 } },
    });
    await cycle;
    expect(await runStatus()).toBe('completed');
  });

  it("a poll of a row loaded before its trigger was retyped is skipped, never run on the new trigger's store", async () => {
    conversations.length = 0;
    contacts.length = 0;
    contacts.push({ id: 'contact_backlog', createdAt: new Date(Date.now() - 3_600_000).toISOString() });
    const wfId = await deploy(triggerDoc('hubspot.new_contact', {}, 'stale row', 'id'));
    await poll();

    // The cycle loads its rows, and the retype completes before it polls them.
    const em = app.get(DataSource).manager;
    const find = em.find.bind(em) as (...args: unknown[]) => Promise<unknown[]>;
    const loaded = jest.spyOn(em, 'find').mockImplementationOnce((async (...args: unknown[]) => {
      const rows = await find(...args);
      await commitAndPublish(wfId, triggerDoc('intercom.new_conversation', {}, 'stale row', 'id'));
      return rows;
    }) as never);
    try {
      await poll();
    } finally {
      loaded.mockRestore();
    }
    expect(await activation(wfId)).toMatchObject({
      trigger_type: 'intercom.new_conversation',
      last_error: null,
    });

    conversations.push({ id: 'conv_stale_new', created_at: nowSec() });
    await poll();

    const runs = await triggerRuns(wfId);
    expect(runs).toHaveLength(1);
    expect(await announced(runs[0]!.run_id)).toBe('fired: conv_stale_new');
  });

  it('a stand-up cut off before it was recorded tears down the webhook it registered, not the one before', async () => {
    const wfId = await deploy(triggerDoc('github.new_push', { owner: 'acme', repo: 'cut' }, 'cut off'));
    const { id, materialized } = await activation(wfId);
    await commitAndPublish(wfId, triggerDoc('github.new_push', { owner: 'globex', repo: 'cut' }, 'cut off'));
    const registered = `/repos/globex/cut/hooks/${await endpointOf(id)}`;
    // A crash between storing the new registration and recording it leaves the old trigger recorded as live.
    await db.query(`UPDATE runtime_trigger_activations SET materialized = $2 WHERE id = $1`, [
      id,
      JSON.stringify(materialized),
    ]);

    await reconcile(wfId);

    const hooksOn = (repo: string): string[] =>
      [...githubHooks].filter((h) => h.startsWith(`${repo}/hooks/`));
    expect(githubHooks.has(registered)).toBe(false);
    expect(hooksOn('/repos/globex/cut')).toEqual([`/repos/globex/cut/hooks/${await endpointOf(id)}`]);
    expect(hooksOn('/repos/acme/cut')).toEqual([]);
  });

  it('a webhook an earlier release left under a trigger it changed to another kind is named in the log', async () => {
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'left behind'));
    const { id } = await activation(wfId);
    const endpoint = await endpointOf(id);

    // What v0.2.22 left after a retype to a schedule: the row already the new kind, the bare handle still stored.
    await publishUnreconciled(wfId, triggerDoc('orchestr:schedule', { interval_minutes: 5 }, 'left behind'));
    await db.query(
      `UPDATE runtime_trigger_activations a
          SET kind = 'schedule', trigger_type = 'orchestr:schedule', props = '{"interval_minutes":5}',
              connection_id = NULL, connection_owner_user_id = NULL, materialized = NULL, version_id = p.version_id
         FROM workflow_env_pointers p
        WHERE a.id = $1 AND p.workflow_id = a.workflow_id AND p.environment_id = a.environment_id`,
      [id],
    );
    await db.query(
      `UPDATE runtime_activation_store SET value = (value::jsonb -> 'registration')::json
        WHERE activation_id = $1 AND key = 'webhook.registration'`,
      [id],
    );
    const mark = warnSpy.mock.calls.length;

    await reconcile(wfId);

    expect(warnings(mark)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`webhook ${endpoint} .*delete it in the app`)),
      ]),
    );
    expect(await registration(id)).toBeNull();
    expect(await activation(wfId)).toMatchObject({ kind: 'schedule', last_error: null });
  });

  it('a webhook an earlier release left on a trigger whose slot it emptied is named in the log once, never retried', async () => {
    const { org, production } = await workspace('Emptied by an earlier release');
    await assignSlot(org, production, 'stripe', await tokenConnection('stripe', 'sk_test_emptied', org));
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'emptied earlier'), org);
    const { id } = await activation(wfId);
    const endpoint = await endpointOf(id);

    // What v0.2.22 left after the slot was emptied: the row's account cleared, the bare handle still stored.
    const held = jest.spyOn(app.get(TriggerReconcilerService), 'reconcile').mockResolvedValue();
    try {
      await asA(http().delete(`/api/environments/${production}/slots/stripe`).set('X-Org-Id', org)).expect(
        200,
      );
    } finally {
      held.mockRestore();
    }
    await db.query(
      `UPDATE runtime_trigger_activations
          SET connection_id = NULL, connection_owner_user_id = NULL, materialized = NULL
        WHERE id = $1`,
      [id],
    );
    await db.query(
      `UPDATE runtime_activation_store SET value = (value::jsonb -> 'registration')::json
        WHERE activation_id = $1 AND key = 'webhook.registration'`,
      [id],
    );
    const mark = warnSpy.mock.calls.length;

    await reconcile(wfId);
    await reconcile(wfId);
    await reconcile(wfId);

    expect(await retired(wfId)).toEqual([]);
    expect(stripeEndpoints.has(endpoint)).toBe(true);
    expect(warnings(mark).filter((w) => w.includes(endpoint))).toEqual([
      expect.stringMatching(/can never be deleted.*delete it there/),
    ]);
    expect((await activation(wfId)).last_error).toMatch(/No connection in this environment's slot/);
  });

  it('a pending delete outlives its workflow and is retried by the sweep', async () => {
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'deleted workflow'));
    const endpoint = await endpointOf((await activation(wfId)).id);

    stripeRefuses = { method: 'DELETE', status: 500 };
    await commitAndPublish(wfId, triggerDoc('orchestr:trigger', {}, 'deleted workflow'));
    await asA(http().delete(`/api/workflows/${wfId}`).set('X-Org-Id', orgId)).expect(200);
    expect(await retired(wfId)).toEqual([{ hook: endpoint, last_error: expect.any(String) }]);
    stripeRefuses = null;

    await app.get(TriggerReconcilerService).sweepAll();

    expect(stripeEndpoints.has(endpoint)).toBe(false);
    expect(await retired(wfId)).toEqual([]);
  });

  it('a trigger whose new seed failed is passed over by the poll, keeping its error, until a reconcile seeds it', async () => {
    feed = rss([{ guid: 'seed-1', title: 'backlog' }]);
    const wfId = await deploy(triggerDoc('rss.new_item', { url: FEED_URL }, 'failed seed'));
    feed = rss([
      { guid: 'seed-1', title: 'backlog' },
      { guid: 'seed-2', title: 'fired before the change' },
    ]);
    await poll();
    expect(await triggerRuns(wfId)).toHaveLength(1);

    feedDown = true;
    await commitAndPublish(wfId, triggerDoc('rss.new_item', { url: `${FEED_URL}?v=2` }, 'failed seed'));
    feedDown = false;
    expect(await activation(wfId)).toMatchObject({
      last_error: expect.stringMatching(/HTTP 503/),
      materialized: { props: { url: FEED_URL } },
    });

    await poll();

    expect(await triggerRuns(wfId)).toHaveLength(1);
    expect((await activation(wfId)).last_error).toMatch(/HTTP 503/);

    await reconcile(wfId);
    expect(await activation(wfId)).toMatchObject({
      last_error: null,
      materialized: { props: { url: `${FEED_URL}?v=2` } },
    });
    feed = rss([
      { guid: 'seed-1', title: 'backlog' },
      { guid: 'seed-2', title: 'fired before the change' },
      { guid: 'seed-3', title: 'new after the seed' },
    ]);
    await poll();

    const runs = await triggerRuns(wfId);
    expect(runs).toHaveLength(2);
    expect(await announced(runs[1]!.run_id)).toBe('fired: new after the seed');
  });

  it('a poll between a publish and its reconcile polls nothing, and the reconcile starts the new trigger fresh', async () => {
    contacts.length = 0;
    conversations.length = 0;
    const wfId = await deploy(triggerDoc('hubspot.new_contact', {}, 'publish before reconcile', 'id'));
    await poll();

    await publishUnreconciled(
      wfId,
      triggerDoc('intercom.new_conversation', {}, 'publish before reconcile', 'id'),
    );
    contacts.push({ id: 'contact_after_publish', createdAt: new Date().toISOString() });
    await poll();

    expect(await triggerRuns(wfId)).toEqual([]);
    expect(await activation(wfId)).toMatchObject({ trigger_type: 'hubspot.new_contact', last_error: null });

    await reconcile(wfId);
    conversations.push({ id: 'conv_after_reconcile', created_at: nowSec() });
    await poll();

    const runs = await triggerRuns(wfId);
    expect(runs).toHaveLength(1);
    expect(await announced(runs[0]!.run_id)).toBe('fired: conv_after_reconcile');
  });

  it('a due schedule a publish removed fires nothing before the reconcile removes it', async () => {
    const wfId = await deploy(
      triggerDoc('orchestr:schedule', { interval_minutes: 5 }, 'schedule removed', 'scheduled_at'),
    );
    const { id } = await activation(wfId);
    await db.query(
      `UPDATE runtime_trigger_activations SET created_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    await db.query(`DELETE FROM runtime_activation_store WHERE activation_id = $1`, [id]);

    await publishUnreconciled(wfId, triggerDoc('orchestr:trigger', {}, 'schedule removed'));
    await poll();

    expect(await triggerRuns(wfId)).toEqual([]);
    await reconcile(wfId);
    expect(await activations(wfId)).toEqual([]);
  });

  it('a trigger with nothing recorded as live is passed over by the poll and reconciled when the service starts', async () => {
    const url = `${FEED_URL}?upgraded`;
    feed = rss([{ guid: 'up-1', title: 'before the upgrade' }]);
    const wfId = await deploy(triggerDoc('rss.new_item', { url }, 'upgraded'));
    const { id } = await activation(wfId);
    // What an upgrade from v0.2.22 finds.
    await db.query(`UPDATE runtime_trigger_activations SET materialized = NULL WHERE id = $1`, [id]);
    feed = rss([
      { guid: 'up-1', title: 'before the upgrade' },
      { guid: 'up-2', title: 'while upgrading' },
    ]);
    await poll();
    expect(await triggerRuns(wfId)).toEqual([]);

    await app.get(TriggerReconcilerJob).onModuleInit();
    for (let i = 0; i < 200 && (await activation(wfId)).materialized === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(await activation(wfId)).toMatchObject({ last_error: null, materialized: { props: { url } } });
    feed = rss([
      { guid: 'up-1', title: 'before the upgrade' },
      { guid: 'up-2', title: 'while upgrading' },
      { guid: 'up-3', title: 'after the upgrade' },
    ]);
    await poll();

    const runs = await triggerRuns(wfId);
    expect(runs).toHaveLength(1);
    expect(await announced(runs[0]!.run_id)).toBe('fired: after the upgrade');
  });

  it('a pending webhook delete is retried only once the publish it rides with has converged', async () => {
    const wfId = await deploy(triggerDoc('stripe.new_customer', {}, 'retried after converging'));
    const pending = await endpointOf((await activation(wfId)).id);
    stripeRefuses = { method: 'DELETE', status: 500 };
    await commitAndPublish(wfId, triggerDoc('stripe.payment_succeeded', {}, 'retried after converging'));
    stripeRefuses = null;
    expect(await retired(wfId)).toEqual([{ hook: pending, last_error: expect.any(String) }]);

    let reached = (): void => undefined;
    let release = (): void => undefined;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    stripeDeleteGate = {
      endpoint: pending,
      reached,
      release: new Promise<void>((resolve) => (release = resolve)),
    };
    const publishing = commitAndPublish(
      wfId,
      triggerDoc('orchestr:schedule', { interval_minutes: 5 }, 'retried after converging'),
    );
    await atGate;

    const converged = await activation(wfId);
    release();
    await publishing;
    expect(converged).toMatchObject({
      kind: 'schedule',
      materialized: { kind: 'schedule' },
      last_error: null,
    });
    expect(stripeEndpoints.has(pending)).toBe(false);
    expect(await retired(wfId)).toEqual([]);
  });
});
