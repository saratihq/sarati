import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner';

import { ApiKeysService } from '../src/api-keys/api-keys.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { errorMessage } from '../src/common/error-message';
import { isTriggerNode } from '../src/compiler/compile-ir';
import { ConnectionsService } from '../src/connections/connections.service';
import type { WorkflowIR } from '../src/ir/models';
import { SDK_ACTIONS_FETCH, SdkActionsProvider } from '../src/providers/sdk-actions.provider';
import {
  actionNeedsAccount,
  loadComposioCatalog,
  sdkCatalogEntries,
  validatedAppSlug,
} from '../src/providers/sdk-actions.registry';
import { RunsService } from '../src/runs/runs.service';
import { gmailFake } from './support/gmail-fake';
import { listenOnLoopback } from './support/listen';
import { seedPlatformKeyEverywhere } from './support/platform-keys';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const SESSION_SECRET = 'a-test-secret-key-for-run-as-parity-sessions';
const STEP = 'Email me the report';
const { fetch: gmailFetch, sent } = gmailFake({
  'tok-a': 'a@e2e.local',
  'tok-b': 'b@e2e.local',
  'tok-team': 'team@e2e.local',
});

// Requests as one signed-in person.
type Http = Record<'get' | 'post' | 'put' | 'patch' | 'delete', (url: string) => request.Test>;

// The rule's answer as every check reads it, and what the run did.
interface Dry {
  state: string;
  message: string | null;
  connectionId: string | null;
}
type Ran = { ok: true } | { ok: false; error: string };

// One state of the run-as rule: what the runner holds, what the step chooses, and what the slot holds.
interface Row {
  name: string;
  under: 'default' | 'environment';
  /** The step under test: Gmail's own action, or a Slack action only the Composio rail runs. */
  step?: 'email' | 'reminder';
  state: string;
  /** The Gmail account a run must send as, when it runs. */
  token?: string;
  /** The managed account a Composio run must execute as, when it runs. */
  managedAccount?: string;
  given: () => Promise<{ chosen?: string }>;
}

