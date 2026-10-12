import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
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

/** What the provider answers behind Composio's proxy leg, by endpoint. */
const PROVIDER_REPLIES: Array<[RegExp, unknown]> = [
  [/^https:\/\/us19\.api\.mailchimp\.com\/3\.0\/lists/, { lists: [{ id: 'l1', name: 'Main' }] }],
  [/^https:\/\/acme\.zendesk\.com\/api\/v2\/tickets\.json/, { tickets: [{ id: 7 }], next_page: null }],
  [/^https:\/\/slack\.com\/api\/chat\.postMessage/, { ok: true, channel: 'C1', ts: '1.0' }],
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** Which rail a managed step takes: our SDK action over Composio's proxy, or Composio's own typed tool. */
describe('action rails (e2e, isolated DB, loopback Composio, mock auth)', () => {
  let composio: Server;
  let proxyCalls: string[] = [];
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
          const endpoint = String((JSON.parse(raw) as { endpoint: unknown }).endpoint);
          proxyCalls.push(endpoint);
          const reply = PROVIDER_REPLIES.find(([pattern]) => pattern.test(endpoint));
          json(200, {
            data: reply ? reply[1] : { error: 'not found' },
            status: reply ? 200 : 404,
            headers: { 'content-type': 'application/json' },
          });
          return;
        }
        if (req.method === 'GET' && url.startsWith('/api/v3/tools?')) {
          toolLists.push(url);
          json(200, {
            items: [
              {
                slug: 'SLACK_SEND_MESSAGE',
                name: 'Send message',
                input_parameters: { properties: { channel: { type: 'string' }, text: { type: 'string' } } },
              },
            ],
            next_cursor: null,
          });
          return;
        }
        const typed = /^\/api\/v3\/tools\/execute\/([A-Z0-9_]+)$/.exec(url);
        if (req.method === 'POST' && typed) {
          toolCalls.push(typed[1]!);
          json(200, { successful: true, data: { via: typed[1] }, error: null });
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

  /** Boot an app with `COMPOSIO_FALLBACK_APPS` set as given, on its own database. */
  function bootWith(fallbackApps: string): { app: () => INestApplication } {
    let app: INestApplication;
    beforeAll(async () => {
      process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
      process.env.PGBOSS_ENABLED = 'false';
      process.env.THROTTLE_LIMIT = '10000';
      process.env.MOCK_AUTH = 'true';
      process.env.COMPOSIO_FALLBACK_APPS = fallbackApps;
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
      configureApp(app);
      await app.init();
      await listenOnLoopback(app);
      await seedPlatformKeyEverywhere(app, 'composio_api_key', 'test-composio-key');
    }, 30_000);
    afterAll(async () => {
      await app.close();
      process.env.DATABASE_URL = ADMIN_URL;
      process.env.MOCK_AUTH = 'false';
      delete process.env.COMPOSIO_FALLBACK_APPS;
    });
    return { app: () => app };
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

  describe('with no override', () => {
    const { app } = bootWith('');

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

    it('a catalog trello type still runs on Composio’s typed tool', async () => {
      const conn = await managedConnection(app(), 'trello');
      const run = await runStep(app(), 'trello.add_boards', { name: 'Roadmap' }, conn);
      expect(run.status).toBe(201);
      expect(run.body.outputs.step).toEqual({ via: TRELLO_TOOL });
      expect(toolCalls).toEqual([TRELLO_TOOL]);
      expect(proxyCalls).toEqual([]);
    });

    it.each([
      [
        'mailchimp',
        'mailchimp.list_audiences',
        { serverPrefix: 'us19' },
        'https://us19.api.mailchimp.com/3.0/lists?count=100',
        { lists: [{ id: 'l1', name: 'Main' }], count: 1 },
      ],
      [
        'zendesk',
        'zendesk.list_tickets',
        { subdomain: 'acme' },
        'https://acme.zendesk.com/api/v2/tickets.json?per_page=100',
        { tickets: [{ id: 7 }], count: 1 },
      ],
      [
        'slack',
        'slack.send_channel_message',
        { channel: 'C1', text: 'hi' },
        'https://slack.com/api/chat.postMessage',
        { ok: true, channel: 'C1', ts: '1.0' },
      ],
    ])(
      'a managed %s SDK step runs on OUR action, over Composio’s proxy',
      async (provider, type, props, endpoint, output) => {
        const conn = await managedConnection(app(), provider);
        const run = await runStep(app(), type, props, conn);
        expect(run.status).toBe(201);
        expect(run.body.outputs.step).toEqual(output);
        expect(proxyCalls).toEqual([endpoint]);
        expect([...toolCalls, ...toolLists]).toEqual([]);
      },
    );
  });

  describe('with COMPOSIO_FALLBACK_APPS=slack', () => {
    const { app } = bootWith('slack');

    it('a managed SDK-owned slack step runs on Composio’s tool instead of our action', async () => {
      const conn = await managedConnection(app(), 'slack');
      const run = await runStep(app(), 'slack.send_channel_message', { channel: 'C1', text: 'hi' }, conn);
      expect(run.status).toBe(201);
      expect(run.body.outputs.step).toEqual({ via: 'SLACK_SEND_MESSAGE' });
      expect(toolCalls).toEqual(['SLACK_SEND_MESSAGE']);
      expect(proxyCalls).toEqual([]);
    });
  });
});
