import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type FetchLike, guardedFetch } from '@sarati/actions-sdk';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConnectionsService } from '../src/connections/connections.service';
import { SDK_POLLING_FETCH } from '../src/providers/sdk-polling.provider';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { TriggersService } from '../src/triggers/triggers.service';
import { listenOnLoopback } from './support/listen';
import { seedPlatformKeyEverywhere } from './support/platform-keys';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const SITE = 'https://acme.atlassian.net';
const GATEWAY = 'https://api.atlassian.com';
const EMAIL = 'me@acme.test';
const API_TOKEN = 'jira-api-token-e2e';
const ACCOUNT_ID = 'ca_jira_e2e';

interface JiraHit {
  path: string;
  jql: string | null;
  authorization: string | undefined;
}

interface ProxyHit {
  endpoint: string;
  connectedAccountId: unknown;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    );
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function issue(id: string, key: string): Record<string, unknown> {
  return { id, key, fields: { summary: `issue ${key}`, created: '2026-10-12T09:00:00.000+0000' } };
}

function pollingDoc(name: string, projectKey: string): Record<string, unknown> {
  return {
    version: '1.0',
    name,
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'When an issue is created',
        node_type: 'jira.new_issue',
        type_version: 1,
        parameters: { instanceUrl: SITE, projectKey },
        position: { x: 0, y: 0 },
        metadata: { trigger: true },
      },
      {
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['new: ', '{{trigger.key}}'], separator: '' },
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

function getIssueDoc(name: string, connectionId: string, instanceUrl: string): Record<string, unknown> {
  return {
    version: '1.0',
    name,
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'When a request arrives',
        node_type: 'orchestr:webhook',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: {},
      },
      {
        id: 'issue',
        name: 'Get issue',
        node_type: 'jira.get_issue',
        type_version: 1,
        parameters: { connectionId, instanceUrl, issueIdOrKey: 'ENG-1' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e-trigger-issue',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'issue',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

/** Jira on SDK 0.2: a BYO API-token trigger authenticates with Basic, and a managed step resolves its site through the broker. */
describe('Jira connections on both rails (e2e, loopback Jira + Composio)', () => {
  let app: INestApplication;
  let db: Client;
  let jira: Server;
  let composio: Server;
  let jiraOrigin = '';

  let jiraIssues: unknown[] = [];
  let jiraHits: JiraHit[] = [];
  let sites: unknown[] = [];
  let proxyHits: ProxyHit[] = [];

  const userA = randomUUID();
  const personalA = randomUUID();
  const keyA = 'ork_e2e_jira_aaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  const siteFetch: FetchLike = (input, init) => guardedFetch(String(input).replace(SITE, jiraOrigin), init);

  beforeAll(async () => {
    jira = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      jiraHits.push({
        path: url.pathname,
        jql: url.searchParams.get('jql'),
        authorization: req.headers.authorization,
      });
      res.writeHead(url.pathname === '/rest/api/3/search/jql' ? 200 : 404, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify(url.pathname === '/rest/api/3/search/jql' ? { issues: jiraIssues } : {}));
    });
    jiraOrigin = await listen(jira);

    composio = createServer((req, res) => {
      void readBody(req).then((raw) => {
        const json = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (req.method === 'POST' && req.url === '/api/v3/tools/execute/proxy') {
          const payload = JSON.parse(raw) as Record<string, unknown>;
          const endpoint = String(payload.endpoint);
          proxyHits.push({ endpoint, connectedAccountId: payload.connected_account_id });
          const headers = { 'content-type': 'application/json' };
          if (endpoint === `${GATEWAY}/oauth/token/accessible-resources`) {
            json(200, { data: sites, status: 200, headers });
          } else if (
            /^https:\/\/api\.atlassian\.com\/ex\/jira\/[^/]+\/rest\/api\/3\/issue\/ENG-1/.test(endpoint)
          ) {
            json(200, { data: issue('10001', 'ENG-1'), status: 200, headers });
          } else {
            json(200, { data: { errorMessages: ['not found'] }, status: 404, headers });
          }
          return;
        }
        if (req.method === 'GET' && req.url === `/api/v3/connected_accounts/${ACCOUNT_ID}`) {
          json(200, { id: ACCOUNT_ID, status: 'ACTIVE', state: { val: { token_type: 'Bearer' } } });
          return;
        }
        json(404, { error: `unexpected ${req.method} ${req.url}` });
      });
    });
    process.env.COMPOSIO_BASE_URL = await listen(composio);

    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'jira@e2e.local', 'Jira', now(), now())`,
      [userA],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Jira', true, now(), now())`,
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
      .useValue(siteFetch)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    await new Promise((resolve) => jira.close(resolve));
    await new Promise((resolve) => composio.close(resolve));
    process.env.DATABASE_URL = ADMIN_URL;
    delete process.env.COMPOSIO_BASE_URL;
  });

  beforeEach(() => {
    jiraHits = [];
    proxyHits = [];
  });

  async function workspace(name: string): Promise<{ org: string; production: string }> {
    const created = await asA(http().post('/api/orgs').send({ name })).expect(201);
    const org = created.body.id as string;
    await asA(http().get('/api/environments').set('X-Org-Id', org)).expect(200);
    const env = await db.query<{ id: string }>(
      `SELECT id FROM environments WHERE org_id = $1 AND lower(name) = 'production'`,
      [org],
    );
    return { org, production: env.rows[0]!.id };
  }

  async function byoConnection(credential: unknown): Promise<string> {
    const res = await asA(http().post('/api/connections').send({ provider: 'jira', credential })).expect(201);
    return res.body.id as string;
  }

  async function assignSlot(org: string, production: string, connectionId: string): Promise<void> {
    await asA(
      http()
        .put(`/api/environments/${production}/slots/jira`)
        .set('X-Org-Id', org)
        .send({ connection_id: connectionId }),
    ).expect(200);
  }

  async function deploy(org: string, doc: Record<string, unknown>): Promise<string> {
    const res = await asA(
      http().post('/api/deploy').set('X-Org-Id', org).send({ workflow_json: doc }),
    ).expect(201);
    return res.body.workflow_id as string;
  }

  async function awaitRun(runId: string): Promise<Record<string, unknown>> {
    let run: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      run = (await asA(http().get(`/api/runs/${runId}`)).expect(200)).body as Record<string, unknown>;
      if (run.status === 'completed' || run.status === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return run;
  }

  async function triggerRuns(workflowId: string): Promise<string[]> {
    const rows = await db.query<{ run_id: string }>(
      `SELECT run_id FROM runtime_runs WHERE workflow_id = $1 AND source = 'trigger' ORDER BY started_at`,
      [workflowId],
    );
    return rows.rows.map((r) => r.run_id);
  }

  async function activationError(workflowId: string): Promise<string | null> {
    const rows = await db.query<{ last_error: string | null }>(
      `SELECT last_error FROM runtime_trigger_activations WHERE workflow_id = $1`,
      [workflowId],
    );
    return rows.rows[0]!.last_error;
  }

  describe('a BYO email + API-token connection on jira.new_issue', () => {
    it('polls with HTTP Basic on the wire and fires for the new issue', async () => {
      const { org, production } = await workspace('Jira Basic');
      await assignSlot(org, production, await byoConnection({ username: EMAIL, password: API_TOKEN }));
      jiraIssues = [issue('1', 'ENG-1')];
      const wfId = await deploy(org, pollingDoc('jira basic poll', 'ENG'));
      await app.get(TriggerReconcilerService).reconcile(wfId);

      jiraIssues = [issue('2', 'ENG-2'), issue('1', 'ENG-1')];
      await app.get(TriggersService).runActivationPollCycle();

      const basic = `Basic ${Buffer.from(`${EMAIL}:${API_TOKEN}`).toString('base64')}`;
      const engHits = jiraHits.filter((h) => h.jql?.includes('project = "ENG"'));
      expect(engHits.length).toBeGreaterThan(0);
      for (const hit of engHits) {
        expect(hit).toEqual({
          path: '/rest/api/3/search/jql',
          jql: expect.any(String),
          authorization: basic,
        });
      }
      expect(await activationError(wfId)).toBeNull();
      const runs = await triggerRuns(wfId);
      expect(runs).toHaveLength(1);
      const run = await awaitRun(runs[0]!);
      expect(run.status).toBe('completed');
      expect((run.outputs as Record<string, unknown>).announce).toBe('new: ENG-2');
    });

    it('refuses a token-shaped credential, naming the credential it needs, instead of polling Jira', async () => {
      const { org, production } = await workspace('Jira Token');
      await assignSlot(org, production, await byoConnection({ value: 'just-a-token' }));
      jiraIssues = [issue('3', 'TOK-1')];
      const wfId = await deploy(org, pollingDoc('jira token poll', 'TOK'));
      await app.get(TriggerReconcilerService).reconcile(wfId);
      await app.get(TriggersService).runActivationPollCycle();

      expect(jiraHits.filter((h) => h.jql?.includes('project = "TOK"'))).toEqual([]);
      expect(await activationError(wfId)).toBe(
        "This trigger's connection has no username and password — reconnect it with an email or username plus an API token or password",
      );
      expect(await triggerRuns(wfId)).toEqual([]);
    });

    it('a step on a token-shaped connection names the credential it needs', async () => {
      const connectionId = await byoConnection({ value: 'just-a-token' });
      const plan = {
        id: 'jira-token-step',
        nodes: [
          {
            kind: 'action',
            id: 'issue',
            actionId: 'jira.get_issue',
            props: { instanceUrl: SITE, issueIdOrKey: 'ENG-1' },
            auth: { connectionId },
          },
        ],
      };
      const run = await asA(http().post('/api/runs').send({ plan }));

      expect(run.status).toBe(422);
      expect(run.body.detail).toBe(
        'Step "issue" runs as a jira account that has no username and password — reconnect it with an email or username plus an API token or password, or pick another of your jira accounts on the step',
      );
    });
  });

  describe('a managed Jira step, its site resolved through the broker', () => {
    let org = '';
    let connectionId = '';

    beforeAll(async () => {
      const ws = await workspace('Jira Managed');
      org = ws.org;
      const connections = app.get(ConnectionsService);
      const managed = await connections.createManaged(userA, 'jira', ACCOUNT_ID);
      await connections.setStatus(managed.id, 'active');
      connectionId = managed.id;
      await assignSlot(org, ws.production, connectionId);
      await seedPlatformKeyEverywhere(app, 'composio_api_key', 'test-composio-key');
    });

    async function fire(wfId: string): Promise<Record<string, unknown>> {
      const fired = await http().post(`/api/hooks/${wfId}/production`).send({}).expect(202);
      return awaitRun(fired.body.run_id as string);
    }

    it.each(['', 'acme.atlassian.net', 'http://acme.atlassian.net'])(
      'instanceUrl %j resolves to the one site the connection reaches',
      async (instanceUrl) => {
        sites = [{ id: 'cloud-acme', url: SITE, name: 'acme' }];
        const run = await fire(
          await deploy(org, getIssueDoc(`jira one site ${instanceUrl}`, connectionId, instanceUrl)),
        );

        expect(run.status).toBe('completed');
        expect((run.outputs as Record<string, unknown>).issue).toMatchObject({ key: 'ENG-1' });
        expect(proxyHits.map((h) => h.endpoint)).toEqual([
          `${GATEWAY}/oauth/token/accessible-resources`,
          `${GATEWAY}/ex/jira/cloud-acme/rest/api/3/issue/ENG-1`,
        ]);
        expect(proxyHits.every((h) => h.connectedAccountId === ACCOUNT_ID)).toBe(true);
      },
    );

    it('a blank instanceUrl on a connection reaching two sites is refused, naming both', async () => {
      sites = [
        { id: 'cloud-acme', url: SITE, name: 'acme' },
        { id: 'cloud-beta', url: 'https://beta.atlassian.net', name: 'beta' },
      ];
      const run = await fire(await deploy(org, getIssueDoc('jira two sites', connectionId, '')));

      expect(run.status).toBe('error');
      expect(run.error).toBe(
        'jira.get_issue failed: this connection can reach several Jira sites (https://acme.atlassian.net, https://beta.atlassian.net) — set instanceUrl to the one to use',
      );
      expect(proxyHits.map((h) => h.endpoint)).toEqual([`${GATEWAY}/oauth/token/accessible-resources`]);
    });

    it('a saved step whose instanceUrl is no Jira Cloud site fails naming the field, before any request', async () => {
      sites = [{ id: 'cloud-acme', url: SITE, name: 'acme' }];
      const run = await fire(
        await deploy(org, getIssueDoc('jira self-hosted', connectionId, 'https://jira.acme.internal')),
      );

      expect(run.status).toBe('error');
      expect(run.error).toMatch(
        /^jira\.get_issue failed: instanceUrl "https:\/\/jira\.acme\.internal" is not a Jira Cloud site/,
      );
      expect(proxyHits).toEqual([]);
    });
  });
});