function workflowOf(
  id: string,
  name: string,
  nodeType: string,
  parameters: Record<string, unknown>,
): WorkflowIR {
  const node = (
    nodeId: string,
    nodeName: string,
    type: string,
    params: Record<string, unknown>,
    x: number,
  ) => ({
    id: nodeId,
    name: nodeName,
    node_type: type,
    type_version: 1,
    parameters: params,
    position: { x, y: 0 },
    metadata: {},
  });
  return {
    version: '1',
    name: 'Run-as parity',
    description: '',
    nodes: [node('trigger', 'Trigger', 'orchestr:trigger', {}, 0), node(id, name, nodeType, parameters, 300)],
    edges: [
      {
        id: 'e1',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: id,
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  };
}

function emailing(subject: string, connectionId?: string): WorkflowIR {
  return workflowOf('send_report', STEP, 'gmail.send_email', {
    to: '{{$account.email}}',
    subject,
    body: 'x',
    ...(connectionId ? { connectionId } : {}),
  });
}

// An action with no SDK twin: only the Composio rail runs it, so only a one-click (managed) account can.
function reminding(text: string, connectionId?: string): WorkflowIR {
  return workflowOf('remind', 'Remind me', 'slack.create_a_reminder', {
    text,
    time: 'in 5 minutes',
    ...(connectionId ? { connectionId } : {}),
  });
}

// Every state the run-as rule can answer: each check's dry answer is exactly what a real run then does (e2e, DBOS on).
describe('the run-as rule, dry, answers what the run does — for every state', () => {
  let app: INestApplication;
  let db: Client;
  let me = '';
  let myToken = '';
  let teammate = '';
  let org = '';
  let wf = '';
  let review = '';
  let environment = '';
  let composio: Server;
  // The managed account each Composio tools/execute call ran as.
  const executed: string[] = [];
  const tokens = new Map<string, string>();

  const as = (token: string): Http => {
    const server = request(app.getHttpServer());
    const signedIn = (test: request.Test): request.Test => test.set('Authorization', `Bearer ${token}`);
    return {
      get: (url) => signedIn(server.get(url)),
      post: (url) => signedIn(server.post(url)),
      put: (url) => signedIn(server.put(url)),
      patch: (url) => signedIn(server.patch(url)),
      delete: (url) => signedIn(server.delete(url)),
    };
  };
  const http = (): Http => as(myToken);
  const gmail = async (owner: string, token: string): Promise<string> => {
    const { id } = await app
      .get(ConnectionsService)
      .createOAuth2(owner, 'gmail', { access_token: token, token_type: 'Bearer', raw: {} });
    tokens.set(id, token);
    return id;
  };
  const pending = async (owner: string): Promise<string> =>
    (await app.get(ConnectionsService).createManaged(owner, 'gmail', `ca_${randomUUID()}`)).id;
  const slack = async (owner: string): Promise<string> =>
    (
      await app
        .get(ConnectionsService)
        .createOAuth2(owner, 'slack', { access_token: 'tok-slack', token_type: 'Bearer', raw: {} })
    ).id;
  const managedSlack = async (owner: string, connectedAccount: string): Promise<string> => {
    const connections = app.get(ConnectionsService);
    const { id } = await connections.createManaged(owner, 'slack', connectedAccount);
    await connections.setStatus(id, 'active');
    tokens.set(id, connectedAccount);
    return id;
  };
  // Straight into the table: the slot routes refuse an account for another app.
  const assign = (connectionId: string, app = 'gmail') =>
    db.query(`INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, $2, $3)`, [
      environment,
      app,
      connectionId,
    ]);

  const ROWS: Row[] = [
    { name: 'none', under: 'default', state: 'none', given: () => Promise.resolve({}) },
    {
      name: 'only',
      under: 'default',
      state: 'only',
      token: 'tok-a',
      given: async () => {
        await gmail(me, 'tok-a');
        return {};
      },
    },
    {
      name: 'several',
      under: 'default',
      state: 'several',
      given: async () => {
        await gmail(me, 'tok-a');
        await gmail(me, 'tok-b');
        return {};
      },
    },
    {
      name: 'chosen, active',
      under: 'default',
      state: 'chosen',
      token: 'tok-b',
      given: async () => {
        await gmail(me, 'tok-a');
        return { chosen: await gmail(me, 'tok-b') };
      },
    },
    {
      name: 'chosen, not active',
      under: 'default',
      state: 'inactive',
      given: async () => {
        await gmail(me, 'tok-a');
        return { chosen: await pending(me) };
      },
    },
    {
      name: 'chosen, for another app',
      under: 'default',
      state: 'wrong_app',
      given: async () => {
        await gmail(me, 'tok-a');
        return { chosen: await slack(me) };
      },
    },
    {
      name: 'chosen, since removed',
      under: 'default',
      state: 'stale',
      given: async () => {
        await gmail(me, 'tok-a');
        return { chosen: randomUUID() };
      },
    },
    {
      name: "chosen, a teammate's",
      under: 'default',
      state: 'stale',
      given: async () => {
        await gmail(me, 'tok-a');
        return { chosen: await gmail(teammate, 'tok-team') };
      },
    },
    {
      name: 'slot, active',
      under: 'environment',
      state: 'slot',
      token: 'tok-team',
      given: async () => {
        await assign(await gmail(teammate, 'tok-team'));
        return { chosen: await gmail(me, 'tok-a') };
      },
    },
    {
      name: 'slot, not active',
      under: 'environment',
      state: 'inactive_slot',
      given: async () => {
        await assign(await pending(teammate));
        return { chosen: await gmail(me, 'tok-a') };
      },
    },
    {
      name: 'slot, empty',
      under: 'environment',
      state: 'empty_slot',
      given: async () => ({ chosen: await gmail(me, 'tok-a') }),
    },
    {
      name: 'slot, for another app',
      under: 'environment',
      state: 'wrong_app_slot',
      given: async () => {
        await assign(await slack(teammate));
        return { chosen: await gmail(me, 'tok-a') };
      },
    },
    {
      name: 'one-click only, and you hold only your own credentials',
      under: 'default',
      step: 'reminder',
      state: 'none',
      given: async () => {
        await slack(me);
        return {};
      },
    },
    {
      name: 'one-click only, and you hold one of each',
      under: 'default',
      step: 'reminder',
      state: 'only',
      managedAccount: 'ca_mine',
      given: async () => {
        await slack(me);
        await managedSlack(me, 'ca_mine');
        return {};
      },
    },
    {
      name: 'one-click only, chosen with your own credentials',
      under: 'default',
      step: 'reminder',
      state: 'needs_managed',
      given: async () => {
        await managedSlack(me, 'ca_mine');
        return { chosen: await slack(me) };
      },
    },
    {
      name: 'one-click only, a slot with its own credentials',
      under: 'environment',
      step: 'reminder',
      state: 'needs_managed_slot',
      given: async () => {
        await assign(await slack(teammate), 'slack');
        return {};
      },
    },
  ];

  // The review card for the branch head, and on Default the canvas too: both must give one answer.
  const dryAnswer = async (row: Row, document: WorkflowIR): Promise<Dry> => {
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_json: document, branch: 'parity' })
      .expect(201);
    const ready = await http()
      .get(`/api/workflows/${wf}/reviews/${review}/test/readiness`)
      .query(row.under === 'environment' ? { environment_id: environment } : {})
      .expect(200);
    const blocked = ready.body.blocked as Array<{ reason: string; message: string }>;
    expect(blocked.length).toBeLessThanOrEqual(1);
    if (row.under === 'environment') {
      return {
        state: blocked[0]?.reason ?? 'slot',
        message: blocked[0]?.message ?? null,
        connectionId: null,
      };
    }
    const canvas = await http().post('/api/connections/run-as').send({ workflow_json: document }).expect(200);
    const [step] = canvas.body.steps as Array<{
      state: string;
      message: string | null;
      connection_id: string | null;
    }>;
    expect(step!.message).toBe(blocked[0]?.message ?? null);
    return { state: step!.state, message: step!.message, connectionId: step!.connection_id };
  };

  // Default runs as the HTTP route does; an environment run as a trigger or a review test dispatches it, its name recorded before a rename.
  const runFor = async (row: Row, document: WorkflowIR): Promise<Ran> => {
    if (row.under === 'default') {
      const res = await http().post('/api/runs/from-ir').send({ workflow_ir: document });
      return res.status === 201 ? { ok: true } : { ok: false, error: String(res.body.detail) };
    }
    try {
      await app.get(RunsService).runFromIr(document, {
        externalUserId: me,
        activeOrgId: org,
        orgId: org,
        runId: randomUUID(),
        environmentId: environment,
        environment: 'parity-before-rename',
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  };

  const before = { secret: process.env.SECRET_KEY, clerk: process.env.CLERK_ISSUER };

  beforeAll(async () => {
    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    // A signed-in session, not MOCK_AUTH: the run-as rule decides for the person signed in.
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.SECRET_KEY = SESSION_SECRET;
    process.env.FERNET_KEY = TEST_FERNET_KEY;
    process.env.DBOS_ENABLED = 'true';
    delete process.env.DBOS_SYSTEM_DATABASE_URL;
    composio = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const url = req.url ?? '';
        const reply = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        const executes = req.method === 'POST' && /^\/api\/v3\/tools\/execute\//.test(url);
        if (executes) {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            connected_account_id?: string;
          };
          executed.push(String(body.connected_account_id));
          reply(200, { successful: true, error: null, data: { ok: true } });
          return;
        }
        reply(404, {});
      });
    });
    await new Promise<void>((resolve) => composio.listen(0, '127.0.0.1', resolve));
    process.env.COMPOSIO_BASE_URL = `http://127.0.0.1:${(composio.address() as AddressInfo).port}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SDK_ACTIONS_FETCH)
      .useValue(gmailFetch)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    const registered = await request(app.getHttpServer())
      .post('/api/auth/local/register')
      .send({ email: 'me@e2e.local', password: 'a-long-enough-passphrase', name: 'Me' })
      .expect(201);
    me = registered.body.user.id as string;
    myToken = registered.body.token as string;
    await seedPlatformKeyEverywhere(app, 'composio_api_key', 'test-composio-key');
    teammate = randomUUID();
    await db.query(`INSERT INTO users (id, email, name) VALUES ($1, 'team@e2e.local', 'Team')`, [teammate]);
    wf = (
      await http()
        .post('/api/deploy')
        .send({ workflow_json: emailing('main') })
        .expect(201)
    ).body.workflow_id as string;
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'parity' }).expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_json: emailing('branch'), branch: 'parity' })
      .expect(201);
    review = (
      await http()
        .post(`/api/workflows/${wf}/reviews`)
        .send({ source_branch: 'parity', title: 'Parity' })
        .expect(201)
    ).body.id as string;
    environment = (await http().post('/api/environments').send({ name: 'parity-before-rename' }).expect(201))
      .body.id as string;
    await http().patch(`/api/environments/${environment}`).send({ name: 'parity' }).expect(200);
    org = (await db.query<{ org_id: string }>(`SELECT org_id FROM environments WHERE id = $1`, [environment]))
      .rows[0]!.org_id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await new Promise((resolve) => composio?.close(resolve));
    delete process.env.COMPOSIO_BASE_URL;
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
    process.env.DBOS_ENABLED = 'false';
    for (const [key, value] of [
      ['SECRET_KEY', before.secret],
      ['CLERK_ISSUER', before.clerk],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }, 60_000);

  it.each(ROWS.map((row) => [row.name, row] as const))(
    '%s',
    async (_name, row) => {
      await db.query(`DELETE FROM environment_connections WHERE environment_id = $1`, [environment]);
      await db.query(`DELETE FROM connections WHERE user_id = ANY($1)`, [[me, teammate]]);
      sent.length = 0;
      executed.length = 0;
      const { chosen } = await row.given();
      const document = row.step === 'reminder' ? reminding(row.name, chosen) : emailing(row.name, chosen);

      const dry = await dryAnswer(row, document);
      const ran = await runFor(row, document);

      expect({ runs: dry.message === null, error: dry.message }).toEqual(
        ran.ok ? { runs: true, error: null } : { runs: false, error: ran.error },
      );
      expect(sent.map((message) => message.token)).toEqual(ran.ok && row.token ? [row.token] : []);
      expect(executed).toEqual(ran.ok && row.managedAccount ? [row.managedAccount] : []);
      if (dry.connectionId) expect(tokens.get(dry.connectionId)).toBe(row.token ?? row.managedAccount);
      expect(dry.state).toBe(row.state);
    },
    30_000,
  );

  it('a dry run decides the account too — a step it would skip stops there with none to run as', async () => {
    const document = emailing('dry');
    const nodes = document.nodes as unknown as Array<Record<string, unknown>>;
    nodes[1] = { ...nodes[1], name: 'Who am I', node_type: 'asana.get_current_user', parameters: {} };
    const expected =
      'Step "Who am I" runs only on a one-click (managed) asana account, and you have none — connect one under Integrations';

    const canvas = await http().post('/api/connections/run-as').send({ workflow_json: document }).expect(200);
    expect(canvas.body.steps).toEqual([expect.objectContaining({ state: 'none', message: expected })]);
    const dry = await http().post('/api/runs/from-ir').send({ workflow_ir: document, dry_run: true });
    expect(dry.status).toBe(422);
    expect(dry.body.detail).toBe(expected);
  }, 30_000);

  it("an environment whose account isn't active refuses the branch test up front, as the card names it — nothing runs", async () => {
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_json: emailing('inactive slot'), branch: 'parity' })
      .expect(201);
    await db.query(`DELETE FROM environment_connections WHERE environment_id = $1`, [environment]);
    await assign(await pending(teammate));
    sent.length = 0;
    const before = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM runtime_runs WHERE review_id = $1`,
      [review],
    );

    const refused = await http()
      .post(`/api/workflows/${wf}/reviews/${review}/test`)
      .send({ environment_id: environment })
      .expect(428);
    expect(refused.body.detail).toBe(
      `parity's gmail account isn't active, so "${STEP}" can't run there — its owner tests it under Integrations once it works again, or an owner reassigns the slot under Integrations → Environments, or test on Default (your connections)`,
    );
    expect(refused.body.code).toBe('environment_slots_inactive');
    const after = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM runtime_runs WHERE review_id = $1`,
      [review],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(sent).toEqual([]);
  }, 30_000);

  it('the canvas reads every account its steps chose in one query, however many steps choose one', async () => {
    await db.query(`DELETE FROM connections WHERE user_id = ANY($1)`, [[me, teammate]]);
    const mine = await gmail(me, 'tok-a');
    const theirs = await gmail(teammate, 'tok-team');
    const chosen = [
      mine,
      mine.toUpperCase(),
      theirs,
      'not-an-id',
      ...Array.from({ length: 300 }, () => randomUUID()),
    ];
    const document = {
      nodes: chosen.map((connectionId, i) => ({
        id: `s${i}`,
        name: `Step ${i}`,
        node_type: 'gmail.send_email',
        parameters: { connectionId },
      })),
    };
    const query = jest.spyOn(app.get(DataSource).manager, 'query');
    try {
      const canvas = await http()
        .post('/api/connections/run-as')
        .send({ workflow_json: document })
        .expect(200);

      const states = (canvas.body.steps as Array<{ state: string }>).map((step) => step.state);
      expect(states.slice(0, 3)).toEqual(['chosen', 'chosen', 'stale']);
      expect(new Set(states.slice(3))).toEqual(new Set(['stale']));
      const reads = query.mock.calls.filter(([sql]) =>
        /\bFROM connections WHERE user_id = \$1 AND id = ANY\b/.test(String(sql)),
      );
      expect(reads).toHaveLength(1);
    } finally {
      query.mockRestore();
    }
  }, 30_000);

  it('a canvas reads your accounts in two queries however many apps it holds, and none for a type no catalog knows', async () => {
    await db.query(`DELETE FROM connections WHERE user_id = ANY($1)`, [[me, teammate]]);
    const mine = await gmail(me, 'tok-a');
    const step = (id: string, nodeType: string, parameters: Record<string, unknown> = {}) => ({
      id,
      name: id,
      node_type: nodeType,
      parameters,
    });
    const typeOfApp = new Map<string, string>();
    for (const type of [...sdkCatalogEntries(), ...loadComposioCatalog()].map((entry) =>
      String(entry.type),
    )) {
      const app = validatedAppSlug(type);
      if (app && actionNeedsAccount(type) && !isTriggerNode({ node_type: type }) && !typeOfApp.has(app)) {
        typeOfApp.set(app, type);
      }
    }
    const chosen = step('chosen', 'gmail.send_email', { connectionId: mine });
    const documents = {
      'every app': [...[...typeOfApp.values()].map((type, i) => step(`a${i}`, type)), chosen],
      'unknown types': [
        ...Array.from({ length: 3000 }, (_, i) => step(`z${i}`, `z${i}.x`, { connectionId: 'c' })),
        chosen,
      ],
    };
    expect(typeOfApp.size).toBeGreaterThan(100);
    const query = jest.spyOn(PostgresQueryRunner.prototype, 'query');
    const answered: Array<{ name: string; reads: number; steps: number; chosen: string | undefined }> = [];
    try {
      for (const [name, nodes] of Object.entries(documents)) {
        query.mockClear();
        const canvas = await http()
          .post('/api/connections/run-as')
          .send({ workflow_json: { nodes } })
          .expect(200);

        const steps = canvas.body.steps as Array<{ node_id: string; state: string }>;
        const reads = query.mock.calls.filter(
          ([sql, parameters]) =>
            /\bFROM "?connections\b/i.test(String(sql)) &&
            Array.isArray(parameters) &&
            parameters.includes(me),
        );
        const chosenState = steps.find((s) => s.node_id === 'chosen')?.state;
        answered.push({ name, reads: reads.length, steps: steps.length, chosen: chosenState });
      }
    } finally {
      query.mockRestore();
    }

    expect(answered).toEqual([
      { name: 'every app', reads: 2, steps: typeOfApp.size + 1, chosen: 'chosen' },
      { name: 'unknown types', reads: 2, steps: 1, chosen: 'chosen' },
    ]);
  }, 60_000);

  it("the review card's readiness names your accounts only to a credential that may read them", async () => {
    const keys = app.get(ApiKeysService);
    const workflowOnly = (await keys.issue(me, 'workflow only', ['workflow:read'])).key;
    const both = (await keys.issue(me, 'workflow and accounts', ['workflow:read', 'connection:read'])).key;
    const readiness = `/api/workflows/${wf}/reviews/${review}/test/readiness`;

    const refused = await as(workflowOnly).get(readiness).expect(403);
    expect(refused.body.detail).toBe('This API key is missing the "connection:read" scope.');
    const ready = await as(both).get(readiness).expect(200);
    expect(ready.body).toMatchObject({ environment: null, blocked: expect.any(Array) });
  }, 30_000);

  // The router decided the account, then it changed before the rail asked for it: the rail words it as the decision would, where the run is.
  it.each([
    [
      'on Default, not active',
      'default',
      'inactive',
      `Step "${STEP}" runs as a gmail account that isn't active — pick another of your gmail accounts on the step`,
    ],
    [
      'on Default, removed',
      'default',
      'removed',
      `Step "${STEP}" runs as a gmail account that no longer exists or isn't yours — pick one of your gmail accounts on the step`,
    ],
    [
      'under an environment, not active',
      'environment',
      'inactive',
      `parity's gmail account isn't active, so "${STEP}" can't run there — its owner tests it under Integrations once it works again, or an owner reassigns the slot under Integrations → Environments`,
    ],
    [
      'under an environment, removed',
      'environment',
      'removed',
      `parity has no gmail account assigned, so "${STEP}" can't run there — an owner assigns one under Integrations → Environments`,
    ],
    [
      'on Default, a credential its sign-in lacks',
      'default',
      'unusable',
      `Step "${STEP}" runs as a gmail account that has no API key or token — reconnect it with one, or pick another of your gmail accounts on the step`,
    ],
    [
      'under an environment, a credential its sign-in lacks',
      'environment',
      'unusable',
      `parity's gmail account has no API key or token, so "${STEP}" can't run there — reconnect it with one, or an owner reassigns it under Integrations → Environments`,
    ],
  ] as const)(
    'an account lost after the decision is reported as the decision words it (%s)',
    async (_name, under, lost, expected) => {
      const owner = under === 'environment' ? teammate : me;
      const connectionId =
        lost === 'inactive'
          ? await pending(owner)
          : lost === 'unusable'
            ? await gmail(owner, '')
            : randomUUID();
      sent.length = 0;
      const ran = app.get(SdkActionsProvider).runAction({
        externalUserId: owner,
        actionId: 'gmail.send_email',
        props: { to: 'x@e2e.local', subject: 'lost', body: 'x' },
        auth: { connectionId },
        stepName: STEP,
        ...(under === 'environment'
          ? { environmentId: environment, environment: 'parity-before-rename', orgId: org }
          : {}),
      });
      await expect(ran).rejects.toThrow(expected);
      expect(sent).toEqual([]);
    },
    30_000,
  );
});
