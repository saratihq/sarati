import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
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
const MOVED = '/moved';
const LINK = /^POST \/api\/v3\/connected_accounts\/link$/;
const MOVED_LINK = /^(GET|POST) \/moved\/api\/v3\/connected_accounts\/link$/;
const PROXY = /^POST \/api\/v3\/tools\/execute\/proxy$/;
const SERVICE = join(__dirname, '..');

interface Arrival {
  at: 'composio' | 'elsewhere';
  call: string;
  key: string | undefined;
  body: string;
  contentType: string | undefined;
}

interface Redirect {
  call: RegExp;
  status: number;
  location: (url: string) => string | undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function tool(slug: string, name: string): Record<string, unknown> {
  return { slug, name, description: name, input_parameters: { properties: {} } };
}

// The other origin answers the same, so a redirect that was followed would look like success.
function answerAsComposio(call: string, res: ServerResponse): void {
  const json = (status: number, payload: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (call.startsWith('GET /api/v3/toolkits')) {
    json(200, {
      items: [
        { slug: 'github', name: 'GitHub', composio_managed_auth_schemes: ['OAUTH2'] },
        { slug: 'slack', name: 'Slack', composio_managed_auth_schemes: ['OAUTH2'] },
      ],
      next_cursor: null,
    });
  } else if (call.startsWith('GET /api/v3/tools?toolkit_slug=github')) {
    json(200, { items: [tool('GITHUB_LIST_REPOS', 'List repos')], next_cursor: null });
  } else if (call.startsWith('GET /api/v3/tools?toolkit_slug=slack')) {
    json(200, { items: [tool('SLACK_LIST_CHANNELS', 'List channels')], next_cursor: null });
  } else if (call.startsWith('GET /api/v3/auth_configs')) {
    json(200, { items: [] });
  } else if (call === 'POST /api/v3/auth_configs') {
    json(201, { auth_config: { id: 'ac_key_origin' } });
  } else if (/^(GET|POST) \/api\/v3\/connected_accounts\/link$/.test(call)) {
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

async function freePort(): Promise<number> {
  const probe = createServer();
  const origin = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return Number(new URL(origin).port);
}

function run(
  file: string,
  args: string[],
  env: Record<string, string>,
): { exited: Promise<number | null>; output: () => string; kill: () => void } {
  const child = spawn(process.execPath, [...args, file], {
    cwd: SERVICE,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return {
    exited: new Promise((resolve) => child.once('exit', resolve)),
    output: () => output,
    kill: () => child.kill('SIGKILL'),
  };
}

/** The Composio API key only reaches the origin it was configured for: a redirect is followed while it stays there, and fails the call the moment it leaves. */
describe('Composio key stays on its origin (e2e, isolated DB, loopback Composio, mock auth)', () => {
  let app: INestApplication;
  let composio: Server;
  let elsewhere: Server;
  let composioOrigin = '';
  let elsewhereOrigin = '';
  let arrivals: Arrival[] = [];
  let redirects: Redirect[] = [];
  let dropped: RegExp | null = null;

  const fromElsewhere = (): Arrival[] => arrivals.filter((a) => a.at === 'elsewhere');
  const toComposio = (): Array<Pick<Arrival, 'call' | 'key'>> =>
    arrivals.filter((a) => a.at === 'composio').map(({ call, key }) => ({ call, key }));
  const refusal = (status: number, path: string): string =>
    `Composio answered ${status}, a redirect to ${elsewhereOrigin}${path}; the API key is only sent to ${composioOrigin}, so it was not followed`;
  const offOrigin = (url: string): string => `${elsewhereOrigin}${url}`;
  const twoHops = (path: RegExp): [Arrival, Arrival] => {
    const hops = arrivals.filter((a) => path.test(a.call));
    expect(hops).toHaveLength(2);
    return hops as [Arrival, Arrival];
  };
  const moved = (url: string): string => `${MOVED}${url}`;

  function serve(at: Arrival['at']) {
    return (req: IncomingMessage, res: ServerResponse): void => {
      void readBody(req).then((body) => {
        const call = `${req.method ?? ''} ${req.url ?? ''}`;
        arrivals.push({
          at,
          call,
          key: req.headers['x-api-key'] as string | undefined,
          body,
          contentType: req.headers['content-type'],
        });
        if (at === 'composio' && dropped?.test(call)) {
          req.socket.destroy();
          return;
        }
        const redirect = at === 'composio' ? redirects.find((r) => r.call.test(call)) : undefined;
        if (redirect) {
          const location = redirect.location(req.url ?? '');
          res.writeHead(redirect.status, location === undefined ? {} : { location });
          res.end();
          return;
        }
        answerAsComposio(call.replace(` ${MOVED}/`, ' /'), res);
      });
    };
  }

  beforeAll(async () => {
    elsewhere = createServer(serve('elsewhere'));
    composio = createServer(serve('composio'));
    elsewhereOrigin = await listen(elsewhere);
    composioOrigin = await listen(composio);

    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.COMPOSIO_BASE_URL = composioOrigin;
    // The connect link's own 10-a-minute limit is not what this suite tests.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
    redirects = [];
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

  function connectLink(): request.Test {
    return request(app.getHttpServer()).post('/api/connections/managed/link').send({ app: 'slack' });
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
        redirects = [{ call: /^GET \/api\/v3\/toolkits/, status, location: offOrigin }];
        const res = await request(app.getHttpServer()).get('/api/connections/managed/apps').expect(502);
        expect(res.body.detail).toBe(`Composio request failed: ${refusal(status, '/api/v3/toolkits')}`);
        expect(fromElsewhere()).toEqual([]);
        expect(toComposio()).toEqual([{ call: 'GET /api/v3/toolkits?limit=1000', key: KEY }]);
      },
    );

    it('a connect link Composio answers with a 307 elsewhere fails, and its body is not replayed there', async () => {
      redirects = [{ call: LINK, status: 307, location: offOrigin }];
      const res = await connectLink().expect(502);
      expect(res.body.detail).toBe(
        `Composio request failed: ${refusal(307, '/api/v3/connected_accounts/link')}`,
      );
      expect(fromElsewhere()).toEqual([]);
      expect(toComposio().map((a) => a.call)).toContain('POST /api/v3/connected_accounts/link');
    });

    it('a trigger subscription Composio answers with a 307 elsewhere fails, and its config is not replayed there', async () => {
      redirects = [{ call: /\/upsert$/, status: 307, location: offOrigin }];
      await expect(subscribe()).rejects.toMatchObject({
        message: `Composio request failed: ${refusal(307, `/api/v3/trigger_instances/${TRIGGER}/upsert`)}`,
      });
      expect(fromElsewhere()).toEqual([]);
      expect(toComposio()).toEqual([{ call: `POST /api/v3/trigger_instances/${TRIGGER}/upsert`, key: KEY }]);
    });

    it.each<[number, string]>([
      [307, 'POST'],
      [308, 'POST'],
      [301, 'GET'],
      [302, 'GET'],
      [303, 'GET'],
    ])(
      'a %i on its own origin is followed as a %s, carrying the key, as fetch would',
      async (status, method) => {
        redirects = [{ call: LINK, status, location: moved }];
        const res = await connectLink().expect(201);
        expect(res.body.redirect_url).toBe(LINK_URL);
        expect(fromElsewhere()).toEqual([]);
        const [first, followed] = twoHops(/connected_accounts\/link$/);
        expect(followed).toEqual({
          at: 'composio',
          call: `${method} ${MOVED}/api/v3/connected_accounts/link`,
          key: KEY,
          body: method === 'POST' ? first.body : '',
          contentType: method === 'POST' ? 'application/json' : undefined,
        });
        expect(JSON.parse(first.body)).toMatchObject({ auth_config_id: 'ac_key_origin' });
      },
    );

    it('a redirect that stays home and then leaves is refused at the hop that leaves', async () => {
      redirects = [
        { call: LINK, status: 307, location: moved },
        { call: MOVED_LINK, status: 302, location: offOrigin },
      ];
      const res = await connectLink().expect(502);
      expect(res.body.detail).toBe(
        `Composio request failed: ${refusal(302, `${MOVED}/api/v3/connected_accounts/link`)}`,
      );
      expect(fromElsewhere()).toEqual([]);
      expect(toComposio().filter((a) => /connected_accounts\/link$/.test(a.call))).toEqual([
        { call: 'POST /api/v3/connected_accounts/link', key: KEY },
        { call: `POST ${MOVED}/api/v3/connected_accounts/link`, key: KEY },
      ]);
    });

    it('a redirect that never ends on its own origin stops after 20 hops', async () => {
      redirects = [{ call: LINK, status: 307, location: (url) => url }];
      const res = await connectLink().expect(502);
      expect(res.body.detail).toBe('Composio request failed: Composio redirected more than 20 times');
      expect(toComposio().filter((a) => LINK.test(a.call))).toHaveLength(21);
    });

    it.each<[string, number, Redirect['location']]>([
      ['a 302 with no location', 302, (): undefined => undefined],
      ['a 300, which fetch never follows', 300, moved],
    ])('%s fails, saying there was no redirect to follow', async (_label, status, location) => {
      redirects = [{ call: LINK, status, location }];
      const res = await connectLink().expect(502);
      expect(res.body.detail).toBe(
        `Composio request failed: Composio answered ${status} with no redirect it could follow`,
      );
      expect(toComposio().filter((a) => MOVED_LINK.test(a.call))).toEqual([]);
    });

    it('a same-origin redirect to a URL with a username and password fails without repeating either', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        redirects = [
          {
            call: LINK,
            status: 307,
            location: (url) =>
              `${composioOrigin.replace('//', '//proxyuser:redirect-secret@')}${MOVED}${url}`,
          },
        ];
        const res = await connectLink().expect(502);
        expect(res.body.detail).toBe(
          `Composio request failed: the request to ${composioOrigin} could not be sent: fetch refused the URL or a header value`,
        );
        const logged = warn.mock.calls.map(([message]) => String(message)).join('\n');
        expect(logged).toContain('could not be sent');
        expect(`${JSON.stringify(res.body)}\n${logged}`).not.toMatch(/proxyuser|redirect-secret/);
        expect(toComposio().filter((a) => MOVED_LINK.test(a.call))).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });

    it('a stored key fetch cannot send fails without repeating the key', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        await request(app.getHttpServer())
          .put('/api/platform-keys/composio_api_key')
          .send({ value: 'pasted\nbroken-key-secret' })
          .expect(200);
        const res = await connectLink().expect(502);
        expect(res.body.detail).toBe(
          `Composio request failed: the request to ${composioOrigin} could not be sent: fetch refused the URL or a header value`,
        );
        const logged = warn.mock.calls.map(([message]) => String(message)).join('\n');
        expect(logged).toContain('could not be sent');
        expect(`${JSON.stringify(res.body)}\n${logged}`).not.toContain('broken-key-secret');
        expect(arrivals).toEqual([]);
      } finally {
        warn.mockRestore();
        await seedPlatformKeyEverywhere(app, 'composio_api_key', KEY);
      }
    });

    it('a dropped connection still says what broke, not just that the fetch failed', async () => {
      dropped = LINK;
      const res = await connectLink().expect(502);
      expect(res.body.detail).toBe('Composio request failed: other side closed');
    });

    it('on its own origin the same calls work, each carrying the key', async () => {
      const apps = await request(app.getHttpServer()).get('/api/connections/managed/apps').expect(200);
      expect(apps.body.apps).toEqual([
        { slug: 'github', name: 'GitHub', executable: true },
        { slug: 'slack', name: 'Slack', executable: true },
      ]);
      const link = await connectLink().expect(201);
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
        redirects = [{ call: PROXY, status, location: offOrigin }];
        const run = await runSlackStep(conn);
        expect(run.status).toBe(422);
        expect(run.body.detail).toBe(
          `slack.send_channel_message failed: ${refusal(status, '/api/v3/tools/execute/proxy')}`,
        );
        expect(run.body.steps).toMatchObject([{ status: 'error', attempts: 1 }]);
        expect(fromElsewhere()).toEqual([]);
        expect(toComposio().filter((a) => PROXY.test(a.call))).toEqual([
          { call: 'POST /api/v3/tools/execute/proxy', key: KEY },
        ]);
      },
    );

    it('follows a 307 that stays on its own origin, replaying the request with the key', async () => {
      const conn = await managedSlack();
      redirects = [{ call: PROXY, status: 307, location: moved }];
      const run = await runSlackStep(conn);
      expect(run.status).toBe(201);
      expect(run.body.outputs.step).toEqual(SLACK_REPLY);
      expect(fromElsewhere()).toEqual([]);
      const [first, followed] = twoHops(/\/api\/v3\/tools\/execute\/proxy$/);
      expect(followed).toEqual({ ...first, call: `POST ${MOVED}/api/v3/tools/execute/proxy` });
      expect(first.key).toBe(KEY);
    });

    it('on its own origin the step runs, the key arriving there and nowhere else', async () => {
      const conn = await managedSlack();
      const run = await runSlackStep(conn);
      expect(run.status).toBe(201);
      expect(run.body.outputs.step).toEqual(SLACK_REPLY);
      expect(fromElsewhere()).toEqual([]);
      expect(toComposio().filter((a) => PROXY.test(a.call))).toEqual([
        { call: 'POST /api/v3/tools/execute/proxy', key: KEY },
      ]);
    });
  });

  describe('the catalog builder', () => {
    let root = '';
    const catalog = (): string => join(root, 'data', 'composio_catalog.json');

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'composio-catalog-'));
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'data'));
      for (const file of ['build-composio-catalog.mjs', 'composio-catalog-fields.mjs']) {
        copyFileSync(join(SERVICE, 'scripts', file), join(root, 'scripts', file));
      }
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    beforeEach(() => rmSync(catalog(), { force: true }));

    // A copy of the script, so whatever it writes lands in a scratch tree and never on the committed catalog.
    async function buildCatalog(): Promise<{ code: number | null; output: string }> {
      const child = run(join(root, 'scripts', 'build-composio-catalog.mjs'), [], {
        COMPOSIO_API_KEY: KEY,
        COMPOSIO_BASE_URL: composioOrigin,
      });
      const code = await child.exited;
      return { code, output: child.output() };
    }

    it('stops at a redirect to another origin on the toolkit listing, saying so, and the key never reaches it', async () => {
      redirects = [{ call: /^GET \/api\/v3\/toolkits/, status: 302, location: offOrigin }];
      const built = await buildCatalog();
      expect(built.code).toBe(1);
      expect(built.output).toContain(refusal(302, '/api/v3/toolkits'));
      expect(fromElsewhere()).toEqual([]);
      expect(existsSync(catalog())).toBe(false);
    });

    it("stops at a redirect to another origin on one toolkit's tools, instead of writing the catalog without it", async () => {
      redirects = [{ call: /^GET \/api\/v3\/tools\?toolkit_slug=slack/, status: 302, location: offOrigin }];
      const built = await buildCatalog();
      expect(built.code).toBe(1);
      expect(built.output).toContain(refusal(302, '/api/v3/tools'));
      expect(fromElsewhere()).toEqual([]);
      expect(existsSync(catalog())).toBe(false);
    });

    it.each<[string, Redirect['location'], string]>([
      ['a redirect loop', (url) => url, 'Composio redirected more than 20 times'],
      [
        'a 302 with no location',
        (): undefined => undefined,
        'Composio answered 302 with no redirect it could follow',
      ],
    ])('stops at %s on its own origin, saying so', async (_label, location, said) => {
      redirects = [{ call: /^GET \/api\/v3\/toolkits/, status: 302, location }];
      const built = await buildCatalog();
      expect(built.code).toBe(1);
      expect(built.output).toContain(said);
      expect(existsSync(catalog())).toBe(false);
    });

    it('follows redirects that stay on its own origin, sending the key only there, and writes the catalog', async () => {
      redirects = [
        { call: /^GET \/api\/v3\/toolkits/, status: 307, location: moved },
        { call: /^GET \/api\/v3\/tools\?/, status: 302, location: moved },
      ];
      const built = await buildCatalog();
      expect(built.code).toBe(0);
      const rows = JSON.parse(readFileSync(catalog(), 'utf8')) as Array<{ type: string }>;
      expect(rows.map((r) => r.type)).toEqual(['github.list_repos', 'slack.list_channels']);
      expect(toComposio().map((a) => a.call)).toEqual(
        expect.arrayContaining([
          'GET /api/v3/toolkits?limit=1000',
          `GET ${MOVED}/api/v3/toolkits?limit=1000`,
          `GET ${MOVED}/api/v3/tools?toolkit_slug=slack&limit=100`,
          `GET ${MOVED}/api/v3/tools?toolkit_slug=github&limit=100`,
        ]),
      );
      expect(toComposio().every((a) => a.key === KEY)).toBe(true);
      expect(fromElsewhere()).toEqual([]);
    });
  });

  describe('a base URL carrying a username and password', () => {
    let databaseUrl = '';

    beforeAll(async () => {
      databaseUrl = await createE2eDatabase(ADMIN_URL);
    });

    // The exit code, or 'served' when the service came up instead of stopping.
    async function boot(
      env: Record<string, string>,
    ): Promise<{ outcome: number | null | 'served'; output: string }> {
      const port = await freePort();
      const service = run('src/main.ts', ['-r', 'ts-node/register/transpile-only'], {
        DATABASE_URL: databaseUrl,
        PORT: String(port),
        MOCK_AUTH: 'true',
        PGBOSS_ENABLED: 'false',
        DBOS_ENABLED: 'false',
        ...env,
      });
      for (;;) {
        const code = await Promise.race([
          service.exited,
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 250)),
        ]);
        if (code !== undefined) return { outcome: code, output: service.output() };
        const up = await fetch(`http://127.0.0.1:${port}/api/health`).then(
          (res) => res.ok,
          () => false,
        );
        if (up) {
          service.kill();
          await service.exited;
          return { outcome: 'served', output: service.output() };
        }
      }
    }

    it.each(['COMPOSIO_BASE_URL', 'CLERK_API_URL'])(
      '%s stops the service at boot, naming only its origin and path',
      async (name) => {
        const booted = await boot({
          [name]: `${composioOrigin.replace('//', '//proxyuser:proxy-secret@')}/c`,
        });
        expect(booted.outcome).toBe(1);
        expect(booted.output).toContain(
          `${name} (${composioOrigin}/c) must not carry a username or password`,
        );
        expect(booted.output).not.toMatch(/proxyuser|proxy-secret/);
        expect(arrivals).toEqual([]);
      },
      60_000,
    );
  });
});
