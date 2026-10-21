import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ComposioProvider } from '../src/connections/composio.provider';
import { ConnectionsService } from '../src/connections/connections.service';
import { listenOnLoopback } from './support/listen';
import { seedPlatformKeyEverywhere } from './support/platform-keys';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const KEY = 'composio-key-that-stays-home';
const ACCOUNT_ID = 'ca_key_origin';
const LINK_URL = 'https://connect.composio.test/link/key-origin';
const SLACK_REPLY = { ok: true, channel: 'C1', ts: '1.0' };
const TRIGGER = 'GITHUB_COMMIT_EVENT';
const TRIGGER_ID = 'ti_key_origin';

interface Arrival {
  at: 'composio' | 'elsewhere';
  call: string;
  key: string | undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// The other origin answers the same, so a redirect that was followed would look like success.
function answerAsComposio(call: string, res: ServerResponse): void {
  const json = (status: number, payload: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (call.startsWith('GET /api/v3/toolkits')) {
    json(200, {
      items: [{ slug: 'slack', name: 'Slack', composio_managed_auth_schemes: ['OAUTH2'] }],
      next_cursor: null,
    });
  } else if (call.startsWith('GET /api/v3/tools?')) {
    json(200, { items: [], next_cursor: null });
  } else if (call.startsWith('GET /api/v3/auth_configs')) {
    json(200, { items: [] });
  } else if (call === 'POST /api/v3/auth_configs') {
    json(201, { auth_config: { id: 'ac_key_origin' } });
  } else if (call === 'POST /api/v3/connected_accounts/link') {
    json(201, { redirect_url: LINK_URL, connected_account_id: 'ca_linked' });
  } else if (call.startsWith('GET /api/v3/connected_accounts/')) {
    json(200, { id: ACCOUNT_ID, status: 'ACTIVE', state: { val: { token_type: 'Bearer' } } });
  } else if (call === `POST /api/v3/trigger_instances/${TRIGGER}/upsert`) {
    json(200, { trigger_id: TRIGGER_ID });
  } else if (call === 'POST /api/v3/tools/execute/proxy') {
    json(200, { data: SLACK_REPLY, status: 200, headers: { 'content-type': 'application/json' } });
  } else {
    json(404, { error: `unexpected ${call}` });
  }
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

function buildCatalog(baseUrl: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(__dirname, '..', 'scripts', 'build-composio-catalog.mjs')], {
      env: { ...process.env, COMPOSIO_API_KEY: KEY, COMPOSIO_BASE_URL: baseUrl },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The Composio API key only reaches the origin it was configured for: a redirect elsewhere fails the call and is never followed. */
describe('Composio key stays on its origin (e2e, isolated DB, loopback Composio, mock auth)', () => {
  let app: INestApplication;
  let composio: Server;
  let elsewhere: Server;
  let composioOrigin = '';
  let elsewhereOrigin = '';
  let arrivals: Arrival[] = [];
  let redirect: { call: RegExp; status: number } | null = null;
  let dropped: RegExp | null = null;

  const fromElsewhere = (): Arrival[] => arrivals.filter((a) => a.at === 'elsewhere');
  const toComposio = (): Arrival[] => arrivals.filter((a) => a.at === 'composio');
  const refusal = (status: number, path: string): string =>
    `Composio answered ${status}, a redirect to ${elsewhereOrigin}${path}; the API key is only sent to ${composioOrigin}, so it was not followed`;

  beforeAll(async () => {
    elsewhere = createServer((req, res) => {
      void readBody(req).then(() => {
        const call = `${req.method ?? ''} ${req.url ?? ''}`;
        arrivals.push({ at: 'elsewhere', call, key: req.headers['x-api-key'] as string | undefined });
        answerAsComposio(call, res);
      });
    });
    composio = createServer((req, res) => {
      void readBody(req).then(() => {
        const call = `${req.method ?? ''} ${req.url ?? ''}`;
        arrivals.push({ at: 'composio', call, key: req.headers['x-api-key'] as string | undefined });
        if (dropped?.test(call)) {
          req.socket.destroy();
          return;
        }
        if (redirect?.call.test(call)) {
          res.writeHead(redirect.status, { location: `${elsewhereOrigin}${req.url ?? ''}` });
          res.end();
          return;
        }
        answerAsComposio(call, res);
      });
    });
    elsewhereOrigin = await listen(elsewhere);
    composioOrigin = await listen(composio);

    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.COMPOSIO_BASE_URL = composioOrigin;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
    await seedPlatformKeyEverywhere(app, 'composio_api_key', KEY);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => composio.close(resolve));
    await new Promise((resolve) => elsewhere.close(resolve));
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
    delete process.env.COMPOSIO_BASE_URL;
  });

  beforeEach(() => {
    arrivals = [];
    redirect = null;
    dropped = null;
  });

  async function managedSlack(): Promise<string> {
    const me = await request(app.getHttpServer()).get('/api/auth/me').expect(200);
    const connections = app.get(ConnectionsService);
    const conn = await connections.createManaged(me.body.user.id as string, 'slack', ACCOUNT_ID);
    await connections.setStatus(conn.id, 'active');
    return conn.id;
  }

  async function subscribe(): Promise<string> {
    const me = await request(app.getHttpServer()).get('/api/auth/me').expect(200);
    const userId = me.body.user.id as string;
    return app
      .get(ComposioProvider)
      .createTriggerInstance(
        { kind: 'user', userId },
        { slug: TRIGGER, connectedAccountId: ACCOUNT_ID, userId, triggerConfig: { repo: 'acme/app' } },
      );
  }

  function runSlackStep(connectionId: string): Promise<request.Response> {
    const plan = {
      id: 'composio-key-origin',
      nodes: [
        {
          kind: 'action',
          id: 'step',
          actionId: 'slack.send_channel_message',
          props: { channel: 'C1', text: 'hi' },
          auth: { connectionId },
        },
      ],
    };
    return request(app.getHttpServer()).post('/api/runs').send({ plan });
  }

  describe('the Composio client (managed apps, connect links, trigger subscriptions)', () => {
    it.each([302, 307])(
      'listing managed apps fails with a %i to another origin named, and nothing reaches that origin',
      async (status) => {
        redirect = { call: /^GET \/api\/v3\/toolkits/, status };
        const res = await request(app.getHttpServer()).get('/api/connections/managed/apps').expect(502);
        expect(res.body.detail).toBe(`Composio request failed: ${refusal(status, '/api/v3/toolkits')}`);
        expect(fromElsewhere()).toEqual([]);
        expect(toComposio()).toEqual([{ at: 'composio', call: 'GET /api/v3/toolkits?limit=1000', key: KEY }]);
      },
    );

    it('a connect link Composio answers with a 307 elsewhere fails, and its body is not replayed there', async () => {
      redirect = { call: /^POST \/api\/v3\/connected_accounts\/link$/, status: 307 };
      const res = await request(app.getHttpServer())
        .post('/api/connections/managed/link')
        .send({ app: 'slack' })
        .expect(502);
      expect(res.body.detail).toBe(
        `Composio request failed: ${refusal(307, '/api/v3/connected_accounts/link')}`,
      );
      expect(fromElsewhere()).toEqual([]);
      expect(toComposio().map((a) => a.call)).toContain('POST /api/v3/connected_accounts/link');
    });

    it('a trigger subscription Composio answers with a 307 elsewhere fails, and its config is not replayed there', async () => {
      redirect = { call: /\/upsert$/, status: 307 };
      await expect(subscribe()).rejects.toMatchObject({
        message: `Composio request failed: ${refusal(307, `/api/v3/trigger_instances/${TRIGGER}/upsert`)}`,
      });
      expect(fromElsewhere()).toEqual([]);
      expect(toComposio()).toEqual([
        { at: 'composio', call: `POST /api/v3/trigger_instances/${TRIGGER}/upsert`, key: KEY },
      ]);
    });

    it('a dropped connection still says what broke, not just that the fetch failed', async () => {
      dropped = /^POST \/api\/v3\/connected_accounts\/link$/;
      const res = await request(app.getHttpServer())
        .post('/api/connections/managed/link')
        .send({ app: 'slack' })
        .expect(502);
      expect(res.body.detail).toBe('Composio request failed: other side closed');
    });

    it('on its own origin the same calls work, each carrying the key', async () => {
      const apps = await request(app.getHttpServer()).get('/api/connections/managed/apps').expect(200);
      expect(apps.body.apps).toEqual([{ slug: 'slack', name: 'Slack', executable: true }]);
      const link = await request(app.getHttpServer())
        .post('/api/connections/managed/link')
        .send({ app: 'slack' })
        .expect(201);
      expect(link.body.redirect_url).toBe(LINK_URL);
      expect(await subscribe()).toBe(TRIGGER_ID);
      expect(fromElsewhere()).toEqual([]);
      expect(toComposio().map((a) => a.call)).toEqual(
        expect.arrayContaining([
          'POST /api/v3/connected_accounts/link',
          `POST /api/v3/trigger_instances/${TRIGGER}/upsert`,
        ]),
      );
      expect(toComposio().every((a) => a.key === KEY)).toBe(true);
    });
  });

  describe('a managed step on Composio’s proxy', () => {
    it.each([302, 307])(
      'fails once, naming the %i to another origin, and neither the key nor the request reaches it',
      async (status) => {
        const conn = await managedSlack();
        redirect = { call: /^POST \/api\/v3\/tools\/execute\/proxy$/, status };
        const run = await runSlackStep(conn);
        expect(run.status).toBe(422);
        expect(run.body.detail).toBe(
          `slack.send_channel_message failed: ${refusal(status, '/api/v3/tools/execute/proxy')}`,
        );
        expect(run.body.steps).toMatchObject([{ status: 'error', attempts: 1 }]);
        expect(fromElsewhere()).toEqual([]);
        expect(toComposio().filter((a) => a.call === 'POST /api/v3/tools/execute/proxy')).toEqual([
          { at: 'composio', call: 'POST /api/v3/tools/execute/proxy', key: KEY },
        ]);
      },
    );

    it('on its own origin the step runs, the key arriving there and nowhere else', async () => {
      const conn = await managedSlack();
      const run = await runSlackStep(conn);
      expect(run.status).toBe(201);
      expect(run.body.outputs.step).toEqual(SLACK_REPLY);
      expect(fromElsewhere()).toEqual([]);
      expect(toComposio().filter((a) => a.call === 'POST /api/v3/tools/execute/proxy')).toEqual([
        { at: 'composio', call: 'POST /api/v3/tools/execute/proxy', key: KEY },
      ]);
    });
  });

  describe('the catalog builder', () => {
    it('stops at a redirect to another origin, saying so, and the key never reaches it', async () => {
      redirect = { call: /^GET \/api\/v3\/toolkits/, status: 302 };
      const built = await buildCatalog(composioOrigin);
      expect(built.code).toBe(1);
      expect(built.stderr).toContain(refusal(302, '/api/v3/toolkits'));
      expect(fromElsewhere()).toEqual([]);
    });

    it('on its own origin it reads the toolkits and their tools with the key', async () => {
      const built = await buildCatalog(composioOrigin);
      expect(built.stdout).toContain('1 managed-auth toolkits.');
      // The loopback Composio lists no tools, so the builder refuses to write and the committed catalog stays as it is.
      expect(built.stderr).toContain('FATAL: no toolkit produced any tool');
      expect(toComposio().map((a) => a.call)).toEqual([
        'GET /api/v3/toolkits?limit=1000',
        'GET /api/v3/tools?toolkit_slug=slack&limit=100',
      ]);
      expect(toComposio().every((a) => a.key === KEY)).toBe(true);
      expect(fromElsewhere()).toEqual([]);
    });
  });
});
