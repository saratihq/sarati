import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { EncryptionService } from '../src/common/crypto/encryption.service';
import { ComposioProvider } from '../src/connections/composio.provider';
import { ConnectionsService } from '../src/connections/connections.service';
import { ComposioTriggerProvider } from '../src/providers/composio-trigger.provider';
import { SDK_POLLING_FETCH, SdkPollingProvider } from '../src/providers/sdk-polling.provider';
import { SDK_WEBHOOK_FETCH, SdkWebhookProvider } from '../src/providers/sdk-webhook.provider';
import { RuntimeCompiler } from '../src/runtime/runtime-compiler';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { TriggersService } from '../src/triggers/triggers.service';
import { EnvPointersService } from '../src/workflows/env-pointers.service';
import { listenOnLoopback } from './support/listen';
import { setPlatformKey } from './support/platform-keys';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

function json(status: number, body: unknown): FetchLikeResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { forEach: (cb) => cb('application/json', 'content-type') },
    text: () => Promise.resolve(text),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

// The workspace's Slack channels; every list and any polled feed answer in-process, so nothing leaves the machine.
const slackChannels: Array<{ id: string; name: string }> = [{ id: 'C_GENERAL', name: 'general' }];
// The credential each channel list was asked with.
const channelLists: string[] = [];
const pollingFetch: FetchLike = (input, init) => {
  if (!String(input).includes('conversations.list')) return Promise.resolve(json(200, []));
  channelLists.push(JSON.stringify(init?.headers ?? {}));
  return Promise.resolve(
    json(200, { ok: true, channels: [...slackChannels], response_metadata: { next_cursor: '' } }),
  );
};

// Stripe's webhook endpoints, created and deleted in-process.
const stripeEndpoints = new Set<string>();
const stripeDeletes: string[] = [];
let endpointSeq = 0;

// GitHub's repository hooks, by `/repos/<owner>/<repo>/hooks/<id>`, and the URL each delivers to: one per URL in a repository, as GitHub keeps them.
const githubHooks = new Map<string, string>();
// Each GitHub hook delete, and the headers it was sent with.
const githubDeletes: Array<{ hook: string; headers: string }> = [];
let githubSeq = 100;
const github = (method: string, path: string, init: Parameters<FetchLike>[1]): FetchLikeResponse => {
  if (method === 'POST' && path.endsWith('/hooks')) {
    const body = typeof init?.body === 'string' ? init.body : '{}';
    const url = String((JSON.parse(body) as { config?: { url?: string } }).config?.url);
    if ([...githubHooks].some(([hook, at]) => hook.startsWith(`${path}/`) && at === url)) {
      return json(422, {
        message: 'Validation Failed',
        errors: [{ message: 'Hook already exists on this repository' }],
      });
    }
    githubSeq += 1;
    githubHooks.set(`${path}/${githubSeq}`, url);
    return json(201, { id: githubSeq });
  }
  if (method === 'DELETE') {
    githubDeletes.push({ hook: path, headers: JSON.stringify(init?.headers ?? {}) });
    return githubHooks.delete(path) ? json(204, {}) : json(404, { message: 'Not Found' });
  }
  return json(404, { message: 'Not Found' });
};

const webhookFetch: FetchLike = (input, init) => {
  const method = (init?.method ?? 'GET').toUpperCase();
  const url = new URL(String(input));
  const path = url.pathname;
  if (url.host === 'api.github.com') return Promise.resolve(github(method, path, init));
  if (method === 'POST' && path === '/v1/webhook_endpoints') {
    endpointSeq += 1;
    stripeEndpoints.add(`we_slotfit_${endpointSeq}`);
    return Promise.resolve(json(200, { id: `we_slotfit_${endpointSeq}`, secret: `whsec_${endpointSeq}` }));
  }
  if (method === 'DELETE' && path.startsWith('/v1/webhook_endpoints/')) {
    const id = decodeURIComponent(path.slice('/v1/webhook_endpoints/'.length));
    stripeDeletes.push(id);
    return Promise.resolve(stripeEndpoints.delete(id) ? json(200, { id, deleted: true }) : json(404, {}));
  }
  return Promise.resolve(json(404, {}));
};

type Rail = 'composio' | 'polling' | 'webhook';
type Fault = 'empty' | 'inactive' | 'wrong_app';

interface TriggerOf {
  nodeType: string;
  app: string;
  name: string;
  props: Record<string, unknown>;
  // The same trigger changed so that its app is asked again: other props, or another type on the same app.
  changed: { nodeType: string; props: Record<string, unknown> };
}

// One app trigger per rail: a Composio subscription, an SDK poll and an SDK registered webhook, each signing in to its app.
const TRIGGERS: Record<Rail, TriggerOf> = {
  composio: {
    nodeType: 'acmecrm.new_deal',
    app: 'acmecrm',
    name: 'On new deal',
    props: { pipeline: 'default' },
    changed: { nodeType: 'acmecrm.new_deal', props: { pipeline: 'sales' } },
  },
  polling: {
    nodeType: 'slack.new_channel',
    app: 'slack',
    name: 'When a channel is created',
    props: {},
    changed: { nodeType: 'slack.new_channel', props: { types: 'public_channel,private_channel' } },
  },
  webhook: {
    nodeType: 'stripe.new_customer',
    app: 'stripe',
    name: 'When a customer signs up',
    props: {},
    changed: { nodeType: 'stripe.payment_succeeded', props: {} },
  },
};

