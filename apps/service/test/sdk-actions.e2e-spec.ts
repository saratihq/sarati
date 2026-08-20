import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConnectionsService } from '../src/connections/connections.service';
import { listenOnLoopback } from './support/listen';
import { seedPlatformKeyEverywhere } from './support/platform-keys';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const ACCOUNT_ID = 'ca_stub_gmail';

/** Canned mailbox profile the stubbed Gmail-via-proxy returns. */
const GMAIL_PROFILE = {
  emailAddress: 'owner@example.com',
  messagesTotal: 128,
  threadsTotal: 42,
  historyId: '99001',
};

/**
 * A managed googleapis step must route to Composio TYPED EXECUTION before the SDK rail —
 * Google rejects the proxy leg, so the proxy must receive nothing for these steps.
 */
describe('SDK actions (e2e, isolated DB, stubbed Composio, mock auth)', () => {
  let app: INestApplication;
  let composioStub: Server;
  /** Every proxy execution the stub received (must stay EMPTY for googleapis steps). */
  let proxyCalls: Array<{ apiKey: string | undefined; payload: Record<string, unknown> }> = [];
  /** Every typed tools/execute call the stub received, keyed by tool slug. */
  let toolCalls: Array<{ tool: string; payload: Record<string, unknown> }> = [];

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;

    composioStub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const url = req.url ?? '';
        const json = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        // The proxy leg — must receive NOTHING for a googleapis step.
        if (req.method === 'POST' && url === '/api/v3/tools/execute/proxy') {
          const payload = JSON.parse(raw) as Record<string, unknown>;
          proxyCalls.push({ apiKey: req.headers['x-api-key'] as string | undefined, payload });
          json(200, { data: {}, status: 200, headers: { 'content-type': 'application/json' } });
          return;
        }
        // The matcher path (a non-overridden action) lists the toolkit's tools before resolving one.
        if (req.method === 'GET' && url.startsWith('/api/v3/tools?')) {
          json(200, {
            items: [
              {
                slug: 'GMAIL_GET_PROFILE',
                name: 'Get profile',
                input_parameters: { properties: { user_id: {} } },
              },
            ],
            next_cursor: null,
          });
          return;
        }
        // TYPED EXECUTION — replies in the live tool shape (a `response_data`-wrapped payload).
        const typed = /^\/api\/v3\/tools\/execute\/([A-Z0-9_]+)$/.exec(url);
        if (req.method === 'POST' && typed) {
          const payload = JSON.parse(raw) as Record<string, unknown>;
          toolCalls.push({ tool: typed[1]!, payload });
          const data =
            typed[1] === 'GMAIL_GET_PROFILE'
              ? { response_data: GMAIL_PROFILE }
              : { messages: [], nextPageToken: null, resultSizeEstimate: 0 };
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
    await new Promise<void>((resolve) => composioStub.listen(0, '127.0.0.1', resolve));
    process.env.COMPOSIO_BASE_URL = `http://127.0.0.1:${(composioStub.address() as AddressInfo).port}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    // The managed rail's key lives in the store, not the environment.
    await seedPlatformKeyEverywhere(app, 'composio_api_key', 'test-composio-key');
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => composioStub.close(resolve));
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
    delete process.env.COMPOSIO_BASE_URL;
  });

  beforeEach(() => {
    proxyCalls = [];
    toolCalls = [];
  });

  it('routes a managed Gmail step to Composio TYPED execution — never the proxy', async () => {
    const me = await request(app.getHttpServer()).get('/api/auth/me').expect(200);
    const connections = app.get(ConnectionsService);
    const conn = await connections.createManaged(me.body.user.id, 'gmail', ACCOUNT_ID);
    await connections.setStatus(conn.id, 'active');

    const plan = {
      id: 'sdk-gmail-profile',
      nodes: [
        {
          kind: 'action',
          id: 'profile',
          actionId: 'gmail.get_profile', // an SDK-owned type — the direct rail still wins
          props: {},
          auth: { connectionId: conn.id },
        },
      ],
    };
    const res = await request(app.getHttpServer()).post('/api/runs').send({ plan }).expect(201);

    // The step answers in the ACTION's declared shape, not the rail's: Composio's `response_data`
    // envelope is theirs, and a step's `{{refs}}` must not depend on how the user connected.
    expect(res.body.outputs.profile).toEqual(GMAIL_PROFILE);

    // Typed execution got the call, bound to the managed account + our user id.
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.tool).toBe('GMAIL_GET_PROFILE');
    expect(toolCalls[0]?.payload.connected_account_id).toBe(ACCOUNT_ID);
    expect(toolCalls[0]?.payload.user_id).toBe(me.body.user.id);
    // The PROXY leg received nothing, and the sentinel never left the building.
    expect(proxyCalls).toHaveLength(0);
    expect(JSON.stringify(toolCalls[0]?.payload)).not.toContain('__ORCHESTR_MANAGED__');
  }, 30_000);

  it('maps an SDK action’s props to the Composio tool’s arguments (query/limit → query/max_results)', async () => {
    const me = await request(app.getHttpServer()).get('/api/auth/me').expect(200);
    const connections = app.get(ConnectionsService);
    const conn = await connections.createManaged(me.body.user.id, 'gmail', ACCOUNT_ID);
    await connections.setStatus(conn.id, 'active');

    const plan = {
      id: 'sdk-gmail-list',
      nodes: [
        {
          kind: 'action',
          id: 'list',
          actionId: 'gmail.list_messages',
          props: { query: 'is:unread', limit: 5 },
          auth: { connectionId: conn.id },
        },
      ],
    };
    const res = await request(app.getHttpServer()).post('/api/runs').send({ plan }).expect(201);
    // `nextPageToken`/`resultSizeEstimate` are Gmail's paging, not the action's output.
    expect(res.body.outputs.list).toEqual({ messages: [], count: 0 });

    // The curated override mapped our props onto GMAIL_FETCH_EMAILS arguments.
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.tool).toBe('GMAIL_FETCH_EMAILS');
    expect(toolCalls[0]?.payload.arguments).toEqual({ query: 'is:unread', max_results: 5 });
    expect(proxyCalls).toHaveLength(0);
  }, 30_000);

  it('serves the native catalog: control nodes + OUR actions only (inspector/discovery)', async () => {
    const res = await request(app.getHttpServer()).get('/api/node-types').expect(200);
    const types = new Set((res.body.node_types as Array<{ type: string }>).map((n) => n.type));
    // Native control nodes are placeable from the palette.
    for (const control of ['orchestr:if', 'orchestr:switch', 'orchestr:loop', 'orchestr:wait_for_event']) {
      expect(types.has(control)).toBe(true);
    }
    expect(types.has('gmail.get_profile')).toBe(true);
    expect(types.has('gmail.list_messages')).toBe(true);
    // No legacy vendor node type may leak into the catalog.
    expect([...types].some((t) => t.startsWith('n8n-nodes-base.'))).toBe(false);
    // P1.2 curation: a parameterless WRITE is not offered, a parameterless READ is.
    expect(types.has('box.create_box_sign_request')).toBe(false);
    expect(types.has('airtable.list_bases')).toBe(true);

    // A per-type detail carries the SDK action's parameter schema.
    const detail = await request(app.getHttpServer()).get('/api/node-types/gmail.list_messages').expect(200);
    expect(detail.body.parameters).toHaveProperty('query');
    expect(detail.body.auth).toBe('connection');
    // The BYO-authable auth scheme (A1) must survive the `toEntry` projection.
    expect(detail.body.authScheme).toBeDefined();
    expect(typeof detail.body.authScheme.type).toBe('string');
    expect(detail.body.authScheme.type).not.toBe('none');
  }, 30_000);
});
