import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** ADR 0041 — a dry run stubs state-changing calls and records `dry_run`; a real run hits the server. */
describe('dry run (ADR 0041, e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let hitServer: Server;
  let hits: string[] = [];
  let hitUrl: string;

  const postPlan = (runId: string) => ({
    id: `plan-${runId}`,
    nodes: [
      {
        kind: 'action',
        id: 'write',
        actionId: 'http.send_request',
        props: { method: 'POST', url: `${hitUrl}/write`, body: { hello: 'world' } },
      },
    ],
  });

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    hitServer = createServer((req, res) => {
      hits.push(req.method ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"real":true}');
    });
    await new Promise<void>((r) => hitServer.listen(0, '127.0.0.1', () => r()));
    hitUrl = `http://127.0.0.1:${(hitServer.address() as AddressInfo).port}`;

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
    await new Promise<void>((resolve, reject) => hitServer.close((e) => (e ? reject(e) : resolve())));
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  it('a dry run does NOT hit the server and is recorded dry_run', async () => {
    hits = [];
    const res = await request(app.getHttpServer())
      .post('/api/runs')
      .send({ plan: postPlan('dry'), run_id: 'dry-1', dry_run: true })
      .expect(201);
    expect(res.body.outputs.write.body).toMatchObject({ dry_run: true }); // stubbed
    expect(hits).toEqual([]); // the write never left the building

    const detail = await request(app.getHttpServer()).get('/api/runs/dry-1').expect(200);
    expect(detail.body.dry_run).toBe(true);
    expect(detail.body.status).toBe('completed');
  });

  it('a real run of the same plan DOES hit the server', async () => {
    hits = [];
    await request(app.getHttpServer())
      .post('/api/runs')
      .send({ plan: postPlan('real'), run_id: 'real-1' })
      .expect(201);
    expect(hits).toEqual(['POST']); // fired for real
    const detail = await request(app.getHttpServer()).get('/api/runs/real-1').expect(200);
    expect(detail.body.dry_run).toBe(false);
  });
});
