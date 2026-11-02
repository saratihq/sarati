import { createHmac, randomUUID } from 'node:crypto';

import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { EncryptionService } from '../src/common/crypto/encryption.service';
import { ConnectionsService } from '../src/connections/connections.service';
import { seedDefaultEnvironments } from '../src/environments/default-environments';
import { utcMonthOf } from '../src/platform/composio-usage.service';
import { PlatformKeysService } from '../src/platform/platform-keys.service';
import { ActionRouterProvider } from '../src/providers/action-router.provider';
import { InMemoryStore } from '../src/providers/provider-store';
import { composioToolFor } from '../src/providers/sdk-actions.registry';
import { ScriptedAgentModel } from '../src/runtime/agent.testkit';
import { AGENT_MODEL_CALL } from '../src/runtime/agent';
import { RunsService } from '../src/runs/runs.service';
import type { RunPlan } from '../src/runtime/run-plan';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { TriggersService } from '../src/triggers/triggers.service';
import { insertApiKey } from './support/api-keys';
import { type ComposioFixture, startComposioFixture } from './support/composio-fixture';
import { listenOnLoopback } from './support/listen';
import { lockProbes } from './support/lock-probes';
import { insertPersonalOrgs } from './support/personal-org';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const INSTANCE_KEY = 'ik_instance_e2e_key';
const INSTANCE_SECRET = 'whsec_instance_e2e_secret';
const TRELLO = composioToolFor('trello.add_boards')!.slug;
const HAND_POLLED_GMAIL = 'gmail.gmail_new_email_received';
const SUBSCRIBED_GMAIL = 'gmail.gmail_new_gmail_message';
const HAND_POLL_NOT_SERVED = `Use "New Gmail Message Received Trigger" (${SUBSCRIBED_GMAIL}) instead: this instance doesn't run "New Email" (${HAND_POLLED_GMAIL}), which would spend one of the account owner's monthly app actions on every poll, whether or not anything arrived. Composio checks the app for the one to use, and each event it delivers counts as a trigger event, not an app action`;
/** How much of a status the overview's trigger card shows before it cuts it short. */
const CARD_SHOWS = 119;
const THIS_MONTH = utcMonthOf('now()');
const INSTANCE_ENV = [
  'INSTANCE_COMPOSIO_API_KEY',
  'INSTANCE_COMPOSIO_WEBHOOK_SECRET',
  'INSTANCE_COMPOSIO_MONTHLY_ACTIONS_PER_PERSON',
];

interface Person {
  id: string;
  personal: string;
  name: string;
  /** The person's API key for each org they act in, since a key acts only in its own (constitution row 24). */
  keys: Map<string, string>;
}

const person = (name: string): Person => ({
  id: randomUUID(),
  personal: randomUUID(),
  name,
  keys: new Map(),
});

/** The first day of next UTC month as an instant, read off the database's clock. */
async function nextMonthStart(db: Client): Promise<string> {
  const { rows } = await db.query<{ at: string }>(
    `SELECT to_char(${THIS_MONTH} + interval '1 month', 'YYYY-MM-DD') AS at`,
  );
  return `${rows[0]!.at}T00:00:00.000Z`;
}

/** Boots the real app on its own database against the fixture, with `env` set only for the boot. */
async function boot(
  env: Record<string, string>,
  fixture: ComposioFixture,
  model: ScriptedAgentModel = new ScriptedAgentModel([{ text: 'done', toolCalls: [] }]),
): Promise<{ app: INestApplication; db: Client }> {
  const url = await createE2eDatabase(ADMIN_URL);
  const db = new Client({ connectionString: url });
  await db.connect();
  Object.assign(process.env, {
    DATABASE_URL: url,
    PGBOSS_ENABLED: 'false',
    MOCK_AUTH: 'false',
    CLERK_ISSUER: '',
    THROTTLE_LIMIT: '10000',
    COMPOSIO_BASE_URL: fixture.origin,
    ...env,
  });
  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AGENT_MODEL_CALL)
      .useValue(model)
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }),
      })
      .compile();
    const app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    return { app, db };
  } finally {
    for (const name of INSTANCE_ENV) delete process.env[name];
  }
}

async function seedPeople(
  db: Client,
  people: Person[],
  shared: { id: string; owner: Person; member: Person },
) {
  for (const p of people) {
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, $2, $2, now(), now())`,
      [p.id, `${p.id}@e2e.local`],
    );
  }
  await insertPersonalOrgs(db, ...people.map((p) => ({ id: p.personal, userId: p.id, name: p.id })));
  await db.query(
    `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Shared', false, now(), now())`,
    [shared.id],
  );
  await db.query(
    `INSERT INTO org_members (id, org_id, user_id, role, created_at)
     VALUES (gen_random_uuid(), $1, $2, 'owner', now()), (gen_random_uuid(), $1, $3, 'member', now())`,
    [shared.id, shared.owner.id, shared.member.id],
  );
  await seedDefaultEnvironments(db, shared.id);
  for (const p of people) p.keys.set(p.personal, await insertApiKey(db, p.id, p.personal, { name: p.name }));
  for (const p of [shared.owner, shared.member]) {
    p.keys.set(shared.id, await insertApiKey(db, p.id, shared.id, { name: p.name }));
  }
}