function triggerDoc(
  nodeType: string,
  name: string,
  parameters: Record<string, unknown>,
  steps: Array<Record<string, unknown>> = [],
  triggerId = 'watch',
): Record<string, unknown> {
  return {
    version: '1.0',
    name: `listens: ${name}`,
    description: '',
    nodes: [
      {
        id: triggerId,
        name,
        node_type: nodeType,
        type_version: 1,
        parameters,
        position: { x: 0, y: 0 },
        metadata: { trigger: true },
      },
      {
        id: 'say',
        name: 'Say',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['fired ', '{{trigger.id}}'], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
      ...steps,
    ],
    edges: [
      {
        id: 'e',
        source_node_id: triggerId,
        source_port: 0,
        target_node_id: 'say',
        target_port: 0,
        port_type: 'main',
      },
      ...steps.map((step) => ({
        id: `e-${String(step.id)}`,
        source_node_id: 'say',
        source_port: 0,
        target_node_id: step.id,
        target_port: 0,
        port_type: 'main',
      })),
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

const REFUSED: Record<
  Fault,
  { code: string; reason: string; promote: (env: string, app: string, name: string) => string }
> = {
  empty: {
    code: 'environment_slots_empty',
    reason: 'empty_slot',
    promote: (env, app, name) =>
      `${env} has no ${app} account assigned, so "${name}" can't run there — assign one under Integrations → Environments before promoting here`,
  },
  inactive: {
    code: 'environment_slots_inactive',
    reason: 'inactive_slot',
    promote: (env, app, name) =>
      `${env}'s ${app} account isn't active, so "${name}" can't run there — its owner tests it under Integrations once it works again, or an owner reassigns the slot under Integrations → Environments before promoting here`,
  },
  wrong_app: {
    code: 'environment_slots_unfit',
    reason: 'wrong_app_slot',
    promote: (env, app, name) =>
      `${env}'s ${app} account is for another app, so "${name}" can't run there — reassign it under Integrations → Environments before promoting here`,
  },
};

const LAST_ERROR: Record<Fault, (env: string, app: string, name: string, held: string) => string> = {
  empty: (env, app, name) =>
    `${env} has no ${app} account assigned, so "${name}" can't run there — an owner assigns one under Integrations → Environments`,
  inactive: (env, app, name) =>
    `${env}'s ${app} account isn't active, so "${name}" can't run there — its owner tests it under Integrations once it works again, or an owner reassigns the slot under Integrations → Environments`,
  wrong_app: (env, app, name, held) =>
    `${env}'s ${app} account is for ${held}, so "${name}" can't run there — an owner assigns ${/^[aeiou]/.test(app) ? 'an' : 'a'} ${app} account under Integrations → Environments`,
};

// The words a step that runs only on a one-click account is refused in, by the same rule.
const NEEDS_MANAGED = (env: string, app: string, name: string): string =>
  `${env}'s ${app} account uses its own credentials, and "${name}" runs only on a one-click (managed) one, so it can't run there — an owner assigns a one-click ${app} account under Integrations → Environments`;

// The words a trigger signing in on the SDK's direct rail is refused in when its slot holds a one-click account.
const NEEDS_OWN = (env: string, app: string, name: string): string =>
  `${env}'s ${app} account is one-click (managed), and "${name}" runs only on one that uses its own credentials, so it can't run there — an owner assigns ${/^[aeiou]/.test(app) ? 'an' : 'a'} ${app} account that uses its own credentials under Integrations → Environments`;

// The words a live trigger held while its account isn't active says: a poll waits, what a webhook's or subscription's app sends still runs, and with a change to it waiting neither runs.
const HELD = (env: string, rail: Rail, changeWaits = false): string => {
  const { app: appSlug, name } = TRIGGERS[rail];
  const fires = `what ${appSlug} sends still starts runs, and nothing is changed at ${appSlug} until the account is active again`;
  const resumes = "it isn't polled, and picks up from where it stopped once the account is active again";
  const waits = `a change to it waits, so it starts no run until the account is active again, and then starts afresh, without what happened at ${appSlug} meanwhile`;
  const unchanged = rail === 'polling' ? resumes : fires;
  const meanwhile = changeWaits ? waits : unchanged;
  return `${env}'s ${appSlug} account isn't active, so "${name}" is held: ${meanwhile} — the account's owner tests it under Integrations once it works again, or an owner reassigns the slot under Integrations → Environments`;
};

interface ActivationRow {
  id: string;
  connection_id: string | null;
  trigger_type: string;
  props: Record<string, unknown> | null;
  held: boolean;
  last_error: string | null;
  last_polled_at: Date | null;
  composio_trigger_instance_id: string | null;
  materialized: { connection: { connectionId: string } | null; props: Record<string, unknown> } | null;
}

let app: INestApplication;
let db: Client;

const userA = randomUUID();
const personalA = randomUUID();
const keyA = 'ork_e2e_slotfit_aaaaaaaaaaaaaaaaaaaaaaa';
const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');
const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
const http = (): ReturnType<typeof request> => request(app.getHttpServer());

let subscribed: jest.SpyInstance;
let unsubscribed: jest.SpyInstance;
let seeded: jest.SpyInstance;
let registered: jest.SpyInstance;
let accountStatus: jest.SpyInstance;
let instanceSeq = 0;

const reconcile = (wfId: string, opts: { selfHeal?: boolean } = {}): Promise<void> =>
  app.get(TriggerReconcilerService).reconcile(wfId, opts);
const poll = (): Promise<void> => app.get(TriggersService).runActivationPollCycle();

async function boot(pgBoss: boolean): Promise<void> {
  const e2eUrl = await createE2eDatabase(ADMIN_URL);
  db = new Client({ connectionString: e2eUrl });
  await db.connect();
  await db.query(
    `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'slotfit@e2e.local', 'Slot Fit', now(), now())`,
    [userA],
  );
  await db.query(
    `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Slot Fit', true, now(), now())`,
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
  process.env.PGBOSS_ENABLED = String(pgBoss);
  process.env.THROTTLE_LIMIT = '10000';
  process.env.MOCK_AUTH = 'false';
  process.env.CLERK_ISSUER = '';
  process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SDK_POLLING_FETCH)
    .useValue(pollingFetch)
    .overrideProvider(SDK_WEBHOOK_FETCH)
    .useValue(webhookFetch)
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
  // A one-click account's health check asks Composio with its owner's key.
  await setPlatformKey(app, { kind: 'user', userId: userA }, 'composio_api_key', 'ck_e2e_fake_key');

  const composio = app.get(ComposioTriggerProvider);
  subscribed = jest.spyOn(composio, 'createTriggerInstance').mockImplementation(() => {
    instanceSeq += 1;
    return Promise.resolve(`ti_slotfit_${instanceSeq}`);
  });
  unsubscribed = jest.spyOn(composio, 'deleteTriggerInstance').mockResolvedValue();
  jest.spyOn(composio, 'listActiveInstances').mockResolvedValue([]);
  jest.spyOn(composio, 'verifyWebhook').mockResolvedValue({ ok: true });
  accountStatus = jest.spyOn(app.get(ComposioProvider), 'getAccountStatus').mockResolvedValue('active');
  jest.spyOn(app.get(ComposioProvider), 'deleteAccount').mockResolvedValue();
  seeded = jest.spyOn(app.get(SdkPollingProvider), 'enable');
  registered = jest.spyOn(app.get(SdkWebhookProvider), 'enable');
}

async function shutdown(): Promise<void> {
  jest.restoreAllMocks();
  await app?.close();
  await db?.end();
  process.env.DATABASE_URL = ADMIN_URL;
  process.env.PGBOSS_ENABLED = 'false';
}

const workspace = async (name: string): Promise<{ org: string; production: string; staging: string }> => {
  const created = await asA(http().post('/api/orgs').send({ name })).expect(201);
  const org = created.body.id as string;
  await asA(http().get('/api/environments').set('X-Org-Id', org)).expect(200);
  const envs = await db.query<{ id: string; name: string }>(
    `SELECT id, lower(name) AS name FROM environments WHERE org_id = $1`,
    [org],
  );
  const envId = (named: string): string => envs.rows.find((env) => env.name === named)!.id;
  await setPlatformKey(app, { kind: 'org', orgId: org }, 'composio_api_key', 'ck_e2e_fake_key');
  return { org, production: envId('production'), staging: envId('staging') };
};

const tokenConnection = async (provider: string, status = 'active'): Promise<string> => {
  const id = randomUUID();
  const credential = app
    .get(EncryptionService)
    .encryptToken(JSON.stringify({ value: `tok-${provider}-${id}` }));
  await db.query(
    `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status)
     VALUES ($1, $2, $3, 'token', $4, now(), $5)`,
    [id, userA, provider, credential, status],
  );
  return id;
};

const oneClickConnection = async (provider: string): Promise<string> => {
  const connections = app.get(ConnectionsService);
  const managed = await connections.createManaged(userA, provider, `ca_slotfit_${randomUUID()}`);
  await connections.setStatus(managed.id, 'active');
  return managed.id;
};

// An account signed in with OAuth, renewed through `tokenUrl`; its token is still good for an hour.
const oauthConnection = async (provider: string, tokenUrl: string): Promise<string> => {
  const id = randomUUID();
  const encryption = app.get(EncryptionService);
  const client = {
    clientId: 'slotfit',
    clientSecret: 'slotfit-secret',
    authUrl: tokenUrl,
    tokenUrl,
    scopes: [],
  };
  await db.query(
    `INSERT INTO connections (id, user_id, provider, auth_type, credential, oauth_client, created_at, status)
     VALUES ($1, $2, $3, 'oauth2', $4, $5, now(), 'active')`,
    [
      id,
      userA,
      provider,
      encryption.encryptToken(JSON.stringify(oauthToken(3_600_000))),
      encryption.encryptToken(JSON.stringify(client)),
    ],
  );
  return id;
};

const oauthToken = (expiresInMs: number): Record<string, unknown> => ({
  access_token: 'tok-oauth-slotfit',
  token_type: 'Bearer',
  refresh_token: 'refresh-slotfit',
  expires_at: new Date(Date.now() + expiresInMs).toISOString(),
});

// An account that serves the rail's app: a one-click one for the Composio rail, a token one for the direct ones.
const fitting = (rail: Rail): Promise<string> =>
  rail === 'composio' ? oneClickConnection(TRIGGERS.composio.app) : tokenConnection(TRIGGERS[rail].app);

const otherApp = (rail: Rail): string => (rail === 'polling' ? 'github' : 'slack');

// Written straight to the database: no reconcile is asked for, so the test asks for the one it means.
const setStatus = (connectionId: string, status: string): Promise<unknown> =>
  db.query(`UPDATE connections SET status = $2 WHERE id = $1`, [connectionId, status]);

// Writes the slot directly, as data from before slots checked the app does, without the reconcile a slot move asks for.
const putSlot = async (envId: string, appSlug: string, connectionId: string): Promise<void> => {
  await db.query(
    `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, $2, $3)
     ON CONFLICT (environment_id, app) DO UPDATE SET connection_id = EXCLUDED.connection_id`,
    [envId, appSlug, connectionId],
  );
};

const breakSlot = async (rail: Rail, fault: Fault, envIds: string[]): Promise<string | null> => {
  if (fault === 'empty') return null;
  const held = fault === 'inactive' ? await fitting(rail) : await tokenConnection(otherApp(rail));
  if (fault === 'inactive') await setStatus(held, 'expired');
  for (const envId of envIds) await putSlot(envId, TRIGGERS[rail].app, held);
  return held;
};

const assignSlot = (org: string, envId: string, appSlug: string, connectionId: string): request.Test =>
  asA(
    http()
      .put(`/api/environments/${envId}/slots/${appSlug}`)
      .set('X-Org-Id', org)
      .send({ connection_id: connectionId }),
  ).expect(200);

const deploy = async (
  org: string,
  doc: Record<string, unknown>,
): Promise<{ wf: string; v1: string; created: Record<string, unknown> }> => {
  const deployed = await asA(
    http().post('/api/deploy').set('X-Org-Id', org).send({ workflow_json: doc }),
  ).expect(201);
  const wf = deployed.body.workflow_id as string;
  const versions = await asA(http().get(`/api/workflows/${wf}/versions`).set('X-Org-Id', org)).expect(200);
  return {
    wf,
    v1: (versions.body.versions as Array<{ id: string }>)[0]!.id,
    created: deployed.body as Record<string, unknown>,
  };
};

// Commit `doc` onto main and publish it, with the reconcile the publish asks for held back, as a busy queue holds it.
const publishUnreconciled = async (org: string, wf: string, doc: Record<string, unknown>): Promise<void> => {
  const versions = await asA(http().get(`/api/workflows/${wf}/versions`).set('X-Org-Id', org)).expect(200);
  const head = (versions.body.versions as Array<{ id: string; version_number: number }>).reduce((a, b) =>
    b.version_number > a.version_number ? b : a,
  );
  const held = jest.spyOn(app.get(TriggerReconcilerService), 'reconcile').mockResolvedValue();
  try {
    await asA(
      http()
        .post(`/api/workflows/${wf}/commit`)
        .set('X-Org-Id', org)
        .send({ workflow_ir: doc, commit_message: 'change the trigger', base_version_id: head.id }),
    ).expect(201);
    await asA(http().post(`/api/workflows/${wf}/publish`).set('X-Org-Id', org).send({})).expect(201);
  } finally {
    held.mockRestore();
  }
};

// Commit `doc` onto main, publish it and converge.
const publish = async (org: string, wf: string, doc: Record<string, unknown>): Promise<void> => {
  const versions = await asA(http().get(`/api/workflows/${wf}/versions`).set('X-Org-Id', org)).expect(200);
  const head = (versions.body.versions as Array<{ id: string; version_number: number }>).reduce((a, b) =>
    b.version_number > a.version_number ? b : a,
  );
  await asA(
    http()
      .post(`/api/workflows/${wf}/commit`)
      .set('X-Org-Id', org)
      .send({ workflow_ir: doc, commit_message: 'change the trigger', base_version_id: head.id }),
  ).expect(201);
  await asA(http().post(`/api/workflows/${wf}/publish`).set('X-Org-Id', org).send({})).expect(201);
  await reconcile(wf);
};

// The webhook deletes still to be made for a workflow, and why each waits.
const pendingDeletes = async (wfId: string): Promise<Array<{ hook: string; last_error: string | null }>> =>
  (
    await db.query<{ hook: string; last_error: string | null }>(
      `SELECT webhook -> 'registration' ->> 'subscriptionId' AS hook, last_error
         FROM trigger_retired_webhooks WHERE workflow_id = $1 ORDER BY created_at`,
      [wfId],
    )
  ).rows;

// What the workflow overview reads for a trigger's health.
const shownOn = async (org: string, wfId: string, envId: string): Promise<Record<string, unknown>> => {
  const health = await asA(
    http().get(`/api/triggers/activations?workflow_id=${wfId}`).set('X-Org-Id', org),
  ).expect(200);
  return (health.body.activations as Array<Record<string, unknown>>).find((a) => a.environment_id === envId)!;
};

const activation = async (wfId: string, envId: string): Promise<ActivationRow> => {
  const rows = await db.query<ActivationRow>(
    `SELECT id, connection_id, trigger_type, props, held, last_error, last_polled_at, composio_trigger_instance_id,
            materialized
       FROM runtime_trigger_activations WHERE workflow_id = $1 AND environment_id = $2`,
    [wfId, envId],
  );
  expect(rows.rows).toHaveLength(1);
  return rows.rows[0]!;
};

// The activation's cursors and registration, as stored.
const storeOf = async (activationId: string): Promise<Record<string, unknown>> => {
  const rows = await db.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM runtime_activation_store WHERE activation_id = $1 ORDER BY key`,
    [activationId],
  );
  return Object.fromEntries(rows.rows.map((row) => [row.key, row.value]));
};

// Every call made at an app to stand a trigger up, whatever account it named.
const standUps = (): number =>
  subscribed.mock.calls.length + seeded.mock.calls.length + registered.mock.calls.length;

// Every call made at an app to take a trigger down.
const teardowns = (): number => unsubscribed.mock.calls.length + stripeDeletes.length;

// How often the rail was asked to stand a trigger up as this account.
const standUpsAs = async (rail: Rail, connectionId: string | null): Promise<number> => {
  if (connectionId === null) return 0;
  const byAuth = (spy: jest.SpyInstance): number =>
    spy.mock.calls.filter(
      (call) =>
        (call[call.length - 1] as { auth: { connectionId?: string } | null }).auth?.connectionId ===
        connectionId,
    ).length;
  if (rail === 'polling') return byAuth(seeded);
  if (rail === 'webhook') return byAuth(registered);
  const account = (await app.get(ConnectionsService).managedRef(userA, connectionId))?.connectedAccountId;
  return subscribed.mock.calls.filter(
    (call) => account && (call[1] as { connectedAccountId: string }).connectedAccountId === account,
  ).length;
};

// The runs a trigger started, by a poll or a delivery.
const triggerRuns = async (wfId: string): Promise<string[]> =>
  (
    await db.query<{ run_id: string }>(
      `SELECT run_id FROM runtime_runs WHERE workflow_id = $1 AND source IN ('trigger', 'webhook') ORDER BY started_at`,
      [wfId],
    )
  ).rows.map((row) => row.run_id);

// A delivery from what a live trigger set up at its app: an event on its Composio subscription, or a signed Stripe event at its intake.
const deliver = async (
  rail: Exclude<Rail, 'polling'>,
  wfId: string,
  live: ActivationRow,
  id: string,
  stripeEvent = 'customer.created',
  environment = 'production',
): Promise<Record<string, unknown>> => {
  if (rail === 'composio') {
    const sent = await http()
      .post('/api/hooks/composio')
      .set('Content-Type', 'application/json')
      .set('webhook-id', `msg_${id}`)
      .send({ metadata: { trigger_id: live.composio_trigger_instance_id }, data: { id } })
      .expect(202);
    return sent.body as Record<string, unknown>;
  }
  const record = (await storeOf(live.id))['webhook.registration'] as {
    registration: { signingSecret: string };
  };
  const raw = JSON.stringify({
    id: `evt_${id}`,
    object: 'event',
    type: stripeEvent,
    created: 1700000000,
    livemode: false,
    data: { object: { id } },
  });
  const t = '1700000000';
  const signature = createHmac('sha256', record.registration.signingSecret)
    .update(`${t}.${raw}`)
    .digest('hex');
  const sent = await http()
    .post(`/api/hooks/${wfId}/${environment}`)
    .set('Content-Type', 'application/json')
    .set('stripe-signature', `t=${t},v1=${signature}`)
    .send(raw)
    .expect(202);
  return sent.body as Record<string, unknown>;
};

const said = async (runId: string): Promise<unknown> => {
  let run: Record<string, unknown> = {};
  for (let i = 0; i < 50; i++) {
    run = (await asA(http().get(`/api/runs/${runId}`)).expect(200)).body as Record<string, unknown>;
    if (run.status === 'completed' || run.status === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return (run.outputs as Record<string, unknown> | undefined)?.say;
};

// Waits, without asking for a reconcile, until `check` passes; fails with its last failure past the bound.
const eventually = async (check: () => Promise<void>, withinMs = 5_000): Promise<void> => {
  const deadline = Date.now() + withinMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
};

// Waits until `count` statements naming `table` wait on a lock.
const lockWaiters = (count: number, table: string): Promise<void> =>
  eventually(async () => {
    const waiting = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
      [`%${table}%`],
    );
    expect(Number(waiting.rows[0]!.n)).toBe(count);
  });

// Parks every reconcile at a gate until `release`, recording the workflow each was for.
const parkReconciles = (): {
  started: (wfId: string) => number;
  release: () => void;
  restore: () => void;
} => {
  const reconciler = app.get(TriggerReconcilerService);
  const reconcileNow = reconciler.reconcile.bind(reconciler);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started: string[] = [];
  const parked = jest
    .spyOn(reconciler, 'reconcile')
    .mockImplementation(async (wfId: string, opts?: { selfHeal?: boolean }) => {
      started.push(wfId);
      await gate;
      return reconcileNow(wfId, opts);
    });
  return {
    started: (wfId) => started.filter((id) => id === wfId).length,
    release: () => release(),
    restore: () => {
      release();
      parked.mockRestore();
    },
  };
};

// Parks the next read of which version `wfId` runs, as an intake makes it after reading its activation, until `release`.
const parkPointerRead = (
  wfId: string,
): { reached: Promise<void>; release: () => void; restore: () => void } => {
  const pointers = app.get(EnvPointersService);
  const readNow = pointers.resolveVersionIdForEnv.bind(pointers);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let arrive = (): void => undefined;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  let armed = true;
  const parked = jest.spyOn(pointers, 'resolveVersionIdForEnv').mockImplementation(async (em, wf, env) => {
    if (armed && wf.id === wfId) {
      armed = false;
      arrive();
      await gate;
    }
    return readNow(em, wf, env);
  });
  return {
    reached,
    release: () => release(),
    restore: () => {
      release();
      parked.mockRestore();
    },
  };
};

// A push GitHub signs with the secret its hook was registered with, at a production intake.
const push = async (wfId: string, secret: string, after: string): Promise<Record<string, unknown>> => {
  const raw = JSON.stringify({
    ref: 'refs/heads/main',
    before: '0',
    after,
    repository: { full_name: 'acme/held' },
    commits: [],
  });
  const sent = await http()
    .post(`/api/hooks/${wfId}/production`)
    .set('Content-Type', 'application/json')
    .set('x-github-event', 'push')
    .set('x-github-delivery', after)
    .set('x-hub-signature-256', `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`)
    .send(raw)
    .expect(202);
  return sent.body as Record<string, unknown>;
};

// A live trigger on `rail` in a workspace of its own, its production slot holding a fitting account.
const liveTrigger = async (
  rail: Rail,
  label: string,
): Promise<{ org: string; production: string; account: string; wf: string; live: ActivationRow }> => {
  const { app: appSlug, name, nodeType, props } = TRIGGERS[rail];
  const { org, production } = await workspace(`${label} ${rail}`);
  const account = await fitting(rail);
  await assignSlot(org, production, appSlug, account);
  const { wf, created } = await deploy(org, triggerDoc(nodeType, name, props));
  expect(created).toMatchObject({ is_live: true, activated: true, activation_error: null });
  const live = await activation(wf, production);
  expect(live).toMatchObject({ connection_id: account, held: false, last_error: null });
  expect(await standUpsAs(rail, account)).toBe(1);
  return { org, production, account, wf, live };
};

const RAILS: Rail[] = ['composio', 'polling', 'webhook'];
const FAULTS: Fault[] = ['empty', 'inactive', 'wrong_app'];

// The call each rail stands a trigger up with, and the stand-ups that can fail.
const STAND_UP: Record<Rail, () => jest.SpyInstance> = {
  composio: () => subscribed,
  polling: () => seeded,
  webhook: () => registered,
};
const STAND_UPS = ['its first stand-up', "its change's stand-up"];

// Constitution #11: a trigger listens as its slot only while #18's slot half says the slot serves it, at a promote and at a stand-up.
describe('an app trigger listens only as a slot that serves it (e2e, isolated DB, fake providers)', () => {
  beforeAll(() => boot(false), 30_000);
  afterAll(shutdown);

  const NAMINGS = ['names an account', 'names none'];
  const CASES: Array<[Rail, string, Fault]> = RAILS.flatMap((rail) =>
    NAMINGS.flatMap((naming) => FAULTS.map((fault): [Rail, string, Fault] => [rail, naming, fault])),
  );

  it.each(CASES)(
    'a %s trigger that %s is refused by promote, publish and restore while its slot is %s, and passes once the slot serves it',
    async (rail, naming, fault) => {
      const { app: appSlug, name, nodeType, props } = TRIGGERS[rail];
      const { org, production, staging } = await workspace(`refuse ${rail} ${naming} ${fault}`);
      const named = naming === 'names an account' ? { connectionId: await fitting(rail) } : {};
      await breakSlot(rail, fault, [production, staging]);
      const { wf, v1 } = await deploy(org, triggerDoc(nodeType, name, { ...props, ...named }));
      const expected = REFUSED[fault];
      const refusedNode = { node_id: 'watch', node_name: name, app: appSlug, reason: expected.reason };

      const promoted = await asA(
        http()
          .post(`/api/workflows/${wf}/promote`)
          .set('X-Org-Id', org)
          .send({ environment: 'staging', version_id: v1 }),
      ).expect(428);
      expect(promoted.body).toMatchObject({
        detail: expected.promote('staging', appSlug, name),
        code: expected.code,
        environment: 'staging',
        apps: [appSlug],
        steps: [],
        triggers: [refusedNode],
      });
      for (const door of ['publish', 'restore']) {
        const refused = await asA(
          http().post(`/api/workflows/${wf}/${door}`).set('X-Org-Id', org).send({ version_number: 1 }),
        ).expect(428);
        expect(refused.body).toMatchObject({
          detail: expected.promote('production', appSlug, name),
          code: expected.code,
          triggers: [refusedNode],
        });
      }
      const pointers = await db.query(
        `SELECT 1 FROM workflow_env_pointers WHERE workflow_id = $1 AND environment_id = $2`,
        [wf, staging],
      );
      expect(pointers.rows).toHaveLength(0);

      const serving = await fitting(rail);
      await assignSlot(org, staging, appSlug, serving);
      await assignSlot(org, production, appSlug, serving);
      await asA(
        http()
          .post(`/api/workflows/${wf}/promote`)
          .set('X-Org-Id', org)
          .send({ environment: 'staging', version_id: v1 }),
      ).expect(201);
      await asA(
        http().post(`/api/workflows/${wf}/publish`).set('X-Org-Id', org).send({ version_number: 1 }),
      ).expect(201);
    },
  );

  it.each(RAILS.flatMap((rail) => FAULTS.map((fault): [Rail, Fault] => [rail, fault])))(
    'a %s trigger whose slot is %s is not stood up, asking nothing of any app, says why on its activation, and stands up once a slot move serves it',
    async (rail, fault) => {
      const { app: appSlug, name, nodeType, props } = TRIGGERS[rail];
      const { org, production } = await workspace(`reconcile ${rail} ${fault}`);
      await breakSlot(rail, fault, [production]);
      const refusal = LAST_ERROR[fault]('production', appSlug, name, otherApp(rail));
      const before = standUps();
      const { wf, created } = await deploy(org, triggerDoc(nodeType, name, props));
      expect(created).toMatchObject({ is_live: true, activated: false, activation_error: refusal });

      const held = await activation(wf, production);
      expect(held).toMatchObject({
        connection_id: null,
        held: false,
        composio_trigger_instance_id: null,
        last_error: refusal,
        materialized: { connection: null },
      });
      expect(await storeOf(held.id)).toEqual({});
      await reconcile(wf);
      expect(await activation(wf, production)).toMatchObject({ id: held.id, last_error: refusal });
      expect(standUps()).toBe(before);
      expect(await shownOn(org, wf, production)).toMatchObject({
        held_back_by_slot: true,
        listening: false,
        last_error: refusal,
      });

      const serving = await fitting(rail);
      await assignSlot(org, production, appSlug, serving);
      await reconcile(wf);

      const live = await activation(wf, production);
      expect(live).toMatchObject({
        id: held.id,
        connection_id: serving,
        last_error: null,
        materialized: { connection: { connectionId: serving } },
      });
      expect(await standUpsAs(rail, serving)).toBe(1);
      expect(standUps()).toBe(before + 1);
      expect(await shownOn(org, wf, production)).toMatchObject({
        held_back_by_slot: false,
        last_error: null,
      });
    },
  );

  it.each(RAILS)(
    'a live %s trigger whose account stops being active is held as it was stood up — never polled, nothing asked of its app — and picks up where it left off once the account is active again',
    async (rail) => {
      const { org, production, account, wf, live } = await liveTrigger(rail, 'held');
      const store = await storeOf(live.id);
      if (rail !== 'composio') expect(store).not.toEqual({});
      const refusal = HELD('production', rail);
      const listsAs = (): number => channelLists.filter((headers) => headers.includes(account)).length;
      const [calledUp, calledDown, lists] = [standUps(), teardowns(), listsAs()];
      if (rail === 'polling') expect(lists).toBeGreaterThan(0);

      await setStatus(account, 'expired');
      await reconcile(wf);
      await reconcile(wf, { selfHeal: true });

      expect(await activation(wf, production)).toEqual({
        ...live,
        held: true,
        last_error: refusal,
      });
      expect(await storeOf(live.id)).toEqual(store);
      expect(await shownOn(org, wf, production)).toMatchObject({
        held_back_by_slot: true,
        listening: rail !== 'polling',
        last_error: refusal,
      });

      slackChannels.push({ id: `C_NEW_${rail}`, name: `new-${rail}` });
      await poll();
      expect(await activation(wf, production)).toMatchObject({
        held: true,
        last_polled_at: null,
        last_error: refusal,
      });
      expect(listsAs()).toBe(lists);

      if (rail !== 'polling') {
        // A delivery the app still sends fires, and the trigger stays held for the reason it was.
        expect(await deliver(rail, wf, live, `D_HELD_${rail}`)).toMatchObject({ fired: 1 });
        await eventually(async () => expect(await triggerRuns(wf)).toHaveLength(1));
        expect(await activation(wf, production)).toMatchObject({ held: true, last_error: refusal });
      }
      if (rail === 'composio') {
        // One that fails to fire leaves the hold's reason, which names the fix, in place.
        jest.spyOn(app.get(RuntimeCompiler), 'compile').mockImplementationOnce(() => {
          throw new Error('the version does not compile');
        });
        expect(await deliver(rail, wf, live, 'D_HELD_UNFIRED')).toMatchObject({ fired: 0 });
        expect(await activation(wf, production)).toMatchObject({ held: true, last_error: refusal });
      }
      expect([standUps(), teardowns()]).toEqual([calledUp, calledDown]);

      await setStatus(account, 'active');
      await reconcile(wf);

      expect(await activation(wf, production)).toMatchObject({
        id: live.id,
        connection_id: account,
        held: false,
        last_error: null,
        composio_trigger_instance_id: live.composio_trigger_instance_id,
        materialized: live.materialized,
      });
      expect(await storeOf(live.id)).toMatchObject(store);
      expect([standUps(), teardowns()]).toEqual([calledUp, calledDown]);
      expect(await shownOn(org, wf, production)).toMatchObject({
        held_back_by_slot: false,
        listening: true,
        last_error: null,
      });

      if (rail === 'polling') {
        // The kept cursor never saw the channel made while it was held, so the first poll fires it.
        await poll();
        const runs = await triggerRuns(wf);
        expect(runs).toHaveLength(1);
        expect(await said(runs[0]!)).toBe('fired C_NEW_polling');
      }
    },
  );

  it.each(RAILS)(
    'a live %s trigger whose slot moves to another account that is not active is torn down and held back, as an emptied slot tears one down',
    async (rail) => {
      const { app: appSlug, name } = TRIGGERS[rail];
      const { org, production, account, wf, live } = await liveTrigger(rail, 'moved');
      const [calledUp, calledDown] = [standUps(), teardowns()];

      const other = await fitting(rail);
      await setStatus(other, 'expired');
      await assignSlot(org, production, appSlug, other);
      await reconcile(wf);

      expect(await activation(wf, production)).toMatchObject({
        id: live.id,
        connection_id: null,
        held: false,
        composio_trigger_instance_id: null,
        last_error: LAST_ERROR.inactive('production', appSlug, name, ''),
        materialized: { connection: null },
      });
      expect(await storeOf(live.id)).toEqual({});
      expect(standUps()).toBe(calledUp);
      expect(teardowns()).toBe(calledDown + (rail === 'polling' ? 0 : 1));
      expect(await standUpsAs(rail, account)).toBe(1);
    },
  );

  it.each(RAILS)(
    'a change to a held %s trigger that its app must be asked about waits, holding what is live and saying it starts no run, and is made once the account is active again',
    async (rail) => {
      const { name, changed } = TRIGGERS[rail];
      const { org, production, account, wf, live } = await liveTrigger(rail, 'waits');
      const store = await storeOf(live.id);
      await publishUnreconciled(org, wf, triggerDoc(changed.nodeType, name, changed.props));
      const [calledUp, calledDown] = [standUps(), teardowns()];

      await setStatus(account, 'expired');
      await reconcile(wf);

      const waiting = HELD('production', rail, true);
      expect(await activation(wf, production)).toEqual({ ...live, held: true, last_error: waiting });
      expect(await storeOf(live.id)).toEqual(store);
      expect([standUps(), teardowns()]).toEqual([calledUp, calledDown]);
      expect(await shownOn(org, wf, production)).toMatchObject({
        held_back_by_slot: true,
        listening: false,
        last_error: waiting,
      });
      if (rail === 'polling') {
        slackChannels.push({ id: 'C_WAITED', name: 'made-while-a-change-waited' });
      } else {
        // What the old trigger's app still sends is for the old trigger, never the version waiting to replace it.
        const delivered = await deliver(rail, wf, live, `D_OLD_${rail}`, 'charge.succeeded');
        expect(delivered).toMatchObject({ fired: 0 });
        expect(await triggerRuns(wf)).toEqual([]);
        expect(await activation(wf, production)).toMatchObject({ held: true, last_error: waiting });
      }

      await setStatus(account, 'active');
      await reconcile(wf);

      expect(await activation(wf, production)).toMatchObject({
        id: live.id,
        connection_id: account,
        trigger_type: changed.nodeType,
        props: changed.props,
        held: false,
        last_error: null,
        materialized: { connection: { connectionId: account }, props: changed.props },
      });
      expect(await standUpsAs(rail, account)).toBe(2);
      expect(teardowns()).toBe(calledDown + (rail === 'polling' ? 0 : 1));
      if (rail === 'polling') {
        // It started afresh: the channel made while its change waited is behind it, as the reason said.
        const listsAs = (): number => channelLists.filter((headers) => headers.includes(account)).length;
        const lists = listsAs();
        await poll();
        expect(listsAs()).toBeGreaterThan(lists);
        expect(await triggerRuns(wf)).toEqual([]);
      }
    },
  );

  it.each(RAILS.flatMap((rail) => STAND_UPS.map((which): [Rail, string] => [rail, which])))(
    'a %s trigger whose account stops being active after %s failed is held back with the refusal, never held, and stands up once the account is active again',
    async (rail, which) => {
      const { app: appSlug, name, nodeType, props, changed } = TRIGGERS[rail];
      const { org, production } = await workspace(`never finished ${rail} ${which}`);
      const account = await fitting(rail);
      await assignSlot(org, production, appSlug, account);
      const refused = `${appSlug} refused the stand-up`;
      const failNextStandUp = (): void => {
        STAND_UP[rail]().mockRejectedValueOnce(new Error(refused));
      };
      let wf: string;
      if (which === 'its first stand-up') {
        failNextStandUp();
        ({ wf } = await deploy(org, triggerDoc(nodeType, name, props)));
      } else {
        ({ wf } = await deploy(org, triggerDoc(nodeType, name, props)));
        await publishUnreconciled(org, wf, triggerDoc(changed.nodeType, name, changed.props));
        failNextStandUp();
        await reconcile(wf);
      }
      const failed = await activation(wf, production);
      expect(failed).toMatchObject({
        connection_id: account,
        held: false,
        composio_trigger_instance_id: null,
        last_error: refused,
      });
      if (which === "its change's stand-up") {
        // What was live is torn down, and the row still records it as the last thing stood up.
        expect(failed).toMatchObject({
          trigger_type: changed.nodeType,
          props: changed.props,
          materialized: { triggerType: nodeType, props },
        });
      } else {
        expect(failed.materialized).toBeNull();
      }
      const [calledUp, calledDown] = [standUps(), teardowns()];

      await setStatus(account, 'expired');
      await reconcile(wf);

      // Nothing was live to hold, so it waits as a new stand-up does, saying it can't run there.
      const refusal = LAST_ERROR.inactive('production', appSlug, name, '');
      expect(await activation(wf, production)).toMatchObject({
        id: failed.id,
        connection_id: null,
        held: false,
        last_error: refusal,
        materialized: { connection: null },
      });
      expect(await shownOn(org, wf, production)).toMatchObject({
        held_back_by_slot: true,
        listening: false,
        last_error: refusal,
      });
      expect([standUps(), teardowns()]).toEqual([calledUp, calledDown]);

      await setStatus(account, 'active');
      await reconcile(wf);

      expect(await activation(wf, production)).toMatchObject({
        id: failed.id,
        connection_id: account,
        held: false,
        last_error: null,
        materialized: { connection: { connectionId: account } },
      });
      expect(standUps()).toBe(calledUp + 1);
    },
  );

  it('a held GitHub webhook whose slot an owner reassigns, as its reason says, is registered anew as that account, which deletes the hook GitHub would refuse a second one beside', async () => {
    const name = 'On push';
    const { org, production } = await workspace('reassign held github');
    const first = await tokenConnection('github');
    await assignSlot(org, production, 'github', first);
    const { wf } = await deploy(org, triggerDoc('github.new_push', name, { owner: 'acme', repo: 'held' }));
    const live = await activation(wf, production);
    const registeredAs = async (): Promise<{ hook: string; secret: string }> => {
      const store = await storeOf(live.id);
      const record = store['webhook.registration'] as { registration: { subscriptionId: string } };
      return {
        hook: `/repos/acme/held/hooks/${record.registration.subscriptionId}`,
        secret: store['webhook.secret'] as string,
      };
    };
    const held = await registeredAs();
    expect(githubHooks.has(held.hook)).toBe(true);

    await setStatus(first, 'expired');
    await reconcile(wf);
    expect(await activation(wf, production)).toMatchObject({ held: true, last_error: expect.any(String) });
    expect(await push(wf, held.secret, 'sha-held')).toMatchObject({ fired: 1 });

    const second = await tokenConnection('github');
    await assignSlot(org, production, 'github', second);
    await reconcile(wf);
    await app.get(TriggerReconcilerService).retriesSettled();

    expect(await activation(wf, production)).toMatchObject({
      id: live.id,
      connection_id: second,
      held: false,
      last_error: null,
      materialized: { connection: { connectionId: second } },
    });
    const moved = await registeredAs();
    expect([...githubHooks.keys()].filter((hook) => hook.startsWith('/repos/acme/held/'))).toEqual([
      moved.hook,
    ]);
    // The old hook was deleted once, with the account the slot now holds, never the one that isn't active.
    const deletes = githubDeletes.filter((d) => d.hook === held.hook);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.headers).toContain(`tok-github-${second}`);
    expect(githubDeletes.some((d) => d.headers.includes(`tok-github-${first}`))).toBe(false);
    expect(await pendingDeletes(wf)).toEqual([]);
    expect(await shownOn(org, wf, production)).toMatchObject({
      held_back_by_slot: false,
      listening: true,
      last_error: null,
    });
    expect(await push(wf, moved.secret, 'sha-moved')).toMatchObject({ fired: 1 });
  });

  it.each(['held', 'held back', 'released'] as const)(
    'a Composio delivery that read its row before its trigger was %s leaves the reason that change wrote, or records its own failed fire',
    async (change) => {
      const { app: appSlug, name } = TRIGGERS.composio;
      const { production, account, wf, live } = await liveTrigger('composio', `read before ${change}`);
      const written = {
        held: HELD('production', 'composio'),
        'held back': LAST_ERROR.empty('production', appSlug, name, ''),
        released: null,
      }[change];
      if (change === 'released') {
        await setStatus(account, 'expired');
        await reconcile(wf);
      }
      const parked = parkPointerRead(wf);
      try {
        const sent = http()
          .post('/api/hooks/composio')
          .set('Content-Type', 'application/json')
          .set('webhook-id', `msg_read_before_${change}`)
          .send({ metadata: { trigger_id: live.composio_trigger_instance_id }, data: { id: change } })
          .then((res) => res);
        await parked.reached;
        if (change === 'held') await setStatus(account, 'expired');
        if (change === 'released') await setStatus(account, 'active');
        if (change === 'held back') {
          await db.query(`DELETE FROM environment_connections WHERE environment_id = $1 AND app = $2`, [
            production,
            appSlug,
          ]);
        }
        await reconcile(wf);
        expect(await activation(wf, production)).toMatchObject({ last_error: written });
        if (change === 'released') {
          jest.spyOn(app.get(RuntimeCompiler), 'compile').mockImplementationOnce(() => {
            throw new Error('the version does not compile');
          });
        }

        parked.release();
        expect((await sent).status).toBe(202);
        expect(await activation(wf, production)).toMatchObject({
          last_error: change === 'released' ? 'the version does not compile' : written,
        });
      } finally {
        parked.restore();
      }
    },
  );

  it.each(['retyped to a schedule', 'deleted with its workflow'])(
    'a held webhook trigger %s asks nothing of its app with the account that is not active, and its webhook is deleted once that account is active again',
    async (removal) => {
      const { org, production, account, wf, live } = await liveTrigger('webhook', `removed ${removal}`);
      const hook = (
        (await storeOf(live.id))['webhook.registration'] as { registration: { subscriptionId: string } }
      ).registration.subscriptionId;
      await setStatus(account, 'expired');
      await reconcile(wf);
      expect(await activation(wf, production)).toMatchObject({ held: true });
      const deletes = stripeDeletes.length;

      if (removal === 'deleted with its workflow') {
        await asA(http().delete(`/api/workflows/${wf}`).set('X-Org-Id', org)).expect(200);
      } else {
        await publish(org, wf, triggerDoc('orchestr:schedule', 'Every hour', { interval_minutes: 60 }));
        expect(await activation(wf, production)).toMatchObject({
          trigger_type: 'orchestr:schedule',
          held: false,
        });
      }
      // A later reconcile retries the pending delete, and still asks nothing of the app.
      await reconcile(wf);
      await app.get(TriggerReconcilerService).retriesSettled();

      expect(stripeDeletes.length).toBe(deletes);
      expect(stripeEndpoints.has(hook)).toBe(true);
      expect(await pendingDeletes(wf)).toEqual([
        { hook, last_error: "the account it was registered with isn't active" },
      ]);

      await app.get(ConnectionsService).setStatus(account, 'active');
      await eventually(async () => expect(await pendingDeletes(wf)).toEqual([]));
      expect(stripeDeletes.slice(deletes)).toEqual([hook]);
      expect(stripeEndpoints.has(hook)).toBe(false);
    },
  );

  it.each(RAILS)(
    "a %s trigger held back or held follows its slot's state through every unfit state and an environment rename, standing nothing up",
    async (rail) => {
      const { app: appSlug, name, nodeType, props } = TRIGGERS[rail];
      const { org, production, staging } = await workspace(`restates ${rail}`);
      const account = await fitting(rail);
      await assignSlot(org, production, appSlug, account);
      await assignSlot(org, staging, appSlug, account);
      const { wf, v1 } = await deploy(org, triggerDoc(nodeType, name, props));
      await asA(
        http()
          .post(`/api/workflows/${wf}/promote`)
          .set('X-Org-Id', org)
          .send({ environment: 'staging', version_id: v1 }),
      ).expect(201);
      await reconcile(wf);
      const live = await activation(wf, staging);
      expect(live).toMatchObject({ connection_id: account, last_error: null });
      const calledUp = standUps();

      const heldSaying = async (words: string, listeningAs: string | null): Promise<void> => {
        await reconcile(wf);
        expect(await activation(wf, staging)).toMatchObject({
          id: live.id,
          connection_id: listeningAs,
          held: listeningAs !== null,
          composio_trigger_instance_id: listeningAs === null ? null : live.composio_trigger_instance_id,
          last_error: words,
        });
        expect(await shownOn(org, wf, staging)).toMatchObject({
          status: 'error',
          held_back_by_slot: true,
          listening: listeningAs !== null && rail !== 'polling',
          last_error: words,
        });
      };

      await setStatus(account, 'expired');
      await heldSaying(HELD('staging', rail), account);

      // A held webhook can't move to the new URL, so its environment keeps its name.
      const renamed = rail === 'webhook' ? 'staging' : 'preview';
      await asA(
        http().patch(`/api/environments/${staging}`).set('X-Org-Id', org).send({ name: 'preview' }),
      ).expect(rail === 'webhook' ? 409 : 200);
      await heldSaying(HELD(renamed, rail), account);

      await asA(http().delete(`/api/environments/${staging}/slots/${appSlug}`).set('X-Org-Id', org)).expect(
        200,
      );
      await heldSaying(LAST_ERROR.empty(renamed, appSlug, name, ''), null);

      const expired = await fitting(rail);
      await setStatus(expired, 'expired');
      await assignSlot(org, staging, appSlug, expired);
      await heldSaying(LAST_ERROR.inactive(renamed, appSlug, name, ''), null);

      await putSlot(staging, appSlug, await tokenConnection(otherApp(rail)));
      await heldSaying(LAST_ERROR.wrong_app(renamed, appSlug, name, otherApp(rail)), null);

      await asA(
        http().patch(`/api/environments/${staging}`).set('X-Org-Id', org).send({ name: 'qa' }),
      ).expect(200);
      await heldSaying(LAST_ERROR.wrong_app('qa', appSlug, name, otherApp(rail)), null);

      expect(standUps()).toBe(calledUp);
    },
  );

  it.each(RAILS)(
    'a live %s trigger whose slot is given an account of the wrong kind is torn down with the account it was stood up with, and stands up again once the slot serves it',
    async (rail) => {
      const { app: appSlug, name } = TRIGGERS[rail];
      const { org, production, account, wf, live } = await liveTrigger(rail, 'wrong kind');
      const store = await storeOf(live.id);
      const [calledUp, calledDown] = [standUps(), teardowns()];
      const refusal =
        rail === 'composio'
          ? NEEDS_MANAGED('production', appSlug, name)
          : NEEDS_OWN('production', appSlug, name);

      const wrongKind =
        rail === 'composio' ? await tokenConnection(appSlug) : await oneClickConnection(appSlug);
      await assignSlot(org, production, appSlug, wrongKind);
      await eventually(async () =>
        expect(await activation(wf, production)).toMatchObject({
          id: live.id,
          connection_id: null,
          held: false,
          composio_trigger_instance_id: null,
          last_error: refusal,
          materialized: { connection: null },
        }),
      );
      expect(await storeOf(live.id)).toEqual({});
      expect(standUps()).toBe(calledUp);
      expect(teardowns()).toBe(calledDown + (rail === 'polling' ? 0 : 1));
      if (rail === 'composio') {
        expect(unsubscribed.mock.calls.at(-1)?.[1]).toBe(live.composio_trigger_instance_id);
      }
      if (rail === 'webhook') {
        const hook = (store['webhook.registration'] as { registration: { subscriptionId: string } })
          .registration.subscriptionId;
        expect(stripeDeletes.at(-1)).toBe(hook);
        expect(await pendingDeletes(wf)).toEqual([]);
      }
      expect(await shownOn(org, wf, production)).toMatchObject({
        held_back_by_slot: true,
        listening: false,
        last_error: refusal,
      });

      await assignSlot(org, production, appSlug, account);
      await eventually(async () =>
        expect(await activation(wf, production)).toMatchObject({
          id: live.id,
          connection_id: account,
          last_error: null,
        }),
      );
      expect(await standUpsAs(rail, account)).toBe(2);
    },
  );

  it("renaming an environment is refused while a webhook registered there was registered with an account that isn't active, naming each, and moves them once it is active again", async () => {
    const { app: appSlug, name, nodeType, props } = TRIGGERS.webhook;
    const { org, staging } = await workspace('rename held');
    const account = await fitting('webhook');
    await db.query(`UPDATE connections SET display_name = 'Billing' WHERE id = $1`, [account]);
    await assignSlot(org, staging, appSlug, account);
    const promoted = async (label: string): Promise<{ wf: string; live: ActivationRow; hook: string }> => {
      const { wf, v1 } = await deploy(org, { ...triggerDoc(nodeType, name, props), name: label });
      await asA(
        http()
          .post(`/api/workflows/${wf}/promote`)
          .set('X-Org-Id', org)
          .send({ environment: 'staging', version_id: v1 }),
      ).expect(201);
      await reconcile(wf);
      const live = await activation(wf, staging);
      expect(live).toMatchObject({ connection_id: account, last_error: null });
      const record = (await storeOf(live.id))['webhook.registration'] as {
        webhookUrl: string;
        registration: { subscriptionId: string };
      };
      expect(record.webhookUrl).toMatch(new RegExp(`/api/hooks/${wf}/staging$`));
      return { wf, live, hook: record.registration.subscriptionId };
    };
    const billing = await promoted('Billing');
    const refunds = await promoted('Refunds');
    const code = await tokenConnection('github');
    await db.query(`UPDATE connections SET display_name = 'Code' WHERE id = $1`, [code]);
    await assignSlot(org, staging, 'github', code);
    const { wf: pushes, v1: pushesV1 } = await deploy(org, {
      ...triggerDoc('github.new_push', 'On push', { owner: 'acme', repo: 'rename' }),
      name: 'Pushes',
    });
    await asA(
      http()
        .post(`/api/workflows/${pushes}/promote`)
        .set('X-Org-Id', org)
        .send({ environment: 'staging', version_id: pushesV1 }),
    ).expect(201);
    await reconcile(pushes);
    expect(await activation(pushes, staging)).toMatchObject({ connection_id: code, last_error: null });
    const rename = (to: string): request.Test =>
      asA(http().patch(`/api/environments/${staging}`).set('X-Org-Id', org).send({ name: to }));
    const fix =
      'tests it under Integrations once it works again, or an owner reassigns the slot under Integrations → Environments';
    // Named as a promote's 428 names a trigger under `triggers`.
    const entry = (wf: string, workflowName: string): Record<string, unknown> => ({
      workflow_id: wf,
      workflow_name: workflowName,
      node_id: 'watch',
      node_name: name,
      app: 'stripe',
      connection_id: account,
      account_label: 'Billing',
    });
    const [calledUp, calledDown] = [standUps(), teardowns()];

    // Refused as soon as the accounts aren't active, before a reconcile has held any trigger.
    await setStatus(account, 'expired');
    await setStatus(code, 'expired');
    const three = await rename('qa').expect(409);
    expect(three.body).toMatchObject({
      detail: `Renaming 'staging' would leave 3 webhooks registered at their old URLs, which serve nothing, because the accounts they were registered with aren't active: "${name}" in "Billing" (stripe account Billing), "On push" in "Pushes" (github account Code), "${name}" in "Refunds" (stripe account Billing) — before renaming, each account's owner ${fix}`,
      held_webhooks: [
        entry(billing.wf, 'Billing'),
        {
          workflow_id: pushes,
          workflow_name: 'Pushes',
          node_id: 'watch',
          node_name: 'On push',
          app: 'github',
          connection_id: code,
          account_label: 'Code',
        },
        entry(refunds.wf, 'Refunds'),
      ],
    });
    expect(three.body).not.toHaveProperty('url_changes');

    // Two webhooks registered with one account name it once.
    await asA(http().delete(`/api/workflows/${pushes}`).set('X-Org-Id', org)).expect(200);
    const both = await rename('qa').expect(409);
    expect(both.body).toMatchObject({
      detail: `Renaming 'staging' would leave 2 webhooks registered at their old URLs, which serve nothing, because the stripe account they were registered with (Billing) isn't active: "${name}" in "Billing", "${name}" in "Refunds" — before renaming, its owner ${fix}`,
      held_webhooks: [entry(billing.wf, 'Billing'), entry(refunds.wf, 'Refunds')],
    });

    // A webhook taken down meanwhile waits for its delete apart from the environment, so it no longer stops a rename.
    await reconcile(billing.wf);
    expect(await activation(billing.wf, staging)).toMatchObject({ held: true });
    await asA(http().delete(`/api/workflows/${refunds.wf}`).set('X-Org-Id', org)).expect(200);
    expect(await pendingDeletes(refunds.wf)).toEqual([
      { hook: refunds.hook, last_error: "the account it was registered with isn't active" },
    ]);
    const one = await rename('qa').expect(409);
    expect(one.body).toMatchObject({
      detail: `Renaming 'staging' would leave "${name}" in "Billing" registered at its old URL, which serves nothing, because the stripe account it was registered with (Billing) isn't active — before renaming, its owner ${fix}`,
      held_webhooks: [entry(billing.wf, 'Billing')],
    });
    expect((await db.query(`SELECT name FROM environments WHERE id = $1`, [staging])).rows).toEqual([
      { name: 'staging' },
    ]);
    expect([standUps(), teardowns()]).toEqual([calledUp, calledDown]);
    expect(
      await deliver('webhook', billing.wf, billing.live, 'D_STILL_STAGING', 'customer.created', 'staging'),
    ).toMatchObject({
      fired: 1,
    });

    await app.get(ConnectionsService).setStatus(account, 'active');
    await eventually(async () => {
      expect(await activation(billing.wf, staging)).toMatchObject({ held: false, last_error: null });
      expect(await pendingDeletes(refunds.wf)).toEqual([]);
    });
    await rename('qa').expect(200);
    await reconcile(billing.wf);

    const moved = (await storeOf(billing.live.id))['webhook.registration'] as {
      webhookUrl: string;
      registration: { subscriptionId: string };
    };
    expect(moved.webhookUrl).toMatch(new RegExp(`/api/hooks/${billing.wf}/qa$`));
    expect(stripeEndpoints.has(billing.hook)).toBe(false);
    expect(stripeEndpoints.has(moved.registration.subscriptionId)).toBe(true);
    expect(await activation(billing.wf, staging)).toMatchObject({
      id: billing.live.id,
      held: false,
      last_error: null,
    });
    expect(
      await deliver(
        'webhook',
        billing.wf,
        await activation(billing.wf, staging),
        'D_MOVED',
        'customer.created',
        'qa',
      ),
    ).toMatchObject({ fired: 1 });
  });

  const POLLED = [
    { nodeType: 'slack.new_channel', app: 'slack', name: 'When a channel is created', other: 'github' },
    {
      nodeType: 'gmail.gmail_new_email_received',
      app: 'gmail',
      name: 'When new mail arrives',
      other: 'slack',
    },
  ] as const;

  it.each(
    POLLED.flatMap((trigger) =>
      FAULTS.map((fault): [string, Fault, (typeof POLLED)[number]] => [trigger.nodeType, fault, trigger]),
    ),
  )(
    "a %s trigger held back by a slot that is %s is never polled, so its last_error stays the rule's refusal",
    async (_type, fault, { nodeType, app: appSlug, name, other }) => {
      const { org, production } = await workspace(`never polled ${nodeType} ${fault}`);
      if (fault === 'inactive') {
        // The hand-polled Composio rail runs only on one-click accounts; the SDK poll on its own credentials.
        const held = appSlug === 'gmail' ? await oneClickConnection(appSlug) : await tokenConnection(appSlug);
        await setStatus(held, 'expired');
        await putSlot(production, appSlug, held);
      } else if (fault === 'wrong_app') {
        await putSlot(production, appSlug, await tokenConnection(other));
      }
      const refusal = LAST_ERROR[fault]('production', appSlug, name, other);
      const { wf } = await deploy(org, triggerDoc(nodeType, name, {}));
      const held = await activation(wf, production);
      expect(held).toMatchObject({ connection_id: null, last_error: refusal, last_polled_at: null });

      await poll();
      expect(await activation(wf, production)).toMatchObject({ last_error: refusal, last_polled_at: null });
      expect(await shownOn(org, wf, production)).toMatchObject({ status: 'error', last_error: refusal });

      // A row a poll overwrote before this release says why again at its next reconcile.
      await db.query(
        `UPDATE runtime_trigger_activations SET last_error = 'connect the app first' WHERE id = $1`,
        [held.id],
      );
      await reconcile(wf);
      expect(await activation(wf, production)).toMatchObject({ last_error: refusal, last_polled_at: null });
    },
  );

  it.each([
    ['slack.reaction_added', 'slack', 'On a reaction'],
    ['gmail.gmail_new_email_received', 'gmail', 'When new mail arrives'],
  ])(
    'a Composio %s trigger whose slot holds an own-credentials account is refused as a one-click-only step is, and held back in the same words',
    async (nodeType, appSlug, name) => {
      const { org, production, staging } = await workspace(`needs one-click ${nodeType}`);
      const own = await tokenConnection(appSlug);
      await putSlot(production, appSlug, own);
      await putSlot(staging, appSlug, own);
      const remind = {
        id: 'remind',
        name: 'Remind me',
        node_type: 'slack.create_a_reminder',
        type_version: 1,
        parameters: { text: 'Standup', time: 'in 5 minutes' },
        position: { x: 600, y: 0 },
        metadata: {},
      };
      const steps = appSlug === 'slack' ? [remind] : [];
      const before = standUps();
      const { wf, v1, created } = await deploy(org, triggerDoc(nodeType, name, {}, steps));
      const refusal = NEEDS_MANAGED('production', appSlug, name);
      expect(created).toMatchObject({ activated: false, activation_error: refusal });
      expect(await activation(wf, production)).toMatchObject({ connection_id: null, last_error: refusal });

      const refusedTrigger = {
        node_id: 'watch',
        node_name: name,
        app: appSlug,
        reason: 'needs_managed_slot',
      };
      const refusedSteps =
        steps.length > 0
          ? [{ node_id: 'remind', node_name: 'Remind me', app: 'slack', reason: 'needs_managed_slot' }]
          : [];
      const names = steps.length > 0 ? `"${name}" and "Remind me" run` : `"${name}" runs`;
      const promoted = await asA(
        http()
          .post(`/api/workflows/${wf}/promote`)
          .set('X-Org-Id', org)
          .send({ environment: 'staging', version_id: v1 }),
      ).expect(428);
      expect(promoted.body).toMatchObject({
        detail: `staging's ${appSlug} account uses its own credentials, and ${names} only on a one-click (managed) one, so ${
          steps.length > 0 ? 'they' : 'it'
        } can't run there — reassign it under Integrations → Environments before promoting here`,
        code: 'environment_slots_unfit',
        environment: 'staging',
        triggers: [refusedTrigger],
        steps: refusedSteps,
      });
      for (const door of ['publish', 'restore']) {
        const refused = await asA(
          http().post(`/api/workflows/${wf}/${door}`).set('X-Org-Id', org).send({ version_number: 1 }),
        ).expect(428);
        expect(refused.body).toMatchObject({ code: 'environment_slots_unfit', triggers: [refusedTrigger] });
      }

      await poll();
      expect(await activation(wf, production)).toMatchObject({ last_error: refusal, last_polled_at: null });
      expect(standUps()).toBe(before);

      const oneClick = await oneClickConnection(appSlug);
      await assignSlot(org, production, appSlug, oneClick);
      await reconcile(wf);
      expect(await activation(wf, production)).toMatchObject({ connection_id: oneClick, last_error: null });
    },
  );

  it.each(['polling', 'webhook'] as const)(
    'an SDK %s trigger whose slot holds a one-click account is refused as needing its own credentials, and held back in the same words',
    async (rail) => {
      const { app: appSlug, name, nodeType, props } = TRIGGERS[rail];
      const { org, production, staging } = await workspace(`needs own credentials ${rail}`);
      const oneClick = await oneClickConnection(appSlug);
      await putSlot(production, appSlug, oneClick);
      await putSlot(staging, appSlug, oneClick);
      const before = standUps();
      const { wf, v1, created } = await deploy(org, triggerDoc(nodeType, name, props));
      const refusal = NEEDS_OWN('production', appSlug, name);
      expect(created).toMatchObject({ activated: false, activation_error: refusal });
      expect(await activation(wf, production)).toMatchObject({ connection_id: null, last_error: refusal });
      expect(await shownOn(org, wf, production)).toMatchObject({
        held_back_by_slot: true,
        listening: false,
        last_error: refusal,
      });

      const refusedTrigger = {
        node_id: 'watch',
        node_name: name,
        app: appSlug,
        reason: 'needs_own_credentials_slot',
      };
      const promoted = await asA(
        http()
          .post(`/api/workflows/${wf}/promote`)
          .set('X-Org-Id', org)
          .send({ environment: 'staging', version_id: v1 }),
      ).expect(428);
      expect(promoted.body).toMatchObject({
        detail: `staging's ${appSlug} account is one-click (managed), and "${name}" runs only on one that uses its own credentials, so it can't run there — reassign it under Integrations → Environments before promoting here`,
        code: 'environment_slots_unfit',
        environment: 'staging',
        triggers: [refusedTrigger],
        steps: [],
      });
      for (const door of ['publish', 'restore']) {
        const refused = await asA(
          http().post(`/api/workflows/${wf}/${door}`).set('X-Org-Id', org).send({ version_number: 1 }),
        ).expect(428);
        expect(refused.body).toMatchObject({ code: 'environment_slots_unfit', triggers: [refusedTrigger] });
      }
      expect(standUps()).toBe(before);

      const own = await tokenConnection(appSlug);
      await assignSlot(org, production, appSlug, own);
      await reconcile(wf);
      expect(await activation(wf, production)).toMatchObject({ connection_id: own, last_error: null });
      expect(await standUpsAs(rail, own)).toBe(1);
    },
  );

  it('holds back no trigger for a slot the preflight asks no slot for: one whose type names no app', async () => {
    const { org, staging } = await workspace('names no app');
    const { wf, v1 } = await deploy(org, triggerDoc('Acme.new_deal', 'Nameless', {}));
    await asA(
      http()
        .post(`/api/workflows/${wf}/promote`)
        .set('X-Org-Id', org)
        .send({ environment: 'staging', version_id: v1 }),
    ).expect(201);
    const subscribes = subscribed.mock.calls.length;
    await reconcile(wf);

    expect(await activation(wf, staging)).toMatchObject({
      connection_id: null,
      last_error: 'The trigger type "Acme.new_deal" names no app, so no environment\'s account can serve it',
      materialized: null,
    });
    expect(subscribed.mock.calls.length).toBe(subscribes);
  });

  it('promotes a trigger that signs in to nothing, and a native one, with no slot at all, and stands the poll up without an account', async () => {
    const { org, staging } = await workspace('needs no slot');
    for (const [nodeType, props] of [
      ['http.new_item', { url: 'http://127.0.0.1/items' }],
      ['orchestr:schedule', { interval_minutes: 60 }],
    ] as const) {
      const { wf, v1 } = await deploy(org, triggerDoc(nodeType, 'Listens as nobody', props));
      await asA(
        http()
          .post(`/api/workflows/${wf}/promote`)
          .set('X-Org-Id', org)
          .send({ environment: 'staging', version_id: v1 }),
      ).expect(201);
      await reconcile(wf);
      expect(await activation(wf, staging)).toMatchObject({ connection_id: null, last_error: null });
    }
  });

  describe('a change to an account reconciles the triggers listening as it, unasked', () => {
    // A token account is renewed by its health check; a one-click one by Composio's answer to it.
    const reconnect = async (account: string): Promise<void> => {
      const checked = await asA(http().post(`/api/connections/${account}/test`)).expect(200);
      expect(checked.body).toMatchObject({ ok: true, status: 'active' });
    };

    it.each(RAILS)(
      'a live %s trigger is held when its account stops being active, and resumes when it is reconnected',
      async (rail) => {
        const { production, account, wf, live } = await liveTrigger(rail, 'status held');
        const calledUp = standUps();

        await app.get(ConnectionsService).setStatus(account, 'expired', 'Access has expired');
        await eventually(async () =>
          expect(await activation(wf, production)).toMatchObject({
            held: true,
            connection_id: account,
            last_error: HELD('production', rail),
          }),
        );

        await reconnect(account);
        await eventually(async () =>
          expect(await activation(wf, production)).toMatchObject({
            id: live.id,
            held: false,
            connection_id: account,
            last_error: null,
          }),
        );
        expect(standUps()).toBe(calledUp);
      },
    );

    it.each(RAILS)(
      'a %s trigger held back by an account that is not active stands up when that account is reconnected',
      async (rail) => {
        const { app: appSlug, name, nodeType, props } = TRIGGERS[rail];
        const { org, production } = await workspace(`status stands up ${rail}`);
        const account = await breakSlot(rail, 'inactive', [production]);
        const { wf } = await deploy(org, triggerDoc(nodeType, name, props));
        expect(await activation(wf, production)).toMatchObject({
          connection_id: null,
          last_error: LAST_ERROR.inactive('production', appSlug, name, ''),
        });

        await reconnect(account!);
        await eventually(async () =>
          expect(await activation(wf, production)).toMatchObject({
            connection_id: account,
            last_error: null,
          }),
        );
        expect(await standUpsAs(rail, account)).toBe(1);
      },
    );

    it.each(RAILS)(
      'deleting the account a live %s trigger listens as tears it down and says its slot is empty',
      async (rail) => {
        const { app: appSlug, name } = TRIGGERS[rail];
        const { production, account, wf } = await liveTrigger(rail, 'deleted');

        await asA(http().delete(`/api/connections/${account}?force=true`)).expect(200);
        await eventually(async () =>
          expect(await activation(wf, production)).toMatchObject({
            connection_id: null,
            held: false,
            composio_trigger_instance_id: null,
            last_error: LAST_ERROR.empty('production', appSlug, name, ''),
          }),
        );
      },
    );

    it('replacing or deleting the org cluster account a live trigger listens as tears it down and says its slot is empty', async () => {
      const { app: appSlug, name, nodeType, props } = TRIGGERS.composio;
      const { org, production } = await workspace('cluster account');
      const composio = app.get(ComposioProvider);
      jest.spyOn(composio, 'listManagedToolkits').mockResolvedValue([{ slug: appSlug, name: 'Acme CRM' }]);
      jest.spyOn(composio, 'ensureAuthConfig').mockResolvedValue('ac_slotfit');
      jest.spyOn(composio, 'createLink').mockImplementation(() =>
        Promise.resolve({
          redirectUrl: 'https://connect.invalid/link',
          connectedAccountId: `ca_${randomUUID()}`,
        }),
      );
      const connect = async (): Promise<string> => {
        const linked = await asA(
          http()
            .post(`/api/orgs/${org}/clusters/production/connect`)
            .set('X-Org-Id', org)
            .send({ app: appSlug }),
        ).expect(201);
        const id = linked.body.connection_id as string;
        await app.get(ConnectionsService).setStatus(id, 'active');
        return id;
      };
      const listening = (as: string | null): Promise<void> =>
        eventually(async () =>
          expect(await activation(wf, production)).toMatchObject({
            connection_id: as,
            last_error: as === null ? LAST_ERROR.empty('production', appSlug, name, '') : null,
          }),
        );

      const first = await connect();
      await assignSlot(org, production, appSlug, first);
      const { wf } = await deploy(org, triggerDoc(nodeType, name, props));
      await listening(first);

      const second = await connect();
      await listening(null);

      await assignSlot(org, production, appSlug, second);
      await listening(second);
      await asA(http().delete(`/api/orgs/${org}/clusters/connections/${second}`).set('X-Org-Id', org)).expect(
        200,
      );
      await listening(null);
    });

    it('of two changes to an account made at once, the later one reconciles its triggers by the status the earlier one wrote', async () => {
      const { production, account, wf, live } = await liveTrigger('polling', 'two changes');
      const earlier = new Client({ connectionString: process.env.DATABASE_URL });
      const behind = new Client({ connectionString: process.env.DATABASE_URL });
      await earlier.connect();
      await behind.connect();
      try {
        // The earlier change's write, uncommitted, and a lock queued behind it, so the later change still waits once it commits.
        await earlier.query('BEGIN');
        await earlier.query(`UPDATE connections SET status = 'expired' WHERE id = $1`, [account]);
        await behind.query('BEGIN');
        const queued = behind.query(`SELECT 1 FROM connections WHERE id = $1 FOR UPDATE`, [account]);
        await lockWaiters(1, 'connections');
        const later = app.get(ConnectionsService).setStatus(account, 'active');
        await lockWaiters(2, 'connections');
        await earlier.query('COMMIT');
        await queued;

        // The earlier change, written in SQL, asks for no reconcile, so the test runs the one a status change asks for, which holds the trigger.
        await reconcile(wf);
        expect(await activation(wf, production)).toMatchObject({
          held: true,
          last_error: HELD('production', 'polling'),
        });

        await behind.query('COMMIT');
        await later;
        await eventually(async () =>
          expect(await activation(wf, production)).toMatchObject({
            id: live.id,
            held: false,
            connection_id: account,
            last_error: null,
          }),
        );
      } finally {
        await earlier.end();
        await behind.end();
      }
    });

    it('an account that flaps while its trigger is reconciled queues one more reconcile of it, not one per change', async () => {
      const { production, account, wf, live } = await liveTrigger('polling', 'flaps');
      const parked = parkReconciles();
      try {
        for (const status of [
          'expired',
          'active',
          'expired',
          'active',
          'expired',
          'active',
          'expired',
        ] as const) {
          await app.get(ConnectionsService).setStatus(account, status);
        }
        await eventually(() => Promise.resolve(expect(parked.started(wf)).toBeGreaterThan(0)));
        expect(parked.started(wf)).toBe(1);

        parked.release();
        await eventually(async () => {
          expect(parked.started(wf)).toBe(2);
          expect(await activation(wf, production)).toMatchObject({
            id: live.id,
            held: true,
            last_error: HELD('production', 'polling'),
          });
        });
      } finally {
        parked.restore();
      }
    });

    it.each(['a health check', 'a delivery its intake verifies'])(
      'a live webhook held by an OAuth account is released when %s renews the account’s token',
      async (renewal) => {
        let grants = 0;
        const tokens = createServer((req, res) => {
          req.resume();
          req.on('end', () => {
            grants += 1;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ access_token: `renewed-${grants}`, token_type: 'Bearer', expires_in: 3600 }),
            );
          });
        });
        await new Promise<void>((resolve) => tokens.listen(0, '127.0.0.1', resolve));
        try {
          const { app: appSlug, name, nodeType, props } = TRIGGERS.webhook;
          const { org, production } = await workspace(`renewed by ${renewal}`);
          const account = await oauthConnection(
            appSlug,
            `http://127.0.0.1:${(tokens.address() as AddressInfo).port}/token`,
          );
          await assignSlot(org, production, appSlug, account);
          const { wf } = await deploy(org, triggerDoc(nodeType, name, props));
          const live = await activation(wf, production);
          expect(live).toMatchObject({ connection_id: account, last_error: null });

          await app.get(ConnectionsService).setStatus(account, 'expired', 'Access has expired');
          await eventually(async () =>
            expect(await activation(wf, production)).toMatchObject({
              held: true,
              last_error: HELD('production', 'webhook'),
            }),
          );
          const calledUp = standUps();

          if (renewal === 'a health check') {
            const checked = await asA(http().post(`/api/connections/${account}/test`)).expect(200);
            expect(checked.body).toMatchObject({
              ok: true,
              status: 'active',
              detail: 'Access was renewed with the provider.',
            });
          } else {
            const expired = app.get(EncryptionService).encryptToken(JSON.stringify(oauthToken(-60_000)));
            await db.query(`UPDATE connections SET credential = $2 WHERE id = $1`, [account, expired]);
            expect(await deliver('webhook', wf, live, 'D_RENEWS')).toMatchObject({ fired: 1 });
          }
          expect(grants).toBe(1);
          await eventually(async () =>
            expect(await activation(wf, production)).toMatchObject({
              id: live.id,
              held: false,
              connection_id: account,
              last_error: null,
            }),
          );
          expect(standUps()).toBe(calledUp);
        } finally {
          await new Promise<void>((resolve) => tokens.close(() => resolve()));
        }
      },
    );
  });
});

