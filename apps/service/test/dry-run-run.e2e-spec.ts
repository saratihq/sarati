import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** ADR 0041 — a dry run refuses state-changing calls and records `dry_run`; a real run hits the server. */
describe('dry run (ADR 0041, e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let hitServer: Server;
  let hits: string[] = [];
  let hitUrl: string;
  let slackConnectionId = '';

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
    process.env.FERNET_KEY = TEST_FERNET_KEY;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    // A bring-your-own Slack account: the preview must never send, so the token is a fake.
    const conn = await request(app.getHttpServer())
      .post('/api/connections')
      .send({ provider: 'slack', credential: 'xoxb-not-a-real-token', display_name: 'preview only' })
      .expect(201);
    slackConnectionId = conn.body.id as string;
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
    // The step reports the request it did not make, rather than a fabricated 200 body.
    expect(res.body.outputs.write).toMatchObject({
      dry_run: true,
      skipped: 'state-changing request (not sent in a dry run)',
      would_call: [{ method: 'POST', url: `${hitUrl}/write` }],
    });
    expect(hits).toEqual([]); // the write never left the building

    const detail = await request(app.getHttpServer()).get('/api/runs/dry-1').expect(200);
    expect(detail.body.dry_run).toBe(true);
    expect(detail.body.status).toBe('completed');
  });

  it('an action that validates its own response envelope still previews GREEN, not as a provider failure', async () => {
    hits = [];
    // `slack.send_channel_message` calls assertSlackOk on whatever comes back — handed a synthetic
    // 200 it reports "Slack API error: unknown_error", a failure that never happened (#39).
    const plan = {
      id: 'plan-envelope',
      nodes: [
        {
          kind: 'action',
          id: 'alert',
          actionId: 'slack.send_channel_message',
          props: { channel: 'C0123456789', text: 'preview only' },
          auth: { connectionId: slackConnectionId },
        },
      ],
    };
    const res = await request(app.getHttpServer())
      .post('/api/runs')
      .send({ plan, run_id: 'dry-envelope', dry_run: true })
      .expect(201);

    expect(res.body.outputs.alert).toMatchObject({ dry_run: true });
    expect(String(JSON.stringify(res.body))).not.toContain('unknown_error');

    const detail = await request(app.getHttpServer()).get('/api/runs/dry-envelope').expect(200);
    expect(detail.body.status).toBe('completed');
    expect((detail.body.steps as Array<{ error: string | null }>)[0]!.error).toBeNull();
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