function harness(boot: () => { app: INestApplication; db: Client }) {
  const http = (): ReturnType<typeof request> => request(boot().app.getHttpServer());
  const as = (p: Person, r: request.Test, org = p.personal): request.Test => {
    const key = p.keys.get(org);
    if (!key) throw new Error(`${p.name} has no key for org ${org}`);
    return r.set('Authorization', `Bearer ${key}`).set('X-Org-Id', org);
  };
  const plan = (actionId: string, props: Record<string, unknown>, connectionId?: string): RunPlan => ({
    id: `step-${randomUUID()}`,
    nodes: [
      {
        kind: 'action',
        id: 'step',
        name: 'Step',
        actionId,
        props,
        ...(connectionId ? { auth: { connectionId } } : {}),
      },
    ],
  });
  const runStep = (p: Person, actionId: string, props: Record<string, unknown>, connectionId: string) =>
    as(p, http().post('/api/runs')).send({ plan: plan(actionId, props, connectionId) });
  const connect = async (p: Person, app: string): Promise<{ id: string; account: string }> => {
    const link = await as(p, http().post('/api/connections/managed/link')).send({ app }).expect(201);
    const id = link.body.connection_id as string;
    await as(p, http().get(`/api/connections/${id}/status`)).expect(200, { status: 'active' });
    const ref = await boot().app.get(ConnectionsService).managedRef(p.id, id);
    return { id, account: ref!.connectedAccountId! };
  };
  const usage = async (p: Person): Promise<{ actions: number; trigger_events: number } | null> => {
    const { rows } = await boot().db.query<{ actions: number; trigger_events: number }>(
      `SELECT actions, trigger_events FROM composio_usage WHERE user_id = $1 AND month = ${THIS_MONTH}`,
      [p.id],
    );
    return rows[0] ?? null;
  };
  const scopedKey = async (p: Person, scopes: string[]): Promise<Person> => ({
    ...p,
    keys: new Map([
      [p.personal, await insertApiKey(boot().db, p.id, p.personal, { scopes, name: 'scoped' })],
    ]),
  });
  const productionOf = async (org: string): Promise<string> =>
    (
      await boot().db.query<{ id: string }>(`SELECT id FROM environments WHERE org_id = $1 AND is_prod`, [
        org,
      ])
    ).rows[0]!.id;
  const triggerCatalog = async (p: Person): Promise<Array<{ type: string; name: string }>> =>
    (await as(p, http().get('/api/triggers/catalog')).expect(200)).body.triggers as Array<{
      type: string;
      name: string;
    }>;
  const triggerTypes = async (p: Person): Promise<string[]> => (await triggerCatalog(p)).map((t) => t.type);
  const pollGmail = (p: Person, connectionId: string): Promise<unknown> =>
    boot().app.get(ActionRouterProvider).pollTrigger({
      externalUserId: p.id,
      triggerId: HAND_POLLED_GMAIL,
      props: {},
      auth: { connectionId },
      store: new InMemoryStore(),
    });
  const deliver = (body: Record<string, unknown>, secret: string, id = `msg_${randomUUID()}`) => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = 'v1,' + createHmac('sha256', secret).update(`${id}.${ts}.${raw}`).digest('base64');
    return http()
      .post('/api/hooks/composio')
      .set('Content-Type', 'application/json')
      .set('webhook-id', id)
      .set('webhook-timestamp', ts)
      .set('webhook-signature', signature)
      .send(raw);
  };
  const setActions = (p: Person, actions: number) =>
    boot().db.query(
      `INSERT INTO composio_usage (user_id, month, actions) VALUES ($1, ${THIS_MONTH}, $2)
       ON CONFLICT (user_id, month) DO UPDATE SET actions = EXCLUDED.actions`,
      [p.id, actions],
    );
  const deliveryDoc = (triggerId: string, nodeType = 'github.github_commit_event') => ({
    version: '1.0',
    name: `instance trigger ${triggerId}`,
    description: '',
    nodes: [
      {
        id: triggerId,
        name: 'On an event',
        node_type: nodeType,
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: { trigger: true },
      },
      {
        id: 'say',
        name: 'Say',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['fired'], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
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
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  });
  const bound = async (p: Person, org: string, instance: string, connection: { id: string }) => {
    const deployed = await as(p, http().post('/api/deploy'), org)
      .send({ workflow_json: deliveryDoc(`t-${randomUUID().slice(0, 8)}`) })
      .expect(201);
    const workflowId = deployed.body.workflow_id as string;
    const res = await boot().db.query(
      `UPDATE runtime_trigger_activations
          SET composio_trigger_instance_id = $2, connection_id = $3, connection_owner_user_id = $4
        WHERE workflow_id = $1 AND kind = 'composio_subscription'`,
      [workflowId, instance, connection.id, p.id],
    );
    expect(res.rowCount).toBe(1);
    return workflowId;
  };
  return {
    http,
    as,
    plan,
    runStep,
    connect,
    usage,
    setActions,
    bound,
    deliveryDoc,
    scopedKey,
    productionOf,
    triggerCatalog,
    triggerTypes,
    pollGmail,
    deliver,
  };
}

describe('an instance with its own Composio account (e2e, isolated DB, loopback Composio)', () => {
  let fixture: ComposioFixture;
  let app: INestApplication;
  let db: Client;
  const a = person('a');
  const b = person('b');
  const shared = { id: randomUUID(), owner: a, member: b };
  const {
    http,
    as,
    plan,
    runStep,
    connect,
    usage,
    setActions,
    bound,
    deliveryDoc,
    scopedKey,
    productionOf,
    triggerCatalog,
    pollGmail,
    deliver,
  } = harness(() => ({ app, db }));
  const conn: Record<string, { id: string; account: string }> = {};

  const limitMessage = (resetsOn: string): string =>
    `The monthly limit of 500 app actions per person on this instance is used up for the account this runs as — it resets on ${resetsOn} (UTC)`;
  let resetsOn = '';
  let resetsAt = '';

  const agent = new ScriptedAgentModel([
    { text: 'making it', toolCalls: [{ id: 'c1', name: 'make_board', input: { name: 'From the agent' } }] },
    { text: 'done', toolCalls: [] },
  ]);

  beforeAll(async () => {
    fixture = await startComposioFixture();
    ({ app, db } = await boot(
      { INSTANCE_COMPOSIO_API_KEY: INSTANCE_KEY, INSTANCE_COMPOSIO_WEBHOOK_SECRET: INSTANCE_SECRET },
      fixture,
      agent,
    ));
    await seedPeople(db, [a, b], shared);
    // A stored a key and secret of their own before this instance provided one; both must go unused.
    const encryption = app.get(EncryptionService);
    await db.query(
      `INSERT INTO platform_secrets (name, user_id, secret) VALUES ('composio_api_key', $1, $2), ('composio_webhook_secret', $1, $3)`,
      [a.id, encryption.encryptToken('ak_stored_A'), encryption.encryptToken('whsec_stored_A')],
    );
    resetsAt = await nextMonthStart(db);
    const date = new Date(resetsAt);
    resetsOn = `${date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    await fixture.close();
    process.env.DATABASE_URL = ADMIN_URL;
    delete process.env.COMPOSIO_BASE_URL;
  });

  it('Settings show the Composio keys as the instance’s and refuse to change them for anyone, while the Anthropic key stays each person’s', async () => {
    const seen = await as(a, http().get('/api/platform-keys')).expect(200);
    expect(seen.body).toEqual({
      keys: {
        composio_api_key: { present: true, updated_at: null, managed_by_instance: true },
        composio_webhook_secret: { present: true, updated_at: null, managed_by_instance: true },
        anthropic_api_key: { present: false, updated_at: null, managed_by_instance: false },
      },
      scope: 'user',
      can_manage: true,
      composio_usage: { actions_used: 0, actions_limit: 500, trigger_events: 0, resets_at: resetsAt },
    });

    const refusals: Array<[Person, string]> = [
      [a, a.personal],
      [a, shared.id],
      [b, shared.id],
    ];
    for (const [who, org] of refusals) {
      for (const name of ['composio_api_key', 'composio_webhook_secret']) {
        const put = await as(who, http().put(`/api/platform-keys/${name}`), org)
          .send({ value: 'mine' })
          .expect(409);
        expect(put.body).toMatchObject({ code: 'provided_by_instance' });
        await as(who, http().delete(`/api/platform-keys/${name}`), org).expect(409);
      }
    }
    const stored = await db.query(`SELECT name, user_id, org_id FROM platform_secrets ORDER BY name`);
    expect(stored.rows).toEqual([
      { name: 'composio_api_key', user_id: a.id, org_id: null },
      { name: 'composio_webhook_secret', user_id: a.id, org_id: null },
    ]);

    await as(a, http().put('/api/platform-keys/anthropic_api_key')).send({ value: 'sk-ant-a' }).expect(200);
    const keys = app.get(PlatformKeysService);
    await expect(keys.anthropicApiKey({ kind: 'user', userId: a.id })).resolves.toBe('sk-ant-a');
    await expect(keys.anthropicApiKey({ kind: 'user', userId: b.id })).resolves.toBeNull();
    const bSees = await as(b, http().get('/api/platform-keys')).expect(200);
    expect(bSees.body.keys.anthropic_api_key.present).toBe(false);
    await as(a, http().delete('/api/platform-keys/anthropic_api_key')).expect(200);
  });

  it('each person connects through the instance’s key as their own Composio user, and the identity probe a connect runs is charged to them', async () => {
    for (const app of ['trello', 'zendesk', 'slack', 'gmail']) conn[`a.${app}`] = await connect(a, app);
    for (const app of ['trello', 'zendesk']) conn[`b.${app}`] = await connect(b, app);

    expect(new Set(fixture.arrivals.map((x) => x.key))).toEqual(new Set([INSTANCE_KEY]));
    const links = fixture.arrivals.filter((x) => x.call === 'POST /api/v3/connected_accounts/link');
    expect(links.map((x) => x.body.user_id)).toEqual([a.id, a.id, a.id, a.id, b.id, b.id]);
    expect(new Set(Object.values(conn).map((c) => c.account)).size).toBe(6);

    // Slack and Gmail are asked who they are on connect: two typed tools, charged to A, nothing to B.
    expect(fixture.executions().map((x) => [x.call, x.body.user_id])).toEqual([
      ['POST /api/v3/tools/execute/SLACK_FETCH_TEAM_INFO', a.id],
      ['POST /api/v3/tools/execute/GMAIL_GET_PROFILE', a.id],
    ]);
    expect(await usage(a)).toEqual({ actions: 2, trigger_events: 0 });
    expect(await usage(b)).toBeNull();
  });

  it('a typed step runs through the instance’s key as its owner, charged once before it is sent', async () => {
    const before = fixture.executions().length;
    const run = await runStep(a, 'trello.add_boards', { name: 'Roadmap' }, conn['a.trello']!.id).expect(201);
    expect(run.body.outputs.step).toEqual({ via: TRELLO });
    const sent = fixture.executions().slice(before);
    expect(sent.map((x) => ({ call: x.call, key: x.key, body: x.body }))).toEqual([
      {
        call: `POST /api/v3/tools/execute/${TRELLO}`,
        key: INSTANCE_KEY,
        body: expect.objectContaining({ connected_account_id: conn['a.trello']!.account, user_id: a.id }),
      },
    ]);
    expect(await usage(a)).toEqual({ actions: 3, trigger_events: 0 });
  });

  it('a step on the proxy is charged per request it sends — a two-page listing is two', async () => {
    const before = fixture.executions().length;
    const run = await runStep(a, 'zendesk.list_tickets', { subdomain: 'acme' }, conn['a.zendesk']!.id).expect(
      201,
    );
    expect(run.body.outputs.step).toEqual({ tickets: [{ id: 7 }, { id: 8 }], count: 2 });
    const sent = fixture.executions().slice(before);
    expect(sent.map((x) => [x.call, x.key, x.body.connected_account_id])).toEqual([
      ['POST /api/v3/tools/execute/proxy', INSTANCE_KEY, conn['a.zendesk']!.account],
      ['POST /api/v3/tools/execute/proxy', INSTANCE_KEY, conn['a.zendesk']!.account],
    ]);
    expect(await usage(a)).toEqual({ actions: 5, trigger_events: 0 });
  });

  it('an AI Agent’s tool call is an app action of the account it runs as, charged once', async () => {
    const node = (id: string, node_type: string, parameters: Record<string, unknown> = {}) => ({
      id,
      name: id,
      node_type,
      type_version: 1,
      parameters,
      position: { x: 0, y: 0 },
      metadata: {},
    });
    const edge = (id: string, from: string, to: string, port_type: string) => ({
      id,
      source_node_id: from,
      source_port: 0,
      target_node_id: to,
      target_port: 0,
      port_type,
    });
    const doc = {
      version: '1.0',
      name: 'agent on the instance account',
      description: '',
      nodes: [
        node('hook', 'orchestr:webhook'),
        node('agent', 'orchestr:agent', {
          model: { provider: 'claude', model: 'claude-opus-4-8' },
          max_steps: 3,
          input: 'make a board',
        }),
        node('board', 'trello.add_boards', { tool_name: 'make_board' }),
      ],
      edges: [edge('e-in', 'hook', 'agent', 'main'), edge('e-tool', 'agent', 'board', 'tool')],
      settings: { execution_order: 'v1', extra: {} },
      metadata: { engine: 'orchestr' },
    };
    const before = fixture.executions().length;
    const used = (await usage(a))!.actions;
    const res = await as(a, http().post('/api/runs/test-agent'))
      .send({ workflow_ir: doc, node_id: 'agent', input: 'make a board' })
      .expect(201);
    expect(res.body.outputs.agent.text).toBe('done');
    expect(
      fixture
        .executions()
        .slice(before)
        .map((x) => [x.call, x.key, x.body.user_id]),
    ).toEqual([[`POST /api/v3/tools/execute/${TRELLO}`, INSTANCE_KEY, a.id]]);
    expect(await usage(a)).toMatchObject({ actions: used + 1 });
  });

  it('the 501st app action of a month is refused, naming the limit and the reset, on either rail, and sends nothing — while the other person runs on', async () => {
    await setActions(a, 499);
    await runStep(a, 'trello.add_boards', { name: 'Five hundredth' }, conn['a.trello']!.id).expect(201);
    expect(await usage(a)).toMatchObject({ actions: 500 });

    const before = fixture.executions().length;
    const typed = await runStep(
      a,
      'trello.add_boards',
      { name: 'One too many' },
      conn['a.trello']!.id,
    ).expect(429);
    expect(typed.body).toMatchObject({
      detail: limitMessage(resetsOn),
      code: 'composio_monthly_limit',
      limit: 500,
      resets_at: resetsAt,
    });
    const proxied = await runStep(
      a,
      'zendesk.list_tickets',
      { subdomain: 'acme' },
      conn['a.zendesk']!.id,
    ).expect(429);
    expect(proxied.body).toMatchObject({
      detail: `zendesk.list_tickets failed: ${limitMessage(resetsOn)}`,
      code: 'composio_monthly_limit',
    });
    // A retry of the step is refused again, never sent.
    await runStep(a, 'trello.add_boards', { name: 'Again' }, conn['a.trello']!.id).expect(429);
    expect(fixture.executions().length).toBe(before);
    expect(await usage(a)).toMatchObject({ actions: 500 });

    await runStep(b, 'trello.add_boards', { name: 'B is fine' }, conn['b.trello']!.id).expect(201);
    expect(
      fixture
        .executions()
        .slice(before)
        .map((x) => x.body.user_id),
    ).toEqual([b.id]);
    expect(await usage(b)).toEqual({ actions: 1, trigger_events: 0 });

    const seen = await as(a, http().get('/api/platform-keys')).expect(200);
    expect(seen.body.composio_usage).toEqual({
      actions_used: 500,
      actions_limit: 500,
      trigger_events: 0,
      resets_at: resetsAt,
    });
  });

  it('past the limit a Jira step, whose site lookup wraps what fails under it, is still the 429 that names the limit, and sends nothing', async () => {
    const jira = await connect(a, 'jira');
    await setActions(a, 500);
    const before = fixture.executions().length;
    const refused = await runStep(a, 'jira.get_issue', { issueIdOrKey: 'ENG-1' }, jira.id).expect(429);
    expect(refused.body).toMatchObject({
      detail: `jira.get_issue failed: ${limitMessage(resetsOn)}`,
      code: 'composio_monthly_limit',
      limit: 500,
      resets_at: resetsAt,
    });
    expect(fixture.executions().length).toBe(before);
  });

  it('at the limit the options picker says when it lifts, sending nothing', async () => {
    await setActions(a, 500);
    const before = fixture.executions().length;
    const options = await as(a, http().post('/api/node-types/gmail.list_messages/options'))
      .send({ prop: 'labelIds', connection_id: conn['a.gmail']!.id })
      .expect(201);
    expect(options.body).toEqual({
      options: [],
      disabled: true,
      placeholder: `App action limit reached — resets ${resetsOn} (UTC)`,
    });
    expect(fixture.executions().length).toBe(before);
  });

  it('at the limit the account check says the limit kept it from asking, keeping what is stored, and a step filling {{$account…}} is the 429 that names the limit — nothing sent', async () => {
    await setActions(a, 10);
    const gmail = (await connect(a, 'gmail')).id;
    const notAsked = `Sarati didn't ask gmail which account this is: ${limitMessage(resetsOn)}.`;
    await setActions(a, 500);
    const before = fixture.executions().length;

    const refreshed = await as(a, http().get(`/api/connections/${gmail}/account?refresh=1`)).expect(200);
    expect(refreshed.body).toEqual({
      account: expect.objectContaining({ email: 'someone@e2e.local' }),
      detail: notAsked,
    });
    await db.query(`UPDATE connections SET account = NULL, account_checked_at = NULL WHERE id = $1`, [gmail]);
    const unasked = await as(a, http().get(`/api/connections/${gmail}/account`)).expect(200);
    expect(unasked.body).toEqual({ account: null, detail: notAsked });

    const step = await runStep(a, 'gmail.list_messages', { q: 'to:{{$account.email}}' }, gmail).expect(429);
    expect(step.body).toMatchObject({
      detail: `Sarati couldn't ask gmail which account this step runs as: ${limitMessage(resetsOn)}`,
      code: 'composio_monthly_limit',
      limit: 500,
      resets_at: resetsAt,
    });
    expect(fixture.executions().length).toBe(before);
    expect(await usage(a)).toMatchObject({ actions: 500 });
  });

  it('the hand-polled Gmail trigger, an app action a minute, isn’t offered here, and one a workflow holds is never stood up or polled: nothing is sent or counted, and its error names the subscribed trigger', async () => {
    const catalog = await triggerCatalog(a);
    const instead = catalog.find((t) => t.type === SUBSCRIBED_GMAIL);
    expect(instead).toBeDefined();
    expect(catalog.map((t) => t.type)).not.toContain(HAND_POLLED_GMAIL);

    const deployed = await as(a, http().post('/api/deploy'), shared.id)
      .send({ workflow_json: deliveryDoc('mail', HAND_POLLED_GMAIL) })
      .expect(201);
    const workflowId = deployed.body.workflow_id as string;
    const production = await productionOf(shared.id);
    await db.query(
      `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, 'gmail', $2)`,
      [production, conn['a.gmail']!.id],
    );
    await setActions(a, 10);
    const before = fixture.executions().length;
    await app.get(TriggerReconcilerService).reconcile(workflowId);
    const triggers = app.get(TriggersService);
    for (let cycle = 0; cycle < 3; cycle++) await triggers.runActivationPollCycle();
    const activation = await db.query(
      `SELECT kind, trigger_type, connection_id, materialized->'connection' AS stood_up_as, last_error
         FROM runtime_trigger_activations WHERE workflow_id = $1`,
      [workflowId],
    );
    expect(activation.rows).toEqual([
      {
        kind: 'polling',
        trigger_type: HAND_POLLED_GMAIL,
        connection_id: conn['a.gmail']!.id,
        stood_up_as: null,
        last_error: HAND_POLL_NOT_SERVED,
      },
    ]);
    const status = (activation.rows[0] as { last_error: string }).last_error;
    expect(status.slice(0, CARD_SHOWS)).toContain(`"${instead!.name}" (${SUBSCRIBED_GMAIL})`);
    // One stood up before the instance provided its account is refused when its poll comes round.
    await expect(pollGmail(a, conn['a.gmail']!.id)).rejects.toMatchObject({
      message: HAND_POLL_NOT_SERVED,
    });
    expect(fixture.executions().length).toBe(before);
    expect(await usage(a)).toMatchObject({ actions: 10 });
    await db.query(`DELETE FROM environment_connections WHERE environment_id = $1`, [production]);
  });

  it('a step on an environment slot holding another person’s account is charged to that account’s owner, not the runner', async () => {
    const production = await productionOf(shared.id);
    await db.query(
      `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, 'trello', $2)`,
      [production, conn['a.trello']!.id],
    );
    await setActions(a, 0);
    await setActions(b, 500);
    const before = fixture.executions().length;

    const run = await app.get(RunsService).run(plan('trello.add_boards', { name: 'Ops board' }), {
      externalUserId: b.id,
      environment: 'production',
      environmentId: production,
      orgId: shared.id,
    });
    expect(run.outputs.step).toEqual({ via: TRELLO });
    expect(
      fixture
        .executions()
        .slice(before)
        .map((x) => [x.body.user_id, x.body.connected_account_id]),
    ).toEqual([[a.id, conn['a.trello']!.account]]);
    expect(await usage(a)).toMatchObject({ actions: 1 });
    expect(await usage(b)).toMatchObject({ actions: 500 });

    // B's own account is at the limit; A's own runs are untouched by it.
    await runStep(b, 'trello.add_boards', { name: 'Mine' }, conn['b.trello']!.id).expect(429);
    await runStep(a, 'trello.add_boards', { name: 'Still mine' }, conn['a.trello']!.id).expect(201);
    expect(await usage(a)).toMatchObject({ actions: 2 });
    await db.query(`DELETE FROM environment_connections WHERE environment_id = $1`, [production]);
  });

  it('the count starts again in a new UTC calendar month, and a month is the UTC one whatever the session’s time zone', async () => {
    await setActions(a, 500);
    await runStep(a, 'trello.add_boards', { name: 'Refused' }, conn['a.trello']!.id).expect(429);
    // Time passes into the next month: this month's row becomes last month's.
    await db.query(
      `UPDATE composio_usage SET month = (month - interval '1 month')::date WHERE user_id = $1 AND month = ${THIS_MONTH}`,
      [a.id],
    );
    await runStep(a, 'trello.add_boards', { name: 'New month' }, conn['a.trello']!.id).expect(201);
    expect(await usage(a)).toEqual({ actions: 1, trigger_events: 0 });
    const settings = await as(a, http().get('/api/platform-keys')).expect(200);
    expect(settings.body.composio_usage).toEqual({
      actions_used: 1,
      actions_limit: 500,
      trigger_events: 0,
      resets_at: resetsAt,
    });
    const months = await db.query<{ actions: number }>(
      `SELECT actions FROM composio_usage WHERE user_id = $1 ORDER BY month`,
      [a.id],
    );
    expect(months.rows.map((r) => r.actions)).toEqual([500, 1]);

    const kiritimati = new Client({ connectionString: process.env.DATABASE_URL });
    await kiritimati.connect();
    try {
      await kiritimati.query(`SET TIME ZONE 'Pacific/Kiritimati'`);
      const at = (iso: string) =>
        kiritimati
          .query<{ month: string }>(
            `SELECT to_char(${utcMonthOf(`'${iso}'::timestamptz`)}, 'YYYY-MM-DD') AS month`,
          )
          .then((r) => r.rows[0]!.month);
      await expect(at('2026-11-30T23:00:00Z')).resolves.toBe('2026-11-01');
      await expect(at('2026-12-01T00:00:00Z')).resolves.toBe('2026-12-01');
    } finally {
      await kiritimati.end();
    }
  });

  it('two steps racing for the last action of the month: exactly one is sent and the count never passes the limit', async () => {
    await setActions(a, 499);
    const probes = lockProbes(
      () => app,
      () => db,
    );
    const side = new Client({ connectionString: process.env.DATABASE_URL });
    await side.connect();
    const before = fixture.executions().length;
    try {
      await side.query('BEGIN');
      await side.query(
        `SELECT actions FROM composio_usage WHERE user_id = $1 AND month = ${THIS_MONTH} FOR UPDATE`,
        [a.id],
      );
      const racing = [1, 2].map(() =>
        runStep(a, 'trello.add_boards', { name: 'Last one' }, conn['a.trello']!.id).then((r) => r.status),
      );
      await probes.lockWaiters(2);
      await side.query('COMMIT');
      expect((await Promise.all(racing)).sort()).toEqual([201, 429]);
    } finally {
      await side.end();
    }
    expect(fixture.executions().length).toBe(before + 1);
    expect(await usage(a)).toMatchObject({ actions: 500 });
  });

  describe('trigger deliveries', () => {
    let workflowA = '';
    const INSTANCE_A = 'ti_instance_a';
    const runsOf = async (workflowId: string): Promise<number> =>
      Number(
        (
          await db.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM runtime_runs WHERE workflow_id = $1`,
            [workflowId],
          )
        ).rows[0]!.n,
      );

    beforeAll(async () => {
      workflowA = await bound(a, a.personal, INSTANCE_A, conn['a.trello']!);
    });

    it('a delivery signed with the instance’s secret fires its activation and counts one trigger event for the account’s owner, once', async () => {
      await db.query(`DELETE FROM composio_usage`);
      const id = `msg_${randomUUID()}`;
      const body = {
        metadata: { trigger_id: INSTANCE_A, connected_account_id: conn['a.trello']!.account },
        data: {},
      };
      expect((await deliver(body, INSTANCE_SECRET, id).expect(202)).body).toMatchObject({ fired: 1 });
      expect((await deliver(body, INSTANCE_SECRET, id).expect(202)).body).toMatchObject({
        fired: 0,
        duplicate: true,
      });
      expect(await usage(a)).toEqual({ actions: 0, trigger_events: 1 });
      expect(await usage(b)).toBeNull();
    });

    it('a delivery signed with a person’s own stored secret is refused, and one for no live subscription fires nothing — neither counts', async () => {
      const body = { metadata: { trigger_id: INSTANCE_A }, data: {} };
      await deliver(body, 'whsec_stored_A').expect(401);
      const unknown = await deliver(
        { metadata: { trigger_id: 'ti_nobody' }, data: {} },
        INSTANCE_SECRET,
      ).expect(202);
      expect(unknown.body).toMatchObject({ fired: 0 });
      expect(await usage(a)).toEqual({ actions: 0, trigger_events: 1 });
    });

    it('a resend of a delivery whose runs were not yet all admitted admits them, and counts nothing more', async () => {
      const id = `msg_${randomUUID()}`;
      await db.query(
        `INSERT INTO composio_webhook_deliveries (webhook_id, trigger_id, received_at, admitted_at) VALUES ($1, $2, now(), NULL)`,
        [id, INSTANCE_A],
      );
      const before = await runsOf(workflowA);
      const body = { metadata: { trigger_id: INSTANCE_A }, data: {} };
      expect((await deliver(body, INSTANCE_SECRET, id).expect(202)).body).toMatchObject({ fired: 1 });
      expect(await runsOf(workflowA)).toBe(before + 1);
      expect(await usage(a)).toEqual({ actions: 0, trigger_events: 1 });
    });

    it('a delivery naming another person’s account never fires this person’s activation, and they can’t see the subscription', async () => {
      await as(b, http().get(`/api/triggers/activations?workflow_id=${workflowA}`)).expect(404);
      const before = await runsOf(workflowA);
      const body = {
        metadata: { trigger_id: INSTANCE_A, connected_account_id: conn['b.trello']!.account },
        data: {},
      };
      expect((await deliver(body, INSTANCE_SECRET).expect(202)).body).toMatchObject({ fired: 0 });
      expect(await runsOf(workflowA)).toBe(before);
    });

    it('the reaper lists the one project once per pass and removes only a twice-seen orphan on an account this install holds', async () => {
      await bound(a, shared.id, 'ti_org_held', conn['a.zendesk']!);
      fixture.active.splice(
        0,
        fixture.active.length,
        { id: INSTANCE_A, connected_account_id: conn['a.trello']!.account },
        { id: 'ti_org_held', connected_account_id: conn['a.zendesk']!.account },
        { id: 'ti_orphan', connected_account_id: conn['b.zendesk']!.account },
        { id: 'ti_foreign', connected_account_id: 'ca_another_install' },
      );
      const listings = () =>
        fixture.arrivals.filter((x) => x.call.startsWith('GET /api/v3/trigger_instances/active'));
      const deletes = () =>
        fixture.arrivals.filter((x) => x.call.startsWith('DELETE /api/v3/trigger_instances/'));
      const listed = listings().length;
      const triggers = app.get(TriggersService);

      await triggers.reapOrphanedComposioSubscriptions();
      expect(listings().length).toBe(listed + 1);
      expect(deletes()).toEqual([]);
      await triggers.reapOrphanedComposioSubscriptions();
      expect(listings().length).toBe(listed + 2);
      expect(deletes().map((x) => [x.call, x.key])).toEqual([
        ['DELETE /api/v3/trigger_instances/manage/ti_orphan', INSTANCE_KEY],
      ]);
      fixture.active.length = 0;
    });
  });

  it('one person can’t run as, check, test or remove another person’s account, and nothing reaches Composio or the count', async () => {
    const arrivals = fixture.arrivals.length;
    await db.query(`DELETE FROM composio_usage`);
    const theirs = conn['a.trello']!.id;

    const run = await runStep(b, 'trello.add_boards', { name: 'Not mine' }, theirs).expect(422);
    expect(run.body).toMatchObject({
      reason: 'stale',
      detail:
        'Step "Step" runs as a trello account that no longer exists or isn\'t yours — pick one of your trello accounts on the step',
    });
    await as(b, http().get(`/api/connections/${theirs}/status`)).expect(404);
    await as(b, http().post(`/api/connections/${theirs}/test`)).expect(404);
    await as(b, http().delete(`/api/connections/${theirs}?force=true`)).expect(404);

    const listed = await as(b, http().get('/api/connections')).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(theirs);

    expect(fixture.arrivals.slice(arrivals)).toEqual([]);
    expect((await db.query(`SELECT 1 FROM composio_usage`)).rowCount).toBe(0);
    expect(await app.get(ConnectionsService).managedRef(a.id, theirs)).toMatchObject({ status: 'active' });
  });

  it('a key that may only read sends nothing on an account — no dropdown loaded from it, no account asked again — so it spends none of the owner’s app actions', async () => {
    const reader = await scopedKey(a, ['workflow:read', 'connection:read']);
    const manager = await scopedKey(a, ['workflow:read', 'connection:read', 'connection:write']);
    const gmail = conn['a.gmail']!.id;
    const options = (who: Person, connectionId?: string) =>
      as(who, http().post('/api/node-types/gmail.list_messages/options')).send({
        prop: 'labelIds',
        ...(connectionId ? { connection_id: connectionId } : {}),
      });
    const account = (who: Person, refresh: boolean) =>
      as(who, http().get(`/api/connections/${gmail}/account${refresh ? '?refresh=1' : ''}`));
    const arrivals = fixture.arrivals.length;

    expect((await options(reader, gmail).expect(403)).body.detail).toBe(
      'This API key is missing the "connection:write" scope: loading options from a connected account sends requests on it.',
    );
    expect((await account(reader, true).expect(403)).body.detail).toBe(
      'This API key is missing the "connection:write" scope: asking the app again sends a request on the account.',
    );
    // What is stored is still the reader's to see, and an account never asked stays unasked.
    expect((await account(reader, false).expect(200)).body).toEqual({
      account: expect.objectContaining({ email: 'someone@e2e.local' }),
      detail: expect.stringMatching(/^Authorized against /),
    });
    await db.query(`UPDATE connections SET account = NULL, account_checked_at = NULL WHERE id = $1`, [gmail]);
    expect((await account(reader, false).expect(200)).body).toEqual({
      account: null,
      detail: 'gmail has not been asked which account this is yet.',
    });
    expect((await options(reader).expect(201)).body).toMatchObject({ options: [], disabled: true });
    expect(fixture.arrivals.slice(arrivals)).toEqual([]);
    expect(await usage(a)).toBeNull();

    await options(manager, gmail).expect(201);
    await account(manager, true).expect(200);
    expect(
      fixture.arrivals
        .slice(arrivals)
        .filter((x) => x.call.startsWith('POST /api/v3/tools/execute/'))
        .map((x) => [x.call, x.key, x.body.connected_account_id]),
    ).toEqual([
      ['POST /api/v3/tools/execute/proxy', INSTANCE_KEY, conn['a.gmail']!.account],
      ['POST /api/v3/tools/execute/GMAIL_GET_PROFILE', INSTANCE_KEY, conn['a.gmail']!.account],
    ]);
    expect(await usage(a)).toMatchObject({ actions: 2 });
  });
});

describe('an instance whose monthly limit is 0 (e2e, isolated DB, loopback Composio)', () => {
  let fixture: ComposioFixture;
  let app: INestApplication;
  let db: Client;
  const a = person('zero');
  const other = person('zero_other');
  const { http, as, runStep, connect } = harness(() => ({ app, db }));

  beforeAll(async () => {
    fixture = await startComposioFixture();
    ({ app, db } = await boot(
      {
        INSTANCE_COMPOSIO_API_KEY: INSTANCE_KEY,
        INSTANCE_COMPOSIO_WEBHOOK_SECRET: INSTANCE_SECRET,
        INSTANCE_COMPOSIO_MONTHLY_ACTIONS_PER_PERSON: '0',
      },
      fixture,
    ));
    await seedPeople(db, [a, other], { id: randomUUID(), owner: a, member: other });
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    await fixture.close();
    process.env.DATABASE_URL = ADMIN_URL;
    delete process.env.COMPOSIO_BASE_URL;
  });

  it('connects, then refuses the first app action without sending it or counting anything', async () => {
    const trello = await connect(a, 'trello');
    const refused = await runStep(a, 'trello.add_boards', { name: 'None allowed' }, trello.id).expect(429);
    expect(refused.body.detail).toMatch(
      /^This instance runs no app actions on its Composio account: its monthly limit per person is 0/,
    );
    expect(fixture.executions()).toEqual([]);
    expect((await db.query(`SELECT 1 FROM composio_usage`)).rowCount).toBe(0);
  });

  it('says a dropdown loads nothing because app actions are off here, naming no reset to wait for, and sends nothing', async () => {
    const gmail = await connect(a, 'gmail');
    const options = await as(a, http().post('/api/node-types/gmail.list_messages/options'))
      .send({ prop: 'labelIds', connection_id: gmail.id })
      .expect(201);
    expect(options.body).toEqual({
      options: [],
      disabled: true,
      placeholder: 'App actions are off on this instance',
    });
    expect(fixture.executions()).toEqual([]);
  });
});

describe('an instance without its own Composio account behaves as before (e2e, isolated DB, loopback Composio)', () => {
  let fixture: ComposioFixture;
  let app: INestApplication;
  let db: Client;
  const a = person('own');
  const b = person('own_other');
  const { http, as, runStep, connect, bound, triggerTypes, pollGmail, deliver } = harness(() => ({
    app,
    db,
  }));

  beforeAll(async () => {
    fixture = await startComposioFixture();
    ({ app, db } = await boot({}, fixture));
    await seedPeople(db, [a, b], { id: randomUUID(), owner: a, member: b });
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    await fixture.close();
    process.env.DATABASE_URL = ADMIN_URL;
    delete process.env.COMPOSIO_BASE_URL;
  });

  it('each person sets their own key, every call uses it, and nothing is counted or limited', async () => {
    const before = await as(a, http().get('/api/platform-keys')).expect(200);
    expect(before.body.keys.composio_api_key).toEqual({
      present: false,
      updated_at: null,
      managed_by_instance: false,
    });
    expect(before.body.composio_usage).toBeNull();
    await as(a, http().get('/api/connections/capabilities')).expect(200, { managed_available: false });

    await as(a, http().put('/api/platform-keys/composio_api_key')).send({ value: 'ak_own_a' }).expect(200);
    await as(b, http().put('/api/platform-keys/composio_api_key')).send({ value: 'ak_own_b' }).expect(200);
    const trelloA = await connect(a, 'trello');
    const trelloB = await connect(b, 'trello');
    for (let i = 0; i < 3; i++) {
      await runStep(a, 'trello.add_boards', { name: `Board ${i}` }, trelloA.id).expect(201);
    }
    await runStep(b, 'trello.add_boards', { name: 'B board' }, trelloB.id).expect(201);

    const executions = fixture.executions().map((x) => [x.key, x.body.user_id]);
    expect(executions).toEqual([
      ['ak_own_a', a.id],
      ['ak_own_a', a.id],
      ['ak_own_a', a.id],
      ['ak_own_b', b.id],
    ]);
    expect(fixture.arrivals.some((x) => x.key === INSTANCE_KEY)).toBe(false);
    expect((await db.query(`SELECT 1 FROM composio_usage`)).rowCount).toBe(0);
  });

  it('a delivery signed with the person’s own secret fires their activation, and no trigger event is counted', async () => {
    await as(a, http().put('/api/platform-keys/composio_webhook_secret'))
      .send({ value: 'whsec_own_a' })
      .expect(200);
    const trello = await connect(a, 'trello');
    const workflowId = await bound(a, a.personal, 'ti_own_a', trello);
    const owner = await db.query(
      `SELECT connection_owner_user_id FROM runtime_trigger_activations WHERE workflow_id = $1`,
      [workflowId],
    );
    expect(owner.rows).toEqual([{ connection_owner_user_id: a.id }]);
    const body = { metadata: { trigger_id: 'ti_own_a', connected_account_id: trello.account }, data: {} };
    expect((await deliver(body, 'whsec_own_a').expect(202)).body).toMatchObject({ fired: 1 });
    expect((await db.query(`SELECT 1 FROM composio_usage`)).rowCount).toBe(0);
  });

  it('a subscription in a person’s own workspace is found under their own key: the reaper removes a twice-seen orphan beside it, and changing the key names it', async () => {
    const trello = await connect(a, 'trello');
    const workflowId = await bound(a, a.personal, 'ti_own_live', trello);
    fixture.active.splice(
      0,
      fixture.active.length,
      { id: 'ti_own_live', connected_account_id: trello.account },
      { id: 'ti_own_orphan', connected_account_id: trello.account },
    );
    const listings = () =>
      fixture.arrivals.filter((x) => x.call.startsWith('GET /api/v3/trigger_instances/active'));
    const deletes = () =>
      fixture.arrivals.filter((x) => x.call.startsWith('DELETE /api/v3/trigger_instances/'));
    const listed = listings().length;
    const triggers = app.get(TriggersService);
    await triggers.reapOrphanedComposioSubscriptions();
    await triggers.reapOrphanedComposioSubscriptions();
    expect(
      listings()
        .slice(listed)
        .map((x) => x.key),
    ).toEqual(['ak_own_a', 'ak_own_a']);
    expect(deletes().map((x) => [x.call, x.key])).toEqual([
      ['DELETE /api/v3/trigger_instances/manage/ti_own_orphan', 'ak_own_a'],
    ]);
    fixture.active.length = 0;

    const { rows } = await db.query<{ name: string }>(`SELECT name FROM workflows WHERE id = $1`, [
      workflowId,
    ]);
    const warn = jest.spyOn(Logger.prototype, 'warn');
    try {
      await as(a, http().put('/api/platform-keys/composio_api_key')).send({ value: 'ak_own_a' }).expect(200);
      expect(warn.mock.calls.map(([message]) => String(message))).toContainEqual(
        expect.stringContaining(
          `workflow "${rows[0]!.name}" still has a live github.github_commit_event subscription`,
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('the hand-polled Gmail trigger is offered and polls on the person’s own key, uncounted', async () => {
    expect(await triggerTypes(a)).toContain(HAND_POLLED_GMAIL);
    const gmail = await connect(a, 'gmail');
    const before = fixture.executions().length;
    await expect(pollGmail(a, gmail.id)).resolves.toEqual([]);
    expect(
      fixture
        .executions()
        .slice(before)
        .map((x) => [x.call, x.key]),
    ).toEqual([['POST /api/v3/tools/execute/GMAIL_FETCH_EMAILS', 'ak_own_a']]);
    expect((await db.query(`SELECT 1 FROM composio_usage`)).rowCount).toBe(0);
  });
});