describe('a change to an account reconciles the triggers listening as it through the pg-boss queue (e2e, isolated DB, pg-boss on)', () => {
  beforeAll(() => boot(true), 60_000);
  afterAll(shutdown, 60_000);

  const queued = async (): Promise<number> =>
    Number(
      (await db.query<{ n: string }>(`SELECT count(*) AS n FROM pgboss.job WHERE name = 'trigger-reconcile'`))
        .rows[0]!.n,
    );

  it.each(['composio', 'polling'] as const)(
    'a live %s trigger is held and resumed by the queued reconciles its account changes ask for',
    async (rail) => {
      const { production, account, wf, live } = await liveTrigger(rail, 'queued');
      const jobs = await queued();

      if (rail === 'composio') accountStatus.mockResolvedValueOnce('expired');
      const checked = await asA(http().post(`/api/connections/${account}/test`)).expect(200);
      if (rail === 'polling') {
        expect(checked.body).toMatchObject({ ok: true });
        await app.get(ConnectionsService).setStatus(account, 'expired', 'Access has expired');
      }
      await eventually(
        async () =>
          expect(await activation(wf, production)).toMatchObject({
            id: live.id,
            held: true,
            last_error: HELD('production', rail),
          }),
        20_000,
      );

      await asA(http().post(`/api/connections/${account}/test`)).expect(200);
      await eventually(
        async () =>
          expect(await activation(wf, production)).toMatchObject({
            id: live.id,
            held: false,
            last_error: null,
          }),
        20_000,
      );
      expect(await queued()).toBeGreaterThanOrEqual(jobs + 2);
      expect(await standUpsAs(rail, account)).toBe(1);
    },
    60_000,
  );

  it('an account that flaps while its triggers are reconciled leaves one job waiting for each of them, not one per change', async () => {
    const { name, nodeType, props } = TRIGGERS.polling;
    const { org, production, account, wf } = await liveTrigger('polling', 'flaps queued');
    const { wf: other } = await deploy(org, { ...triggerDoc(nodeType, name, props), name: 'listens too' });
    expect(await activation(other, production)).toMatchObject({ connection_id: account, last_error: null });
    const workflows = [wf, other];
    const parked = parkReconciles();
    const waiting = async (wfId: string): Promise<number> =>
      Number(
        (
          await db.query<{ n: string }>(
            `SELECT count(*) AS n FROM pgboss.job
              WHERE name = 'trigger-reconcile' AND state = 'created' AND data ->> 'workflowId' = $1`,
            [wfId],
          )
        ).rows[0]!.n,
      );
    try {
      const connections = app.get(ConnectionsService);
      await connections.setStatus(account, 'expired');
      // The worker takes one workflow's job and parks on it, so every later change finds the other's still waiting.
      await eventually(
        () => Promise.resolve(expect(workflows.map((id) => parked.started(id)).sort()).toEqual([0, 1])),
        20_000,
      );
      const [first, second] = parked.started(wf) === 1 ? [wf, other] : [other, wf];
      for (const status of ['active', 'expired', 'active', 'expired', 'active', 'expired'] as const) {
        await connections.setStatus(account, status);
      }
      expect([await waiting(first), await waiting(second)]).toEqual([1, 1]);

      parked.release();
      await eventually(async () => {
        expect([parked.started(first), parked.started(second)]).toEqual([2, 1]);
        expect([await waiting(first), await waiting(second)]).toEqual([0, 0]);
        for (const id of workflows) {
          expect(await activation(id, production)).toMatchObject({
            held: true,
            last_error: HELD('production', 'polling'),
          });
        }
      }, 20_000);
    } finally {
      parked.restore();
    }
  }, 60_000);
});
