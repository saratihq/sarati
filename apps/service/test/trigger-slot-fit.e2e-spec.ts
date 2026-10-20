import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { EncryptionService } from '../src/common/crypto/encryption.service';
import { ConnectionsService } from '../src/connections/connections.service';
import { ComposioTriggerProvider } from '../src/providers/composio-trigger.provider';
import { SDK_POLLING_FETCH, SdkPollingProvider } from '../src/providers/sdk-polling.provider';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
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

// Slack's channel list and any polled feed answer in-process; nothing leaves the machine.
const pollingFetch: FetchLike = (input) =>
  Promise.resolve(
    String(input).includes('conversations.list')
      ? json(200, { ok: true, channels: [], response_metadata: { next_cursor: '' } })
      : json(200, []),
  );

type Rail = 'composio' | 'polling';
type Fault = 'empty' | 'inactive' | 'wrong_app';

// One app trigger per rail: a Composio subscription and an SDK poll that signs in to its app.
const TRIGGERS: Record<
  Rail,
  { nodeType: string; app: string; name: string; props: Record<string, unknown> }
> = {
  composio: {
    nodeType: 'acmecrm.new_deal',
    app: 'acmecrm',
    name: 'On new deal',
    props: { pipeline: 'default' },
  },
  polling: { nodeType: 'slack.new_channel', app: 'slack', name: 'When a channel is created', props: {} },
};

