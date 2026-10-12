import dns from 'node:dns';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** Steps on the real transport, with loopback allowlisted as the test env does: other spellings, redirects and names must still be refused. */
describe('step SSRF guard (e2e, isolated DB, real transport)', () => {
  let app: INestApplication;
  let target: Server;
  let port: number;
  const hits: string[] = [];

  const runStep = (runId: string, actionId: string, props: Record<string, unknown>, connectionId?: string) =>
    request(app.getHttpServer())
      .post('/api/runs')
      .send({
        plan: {
          id: `plan-${runId}`,
          nodes: [
            {
              kind: 'action',
              id: 'fetch',
              actionId,
              props,
              ...(connectionId ? { auth: { connectionId } } : {}),
            },
          ],
        },
        run_id: runId,
      });

  const runHttpStep = (runId: string, url: string) => runStep(runId, 'http.send_request', { url });

  const withAllowlist = async <T>(hosts: string, body: () => Promise<T>): Promise<T> => {
    const saved = process.env.ORCHESTR_HTTP_ALLOWED_HOSTS;
    process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = hosts;
    try {
      return await body();
    } finally {
      process.env.ORCHESTR_HTTP_ALLOWED_HOSTS = saved;
    }
  };

  const stepError = async (runId: string): Promise<string> => {
    const detail = await request(app.getHttpServer()).get(`/api/runs/${runId}`).expect(200);
    expect(detail.body.status).toBe('error');
    const [step] = detail.body.steps as Array<{ status: string; error: unknown }>;
    expect(step?.status).toBe('error');
    return String(step?.error);
  };

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    target = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://[::ffff:127.0.0.1]:${port}/secret` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"reached":true}');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    port = (target.address() as AddressInfo).port;

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.DBOS_ENABLED = 'false';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  beforeEach(() => {
    hits.length = 0;
  });

  it('reaches the allowlisted 127.0.0.1 server, so the refusals below are the guard and not a dead target', async () => {
    const res = await runHttpStep('ssrf-control', `http://127.0.0.1:${port}/ok`).expect(201);
    expect(res.body.outputs.fetch).toMatchObject({ status: 200, body: { reached: true } });
    expect(hits).toEqual(['/ok']);
  });

  it('refuses http://[::ffff:127.0.0.1]:<port>/ — the hex-mapped spelling the URL parser produces — without reaching it', async () => {
    const res = await runHttpStep('ssrf-mapped', `http://[::ffff:127.0.0.1]:${port}/latest/meta-data`);
    expect(res.status).toBe(422);
    expect(await stepError('ssrf-mapped')).toContain('private/internal address (::ffff:7f00:1');
    expect(hits).toEqual([]);
  });

  it('refuses a redirect from the allowlisted server to that spelling, reaching only the first hop', async () => {
    const res = await runHttpStep('ssrf-redirect', `http://127.0.0.1:${port}/redirect`);
    expect(res.status).toBe(422);
    expect(await stepError('ssrf-redirect')).toContain(
      `private/internal address (::ffff:7f00:1, redirected from http://127.0.0.1:${port})`,
    );
    expect(hits).toEqual(['/redirect']);
  });

  it('refuses a name that resolves to loopback as the connection is dialled, through the service wiring', async () => {
    const res = await withAllowlist('127.0.0.1', () =>
      runHttpStep('ssrf-name', `http://localhost:${port}/x`),
    );
    expect(res.status).toBe(422);
    expect(await stepError('ssrf-name')).toContain(
      'private/internal address (localhost). An operator can allow it by adding localhost to ORCHESTR_HTTP_ALLOWED_HOSTS.',
    );
    expect(hits).toEqual([]);
  });

  describe('an app step on a bring-your-own connection, behind an egress proxy on synthetic DNS', () => {
    const SITE = 'acme.zendesk.com';
    const PROXY_ENV = [
      'NODE_USE_ENV_PROXY',
      'http_proxy',
      'HTTP_PROXY',
      'https_proxy',
      'HTTPS_PROXY',
      'no_proxy',
      'NO_PROXY',
    ];
    const savedEnv = new Map<string, string | undefined>();
    const tunnels: string[] = [];
    let egressProxy: Server;

    const byoConnection = async (provider: string, credential: unknown): Promise<string> => {
      const res = await request(app.getHttpServer())
        .post('/api/connections')
        .send({ provider, credential })
        .expect(201);
      return res.body.id as string;
    };

    beforeAll(async () => {
      egressProxy = createServer();
      egressProxy.on('connect', (req: IncomingMessage, socket: Duplex) => {
        tunnels.push(req.url ?? '');
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      });
      await new Promise<void>((resolve) => egressProxy.listen(0, '127.0.0.1', resolve));
      for (const name of PROXY_ENV) {
        savedEnv.set(name, process.env[name]);
        delete process.env[name];
      }
      process.env.NODE_USE_ENV_PROXY = '1';
      process.env.HTTPS_PROXY = `http://127.0.0.1:${(egressProxy.address() as AddressInfo).port}`;
      const lookup = dns.promises.lookup.bind(dns.promises);
      jest
        .spyOn(dns.promises, 'lookup')
        .mockImplementation(((host: string, options: dns.LookupAllOptions) =>
          host === SITE
            ? Promise.resolve([{ address: '198.18.0.7', family: 4 }])
            : lookup(host, options)) as typeof dns.promises.lookup);
    });

    afterAll(async () => {
      jest.restoreAllMocks();
      for (const [name, value] of savedEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      egressProxy.closeAllConnections();
      await new Promise<void>((resolve) => egressProxy.close(() => resolve()));
    });

    beforeEach(() => {
      tunnels.length = 0;
    });

    it('refuses its own app’s host when this server resolves it to a private address, naming the entry to add', async () => {
      const conn = await byoConnection('zendesk', {
        username: 'me@acme.test/token',
        password: 'zendesk-token',
      });
      const res = await runStep('ssrf-byo-refused', 'zendesk.list_tickets', { subdomain: 'acme' }, conn);
      expect(res.status).toBe(422);
      expect(await stepError('ssrf-byo-refused')).toBe(
        'zendesk.list_tickets failed: refusing to send a request to a private/internal address (acme.zendesk.com). ' +
          'An operator can allow it by adding acme.zendesk.com to ORCHESTR_HTTP_ALLOWED_HOSTS.',
      );
      expect(tunnels).toEqual([]);
    });

    it('sends it to the proxy by name, unjudged, once that host is allowlisted', async () => {
      const conn = await byoConnection('zendesk', {
        username: 'me@acme.test/token',
        password: 'zendesk-token',
      });
      const res = await withAllowlist(`127.0.0.1,localhost,${SITE}`, () =>
        runStep('ssrf-byo-allowed', 'zendesk.list_tickets', { subdomain: 'acme' }, conn),
      );
      expect(res.status).toBe(422);
      expect(await stepError('ssrf-byo-allowed')).toBe(
        'zendesk.list_tickets failed: the egress proxy refused the tunnel to https://acme.zendesk.com (403)',
      );
      expect(tunnels).toEqual([`${SITE}:443`]);
    });

    it('never sends a credential off its app’s domains, whatever the allowlist names', async () => {
      const conn = await byoConnection('salesforce', { access_token: 'salesforce-token' });
      const res = await withAllowlist('127.0.0.1,localhost,na123.salesforce.com', () =>
        runStep(
          'ssrf-byo-scope',
          'salesforce.run_query',
          { instanceUrl: 'https://na123.salesforce.com', query: 'SELECT Id FROM Account' },
          conn,
        ),
      );
      expect(res.status).toBe(422);
      expect(await stepError('ssrf-byo-scope')).toContain(
        "refusing to send this connection's credential to https://na123.salesforce.com",
      );
      expect(tunnels).toEqual([]);
    });
  });
});
