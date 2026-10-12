import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConnectionsService } from '../src/connections/connections.service';
import { composioToolFor } from '../src/providers/sdk-actions.registry';
import { listenOnLoopback } from './support/listen';
import { seedPlatformKeyEverywhere } from './support/platform-keys';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const ACCOUNT_ID = 'ca_rails_e2e';
const TRELLO_TOOL = composioToolFor('trello.add_boards')!.slug;
const TEAM_INFO_TOOL = composioToolFor('slack.fetch_team_info')!.slug;
const RETIRED_WARNING =
  'COMPOSIO_FALLBACK_APPS is no longer supported and has no effect. Remove it from .env.';

/** What the provider answers behind Composio's proxy leg, keyed by `METHOD url`. */
const PROVIDER_REPLIES: Array<[RegExp, unknown]> = [
  [/^GET https:\/\/us19\.api\.mailchimp\.com\/3\.0\/lists/, { lists: [{ id: 'l1', name: 'Main' }] }],
  [/^GET https:\/\/acme\.zendesk\.com\/api\/v2\/tickets\.json/, { tickets: [{ id: 7 }], next_page: null }],
  [
    /^PUT https:\/\/acme\.zendesk\.com\/api\/v2\/tickets\/42\.json$/,
    { ticket: { id: 42, status: 'solved' } },
  ],
  [/^POST https:\/\/slack\.com\/api\/chat\.postMessage$/, { ok: true, channel: 'C1', ts: '1.0' }],
  [/^DELETE https:\/\/api\.zoom\.us\/v2\/meetings\/85746065432$/, null],
  [
    /^GET https:\/\/api\.atlassian\.com\/oauth\/token\/accessible-resources$/,
    [{ id: 'cloud-acme', url: 'https://acme.atlassian.net', name: 'acme' }],
  ],
  [
    /^POST https:\/\/api\.atlassian\.com\/ex\/jira\/cloud-acme\/rest\/api\/3\/issue$/,
    { id: '10001', key: 'OPS-1' },
  ],
];

interface CatalogRow {
  name: string;
  composioSlug?: string;
  parameters: Record<string, { type?: string }>;
}

const CATALOG = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'composio_catalog.json'), 'utf8'),
) as CatalogRow[];

