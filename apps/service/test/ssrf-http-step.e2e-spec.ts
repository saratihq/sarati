import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/**
 * An HTTP step runs on the real transport (no injected fetch), with loopback allowlisted as the test env does:
 * the allowlist names a host, so another spelling of that address — or a redirect to one — must still be refused.
 */
describe('HTTP step SSRF guard (e2e, isolated DB, real transport)', () => {
  let app: INestApplication;
  let target: Server;
  let port: number;
  const hits: string[] = [];

  const runHttpStep = (runId: string, url: string) =>
    request(app.getHttpServer())
      .post('/api/runs')
      .send({
        plan: {
          id: `plan-${runId}`,
          nodes: [{ kind: 'action', id: 'fetch', actionId: 'http.send_request', props: { url } }],
        },
        run_id: runId,
      });

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
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await stepError('ssrf-mapped')).toContain('private/internal address (::ffff:7f00:1');
    expect(hits).toEqual([]);
  });

  it('refuses a redirect from the allowlisted server to that spelling, reaching only the first hop', async () => {
    const res = await runHttpStep('ssrf-redirect', `http://127.0.0.1:${port}/redirect`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await stepError('ssrf-redirect')).toContain('private/internal address (::ffff:7f00:1');
    expect(hits).toEqual(['/redirect']);
  });
});