function triggerDoc(
  nodeType: string,
  name: string,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  return {
    version: '1.0',
    name: `listens: ${name}`,
    description: '',
    nodes: [
      {
        id: 'watch',
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
        parameters: { texts: ['fired'], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e',
        source_node_id: 'watch',
        source_port: 0,
        target_node_id: 'say',
        target_port: 0,
        port_type: 'main',
      },
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
      `${env}'s ${app} account isn't active, so "${name}" can't run there — its owner reconnects it under Integrations, or an owner reassigns the slot under Integrations → Environments before promoting here`,
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
    `${env}'s ${app} account isn't active, so "${name}" can't run there — its owner reconnects it under Integrations, or an owner reassigns the slot under Integrations → Environments`,
  wrong_app: (env, app, name, held) =>
    `${env}'s ${app} account is for ${held}, so "${name}" can't run there — an owner assigns ${/^[aeiou]/.test(app) ? 'an' : 'a'} ${app} account under Integrations → Environments`,
};

interface ActivationRow {
  id: string;
  connection_id: string | null;
  last_error: string | null;
  composio_trigger_instance_id: string | null;
  materialized: { connection: { connectionId: string } | null } | null;
}

// Constitution #11: a trigger listens as its slot only while #18's slot half says the slot serves it, at a promote and at a stand-up.
describe('an app trigger listens only as a slot that serves it (e2e, isolated DB, fake providers)', () => {
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
  let instanceSeq = 0;

  const reconcile = (wfId: string): Promise<void> => app.get(TriggerReconcilerService).reconcile(wfId);

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
    const credential = app.get(EncryptionService).encryptToken(JSON.stringify({ value: `tok-${provider}` }));
    await db.query(
      `INSERT INTO connections (id, user_id, provider, auth_type, credential, created_at, status)
       VALUES ($1, $2, $3, 'token', $4, now(), $5)`,
      [id, userA, provider, credential, status],
    );
    return id;
  };

  // An account that serves the rail's app: a one-click one for the Composio rail, a token one for the direct poll.
  const fitting = async (rail: Rail): Promise<string> => {
    if (rail === 'polling') return tokenConnection('slack');
    const connections = app.get(ConnectionsService);
    const managed = await connections.createManaged(userA, 'acmecrm', `ca_slotfit_${randomUUID()}`);
    await connections.setStatus(managed.id, 'active');
    return managed.id;
  };

  const otherApp = (rail: Rail): string => (rail === 'composio' ? 'slack' : 'github');

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
    if (fault === 'inactive') {
      await db.query(`UPDATE connections SET status = 'expired' WHERE id = $1`, [held]);
    }
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

  const deploy = async (org: string, doc: Record<string, unknown>): Promise<{ wf: string; v1: string }> => {
    const deployed = await asA(
      http().post('/api/deploy').set('X-Org-Id', org).send({ workflow_json: doc }),
    ).expect(201);
    const wf = deployed.body.workflow_id as string;
    const versions = await asA(http().get(`/api/workflows/${wf}/versions`).set('X-Org-Id', org)).expect(200);
    return { wf, v1: (versions.body.versions as Array<{ id: string }>)[0]!.id };
  };

  const activation = async (wfId: string, envId: string): Promise<ActivationRow> => {
    const rows = await db.query<ActivationRow>(
      `SELECT id, connection_id, last_error, composio_trigger_instance_id, materialized
         FROM runtime_trigger_activations WHERE workflow_id = $1 AND environment_id = $2`,
      [wfId, envId],
    );
    expect(rows.rows).toHaveLength(1);
    return rows.rows[0]!;
  };

  // How often the rail was asked to stand a trigger up as this account: a Composio subscription by its account, an SDK poll's seed by its connection.
  const standUpsAs = async (rail: Rail, connectionId: string | null): Promise<number> => {
    if (connectionId === null) return 0;
    if (rail === 'polling') {
      return seeded.mock.calls.filter(
        (call) => (call[1] as { auth: { connectionId?: string } | null }).auth?.connectionId === connectionId,
      ).length;
    }
    const account = (await app.get(ConnectionsService).managedRef(userA, connectionId))?.connectedAccountId;
    return subscribed.mock.calls.filter(
      (call) => account && (call[1] as { connectedAccountId: string }).connectedAccountId === account,
    ).length;
  };

  beforeAll(async () => {
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
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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

    const composio = app.get(ComposioTriggerProvider);
    subscribed = jest.spyOn(composio, 'createTriggerInstance').mockImplementation(() => {
      instanceSeq += 1;
      return Promise.resolve(`ti_slotfit_${instanceSeq}`);
    });
    unsubscribed = jest.spyOn(composio, 'deleteTriggerInstance').mockResolvedValue();
    jest.spyOn(composio, 'listActiveInstances').mockResolvedValue([]);
    seeded = jest.spyOn(app.get(SdkPollingProvider), 'enable');
  }, 30_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
    await db?.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  const RAILS: Rail[] = ['composio', 'polling'];
  const FAULTS: Fault[] = ['empty', 'inactive', 'wrong_app'];
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
    'a %s trigger whose slot is %s is not stood up, says why on its activation, and stands up once a slot move serves it',
    async (rail, fault) => {
      const { app: appSlug, name, nodeType, props } = TRIGGERS[rail];
      const { org, production } = await workspace(`reconcile ${rail} ${fault}`);
      const unfit = await breakSlot(rail, fault, [production]);
      const { wf } = await deploy(org, triggerDoc(nodeType, name, props));
      await reconcile(wf);

      const held = await activation(wf, production);
      expect(held).toMatchObject({
        connection_id: null,
        composio_trigger_instance_id: null,
        last_error: LAST_ERROR[fault]('production', appSlug, name, otherApp(rail)),
        materialized: { connection: null },
      });
      expect(await standUpsAs(rail, unfit)).toBe(0);

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
    },
  );

  it.each(RAILS)(
    'a live %s trigger whose slot account stops being active is torn down by the next reconcile, and stands up again once it is active',
    async (rail) => {
      const { app: appSlug, name, nodeType, props } = TRIGGERS[rail];
      const { org, production } = await workspace(`goes inactive ${rail}`);
      const account = await fitting(rail);
      await assignSlot(org, production, appSlug, account);
      const { wf } = await deploy(org, triggerDoc(nodeType, name, props));
      await reconcile(wf);
      const live = await activation(wf, production);
      expect(live).toMatchObject({ connection_id: account, last_error: null });
      const instance = live.composio_trigger_instance_id;
      const unsubscribedBefore = unsubscribed.mock.calls.length;

      await db.query(`UPDATE connections SET status = 'expired' WHERE id = $1`, [account]);
      await reconcile(wf);

      expect(await activation(wf, production)).toMatchObject({
        connection_id: null,
        composio_trigger_instance_id: null,
        last_error: LAST_ERROR.inactive('production', appSlug, name, ''),
      });
      expect(await standUpsAs(rail, account)).toBe(1);
      if (rail === 'composio') {
        expect(unsubscribed.mock.calls.slice(unsubscribedBefore).map((call) => call[1])).toEqual([instance]);
      }

      await db.query(`UPDATE connections SET status = 'active' WHERE id = $1`, [account]);
      await reconcile(wf);

      expect(await activation(wf, production)).toMatchObject({ connection_id: account, last_error: null });
      expect(await standUpsAs(rail, account)).toBe(2);
    },
  );

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
});