/** A toolkit's tools as Composio lists them, from the recorded catalog — never a single convenient tool. */
function toolkit(slug: string): unknown[] {
  const prefix = `${slug.toUpperCase()}_`;
  return CATALOG.filter((row) => row.composioSlug?.startsWith(prefix)).map((row) => ({
    slug: row.composioSlug,
    name: row.name,
    input_parameters: {
      properties: Object.fromEntries(
        Object.entries(row.parameters).map(([name, schema]) => [name, { type: schema.type ?? 'string' }]),
      ),
    },
  }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

interface ProxyCall {
  call: string;
  headers: string[];
}

/** An SDK-owned step on a managed connection: the provider calls our action makes, and what it returns. */
const SDK_OWNED: Array<[string, string, Record<string, unknown>, string[], unknown]> = [
  [
    'zoom',
    'zoom.delete_meeting',
    { meetingId: '85746065432' },
    ['DELETE https://api.zoom.us/v2/meetings/85746065432'],
    { deleted: true, meetingId: '85746065432' },
  ],
  [
    'zendesk',
    'zendesk.update_ticket',
    { subdomain: 'acme', ticketId: 42, status: 'solved', comment: 'Fixed' },
    ['PUT https://acme.zendesk.com/api/v2/tickets/42.json'],
    { id: 42, status: 'solved' },
  ],
  [
    'jira',
    'jira.create_issue',
    { project: 'OPS', issueType: 'Task', summary: 'Rotate keys' },
    [
      'GET https://api.atlassian.com/oauth/token/accessible-resources',
      'POST https://api.atlassian.com/ex/jira/cloud-acme/rest/api/3/issue',
    ],
    { id: '10001', key: 'OPS-1' },
  ],
  [
    'mailchimp',
    'mailchimp.list_audiences',
    { serverPrefix: 'us19' },
    ['GET https://us19.api.mailchimp.com/3.0/lists?count=100'],
    { lists: [{ id: 'l1', name: 'Main' }], count: 1 },
  ],
  [
    'zendesk',
    'zendesk.list_tickets',
    { subdomain: 'acme' },
    ['GET https://acme.zendesk.com/api/v2/tickets.json?per_page=100'],
    { tickets: [{ id: 7 }], count: 1 },
  ],
  [
    'slack',
    'slack.send_channel_message',
    { channel: 'C1', text: 'hi' },
    ['POST https://slack.com/api/chat.postMessage'],
    { ok: true, channel: 'C1', ts: '1.0' },
  ],
];

/** Which rail a managed step takes: our SDK action over Composio's proxy, or Composio's own typed tool. */
describe('action rails (e2e, isolated DB, loopback Composio, mock auth)', () => {
  let composio: Server;
  let proxyCalls: ProxyCall[] = [];
  let toolCalls: string[] = [];
  let toolLists: string[] = [];

  beforeAll(async () => {
    composio = createServer((req, res) => {
      void readBody(req).then((raw) => {
        const url = req.url ?? '';
        const json = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (req.method === 'POST' && url === '/api/v3/tools/execute/proxy') {
          const payload = JSON.parse(raw) as { endpoint: unknown; method: unknown; parameters?: unknown };
          const call = `${String(payload.method)} ${String(payload.endpoint)}`;
          const parameters = Array.isArray(payload.parameters)
            ? (payload.parameters as Array<{ name: string }>)
            : [];
          proxyCalls.push({ call, headers: parameters.map((p) => p.name.toLowerCase()) });
          const reply = PROVIDER_REPLIES.find(([pattern]) => pattern.test(call));
          json(200, {
            data: reply ? reply[1] : { error: 'not found' },
            status: reply ? 200 : 404,
            headers: { 'content-type': 'application/json' },
          });
          return;
        }
        if (req.method === 'GET' && url.startsWith('/api/v3/tools?')) {
          toolLists.push(url);
          const slug = new URL(url, 'http://127.0.0.1').searchParams.get('toolkit_slug') ?? '';
          json(200, { items: toolkit(slug), next_cursor: null });
          return;
        }
        const typed = /^\/api\/v3\/tools\/execute\/([A-Z0-9_]+)$/.exec(url);
        if (req.method === 'POST' && typed) {
          toolCalls.push(typed[1]!);
          const data = typed[1] === TEAM_INFO_TOOL ? { team: { id: 'T1', name: 'Acme' } } : { via: typed[1] };
          json(200, { successful: true, data, error: null });
          return;
        }
        if (req.method === 'GET' && url === `/api/v3/connected_accounts/${ACCOUNT_ID}`) {
          json(200, { id: ACCOUNT_ID, status: 'ACTIVE', state: { val: { token_type: 'Bearer' } } });
          return;
        }
        json(404, { error: `unexpected ${req.method} ${url}` });
      });
    });
    await new Promise<void>((resolve) => composio.listen(0, '127.0.0.1', resolve));
    process.env.COMPOSIO_BASE_URL = `http://127.0.0.1:${(composio.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => composio.close(resolve));
    delete process.env.COMPOSIO_BASE_URL;
  });

  beforeEach(() => {
    proxyCalls = [];
    toolCalls = [];
    toolLists = [];
  });

  /** Boot an app with `COMPOSIO_FALLBACK_APPS` set as given, on its own database, keeping what it warned at boot. */
  function bootWith(fallbackApps: string | undefined): {
    app: () => INestApplication;
    warnings: () => string[];
  } {
    let app: INestApplication;
    let warnings: string[] = [];
    beforeAll(async () => {
      process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
      process.env.PGBOSS_ENABLED = 'false';
      process.env.THROTTLE_LIMIT = '10000';
      process.env.MOCK_AUTH = 'true';
      if (fallbackApps === undefined) delete process.env.COMPOSIO_FALLBACK_APPS;
      else process.env.COMPOSIO_FALLBACK_APPS = fallbackApps;
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
        configureApp(app);
        await app.init();
      } finally {
        warnings = warn.mock.calls.map(([message]) => String(message));
        warn.mockRestore();
      }
      await listenOnLoopback(app);
      await seedPlatformKeyEverywhere(app, 'composio_api_key', 'test-composio-key');
    }, 30_000);
    afterAll(async () => {
      await app.close();
      process.env.DATABASE_URL = ADMIN_URL;
      process.env.MOCK_AUTH = 'false';
      delete process.env.COMPOSIO_FALLBACK_APPS;
    });
    return { app: () => app, warnings: () => warnings };
  }

  async function managedConnection(app: INestApplication, provider: string): Promise<string> {
    const me = await request(app.getHttpServer()).get('/api/auth/me').expect(200);
    const connections = app.get(ConnectionsService);
    const conn = await connections.createManaged(me.body.user.id as string, provider, ACCOUNT_ID);
    await connections.setStatus(conn.id, 'active');
    return conn.id;
  }

  async function runStep(
    app: INestApplication,
    actionId: string,
    props: Record<string, unknown>,
    connectionId: string,
  ): Promise<request.Response> {
    const plan = {
      id: `rails-${actionId}`,
      nodes: [{ kind: 'action', id: 'step', actionId, props, auth: { connectionId } }],
    };
    return request(app.getHttpServer()).post('/api/runs').send({ plan });
  }

  describe.each([
    ['unset', undefined],
    ['still set from an earlier release', 'zoom, zendesk,jira slack,mailchimp'],
  ])('with COMPOSIO_FALLBACK_APPS %s', (_label, fallbackApps) => {
    const { app, warnings } = bootWith(fallbackApps);

    it(
      fallbackApps === undefined
        ? 'boots without a word about it'
        : 'warns once at boot that it does nothing',
      () => {
        const retired = warnings().filter((message) => message.includes('COMPOSIO_FALLBACK_APPS'));
        expect(retired).toEqual(fallbackApps === undefined ? [] : [RETIRED_WARNING]);
      },
    );

    it.each(SDK_OWNED)(
      'a managed %s step (%s) runs on OUR action over Composio’s proxy, idempotency key and output intact',
      async (provider, type, props, calls, output) => {
        const conn = await managedConnection(app(), provider);
        const run = await runStep(app(), type, props, conn);
        expect(run.status).toBe(201);
        expect(run.body.outputs.step).toEqual(output);
        expect(proxyCalls.map((c) => c.call)).toEqual(calls);
        const write = proxyCalls.find((c) => !c.call.startsWith('GET '));
        if (write) expect(write.headers).toContain('idempotency-key');
        expect([...toolCalls, ...toolLists]).toEqual([]);
      },
    );
  });

  describe('a type no rail can run', () => {
    const { app } = bootWith(undefined);

    it('an unknown trello type is refused at run time and at commit, with no rail touched', async () => {
      const conn = await managedConnection(app(), 'trello');
      const run = await runStep(app(), 'trello.get_card', {}, conn);
      expect(run.status).toBe(400);
      expect(run.body.detail).toBe(
        'No installed rail can run "trello.get_card" — it is neither an SDK action nor in the managed (Composio) catalog',
      );
      expect([...proxyCalls, ...toolCalls, ...toolLists]).toEqual([]);

      const deploy = await request(app().getHttpServer())
        .post('/api/deploy')
        .send({
          workflow_json: {
            version: '1',
            name: 'unknown trello type',
            description: '',
            nodes: [
              {
                id: 'card',
                name: 'card',
                node_type: 'trello.get_card',
                type_version: 1,
                parameters: { connectionId: conn },
                position: { x: 0, y: 0 },
                metadata: {},
              },
            ],
            edges: [],
            settings: { execution_order: 'v1', extra: {} },
            metadata: {},
          },
        })
        .expect(422);
      expect(deploy.body).toMatchObject({ code: 'unresolvable_node_type', node_type: 'trello.get_card' });
    });

    it('an unknown type asking for {{$account}} makes no probe and stores no account before its 400', async () => {
      const conn = await managedConnection(app(), 'slack');
      const run = await runStep(app(), 'slack.no_such_thing', { text: 'From {{$account.name}}' }, conn);
      expect(run.status).toBe(400);
      expect(run.body.detail).toBe(
        'No installed rail can run "slack.no_such_thing" — it is neither an SDK action nor in the managed (Composio) catalog',
      );
      expect([...proxyCalls, ...toolCalls, ...toolLists]).toEqual([]);
      const me = await request(app().getHttpServer()).get('/api/auth/me').expect(200);
      const stored = await app()
        .get(ConnectionsService)
        .accountOf(me.body.user.id as string, conn);
      expect(stored).toMatchObject({ account: null, checkedAt: null });
    });

    it('a catalog trello type still runs on Composio’s typed tool', async () => {
      const conn = await managedConnection(app(), 'trello');
      const run = await runStep(app(), 'trello.add_boards', { name: 'Roadmap' }, conn);
      expect(run.status).toBe(201);
      expect(run.body.outputs.step).toEqual({ via: TRELLO_TOOL });
      expect(toolCalls).toEqual([TRELLO_TOOL]);
      expect(proxyCalls).toEqual([]);
    });
  });
});
