import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';

/**
 * The guarantee an idempotency key exists for: a request that fires a side effect and THEN fails must
 * not fire it again on retry. Releasing the key on error inverted this exactly where it mattered.
 */
describe('idempotency after a partial failure (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let db: Client;
  let hitServer: Server;
  let posts = 0;
  let hitUrl: string;

  /** Posts for real, then fails on a later step — the shape that made the old behaviour dangerous. */
  const planThatPostsThenFails = (id: string) => ({
    id: `plan-${id}`,
    nodes: [
      {
        kind: 'action',
        id: 'write',
        actionId: 'http.send_request',
        props: { method: 'POST', url: `${hitUrl}/write`, body: { hello: 'world' } },
      },
      {
        kind: 'action',
        id: 'boom',
        actionId: 'http.send_request',
        props: { method: 'POST', url: `${hitUrl}/boom`, body: {} },
      },
    ],
  });

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    hitServer = createServer((req, res) => {
      if (req.url?.startsWith('/boom')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"downstream exploded"}');
        return;
      }
      posts += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"posted":true}');
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
    await db.end();
    await new Promise<void>((resolve, reject) => hitServer.close((e) => (e ? reject(e) : resolve())));
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  it('a run that posts and then fails does not post again when retried with the same key', async () => {
    posts = 0;
    const key = `partial-${Date.now()}`;
    const body = { plan: planThatPostsThenFails('partial'), run_id: 'partial-1' };

    const first = await request(app.getHttpServer()).post('/api/runs').set('Idempotency-Key', key).send(body);
    expect(first.status).toBeGreaterThanOrEqual(400);
    expect(posts).toBe(1); // the side effect DID fire before the failure

    const retry = await request(app.getHttpServer()).post('/api/runs').set('Idempotency-Key', key).send(body);

    // The stored failure is replayed; the POST is not repeated.
    expect(retry.status).toBe(first.status);
    expect(posts).toBe(1);
  });

  it('keeps the key so the failure is replayed, rather than releasing it for a fresh attempt', async () => {
    const key = `retained-${Date.now()}`;
    await request(app.getHttpServer())
      .post('/api/runs')
      .set('Idempotency-Key', key)
      .send({ plan: planThatPostsThenFails('retained'), run_id: 'retained-1' });

    const row = await db.query<{ completed: boolean; status_code: number }>(
      `SELECT completed, status_code FROM idempotency_keys WHERE idempotency_key = $1`,
      [key],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.completed).toBe(true);
    expect(row.rows[0]?.status_code).toBeGreaterThanOrEqual(400);
  });

  it('still replays a SUCCESS verbatim and runs it only once', async () => {
    posts = 0;
    const key = `ok-${Date.now()}`;
    const body = {
      plan: {
        id: 'plan-ok',
        nodes: [
          {
            kind: 'action',
            id: 'write',
            actionId: 'http.send_request',
            props: { method: 'POST', url: `${hitUrl}/write`, body: { hello: 'world' } },
          },
        ],
      },
      run_id: 'ok-1',
    };

    const first = await request(app.getHttpServer())
      .post('/api/runs')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/api/runs')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(second.body).toEqual(first.body);
    expect(posts).toBe(1);
  });
});

/** S5c: `runtime_runs` inserts ON CONFLICT DO NOTHING, so a caller-chosen run id could execute with no history row. */
describe("run ids are the server's to choose for a token (e2e, isolated DB)", () => {
  let app: INestApplication;
  let db: Client;
  const userId = randomUUID();
  const orgId = randomUUID();
  const key = 'ork_runid_e2e_key_aaaaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');
  const plan = {
    id: 'plan-runid',
    nodes: [{ kind: 'action', id: 'n', actionId: 'text.concat', props: { texts: ['x'], separator: '' } }],
  };

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1,'runid@e2e.local','RunId',now(),now())`,
      [userId],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1,'RunId Org',false,now(),now())`,
      [orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at) VALUES (gen_random_uuid(),$1,$2,'owner',now())`,
      [orgId, userId],
    );
    await db.query(
      `INSERT INTO api_keys (id,user_id,org_id,name,key_hash,prefix,scopes,created_at) VALUES (gen_random_uuid(),$1,$2,'runid',$3,'ork_runid_e2',$4,now())`,
      [userId, orgId, hash(key), JSON.stringify(['run:execute', 'workflow:read'])],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DBOS_ENABLED = 'false';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('refuses a caller-chosen run_id from an API key, naming what to use instead', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/runs')
      .set('Authorization', `Bearer ${key}`)
      .set('X-Org-Id', orgId)
      .send({ plan, run_id: 'agent-picked-this' })
      .expect(400);
    expect(res.body.code).toBe('run_id_not_accepted');
    expect(String(res.body.detail)).toContain('Idempotency-Key');
  });

  it('server-generates the id and writes exactly one history row per run', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/runs')
      .set('Authorization', `Bearer ${key}`)
      .set('X-Org-Id', orgId)
      .send({ plan })
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/api/runs')
      .set('Authorization', `Bearer ${key}`)
      .set('X-Org-Id', orgId)
      .send({ plan })
      .expect(201);

    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM runtime_runs WHERE user_id = $1`,
      [userId],
    );
    expect(rows.rows[0]?.n).toBe(2);
    expect(first.body.planId).toBeTruthy();
    expect(second.body.planId).toBeTruthy();
  });
});
