import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const PARK_MS = 61_000;

/** A timed wait parks the run like an approval does, but only its own deadline may wake it. */
describe('a timed wait wakes only on its deadline (e2e, isolated DB, DBOS on, mock auth)', () => {
  let app: INestApplication;
  let db: Client;
  let hitServer: Server;
  let hitUrl: string;
  let posts = 0;
  let sleeper: Promise<Response>;
  let asker: Promise<Response>;

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  async function until(runId: string, status: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 200; i++) {
      const res = await http().get(`/api/runs/${runId}`);
      if (res.status === 200 && res.body.status === status) return res.body as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`run ${runId} never reached "${status}"`);
  }

  async function parkedOn(runId: string): Promise<{ status: string; waiting_topic: string | null }> {
    const res = await db.query(`SELECT status, waiting_topic FROM runtime_runs WHERE run_id = $1`, [runId]);
    return res.rows[0] as { status: string; waiting_topic: string | null };
  }

  async function dueAt(runId: string): Promise<Date> {
    const res = await db.query(`SELECT waiting_timeout_at FROM runtime_runs WHERE run_id = $1`, [runId]);
    return (res.rows[0] as { waiting_timeout_at: Date }).waiting_timeout_at;
  }

  async function inboxRunIds(): Promise<string[]> {
    const res = await http().get('/api/runs/waiting').expect(200);
    return (res.body.runs as Array<{ run_id: string }>).map((r) => r.run_id);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    hitServer = createServer((req, res) => {
      if (req.method === 'POST') posts++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"charged":true}');
    });
    await new Promise<void>((resolve) => hitServer.listen(0, '127.0.0.1', resolve));
    hitUrl = `http://127.0.0.1:${(hitServer.address() as AddressInfo).port}`;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.DBOS_ENABLED = 'true';
    delete process.env.DBOS_SYSTEM_DATABASE_URL;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    sleeper = http()
      .post('/api/runs')
      .send({
        plan: { id: 'plan-sleep', nodes: [{ kind: 'delay', id: 'pause', ms: PARK_MS }] },
        run_id: 'sleeper',
      })
      .then((res) => res);
    asker = http()
      .post('/api/runs')
      .send({
        plan: {
          id: 'plan-ask',
          nodes: [{ kind: 'waitForEvent', id: 'approve', topic: 'approval', timeoutMs: 120_000 }],
        },
        run_id: 'asker',
      })
      .then((res) => res);
    await until('sleeper', 'waiting');
    await until('asker', 'waiting');
    expect(await parkedOn('sleeper')).toEqual({ status: 'waiting', waiting_topic: 'orchestr:timer:pause' });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    await new Promise<void>((resolve, reject) => hitServer.close((e) => (e ? reject(e) : resolve())));
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
    process.env.DBOS_ENABLED = 'false';
  }, 60_000);

  it('stays out of the approvals inbox, which still lists a run waiting on a person', async () => {
    const ids = await inboxRunIds();
    expect(ids).toContain('asker');
    expect(ids).not.toContain('sleeper');
  });

  it('tells its reader it waits on its own clock, and an approval that it waits on a person', async () => {
    const sleeping = await until('sleeper', 'waiting');
    expect(sleeping.waiting).toEqual({ kind: 'timer', until: (await dueAt('sleeper')).toISOString() });
    const asking = await until('asker', 'waiting');
    expect(asking.waiting).toEqual({ kind: 'event', until: (await dueAt('asker')).toISOString() });
  });

  it('refuses any event sent to it, its own topic included, and it keeps waiting', async () => {
    for (const topic of ['orchestr:timer:pause', 'approval']) {
      const refused = await http().post('/api/runs/sleeper/events').send({ topic, payload: {} });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('timer_wait');
      expect(refused.body.detail).toMatch(
        /^Run sleeper is waiting until \d{4}-\d\d-\d\dT[\d:.]+Z, not for an event — it resumes on its own$/,
      );
    }
    expect(await parkedOn('sleeper')).toEqual({ status: 'waiting', waiting_topic: 'orchestr:timer:pause' });
    const detail = await until('sleeper', 'waiting');
    expect(detail.decided_by).toBeNull();
  });

  it('says a timer past its wake time was due then, never that it is waiting until a time gone by', async () => {
    const due = await dueAt('sleeper');
    await db.query(
      `UPDATE runtime_runs SET waiting_timeout_at = now() - interval '1 minute' WHERE run_id = $1`,
      ['sleeper'],
    );
    try {
      const refused = await http().post('/api/runs/sleeper/events').send({ topic: 'approval', payload: {} });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('timer_wait');
      expect(refused.body.detail).toMatch(
        /^Run sleeper was due at \d{4}-\d\d-\d\dT[\d:.]+Z, not waiting for an event — it resumes on its own$/,
      );
    } finally {
      await db.query(`UPDATE runtime_runs SET waiting_timeout_at = $2 WHERE run_id = $1`, ['sleeper', due]);
    }
  });

  it('refuses a raw plan that would park a person on a timer topic, sync or async, before any step runs', async () => {
    const plan = {
      id: 'plan-squat',
      nodes: [
        {
          kind: 'action',
          id: 'charge',
          actionId: 'http.send_request',
          props: { method: 'POST', url: `${hitUrl}/charge`, body: { amount: 100 } },
        },
        { kind: 'waitForEvent', id: 'approve', topic: 'orchestr:timer:x', timeoutMs: 3_000 },
      ],
    };

    for (const [route, runId] of [
      ['/api/runs', 'squatter'],
      ['/api/runs/async', 'async-squatter'],
    ] as const) {
      const refused = await http().post(route).send({ plan, run_id: runId });
      expect(refused.status).toBe(400);
      expect(refused.body).toEqual({
        code: 'compile_failed',
        run_id: runId,
        failed_node_id: null,
        steps: [],
        detail:
          'Workflow can\'t run: Wait for event "approve" can\'t use the topic "orchestr:timer:x" — it is reserved for timed waits',
      });
      expect(await parkedOn(runId)).toEqual({ status: 'error', waiting_topic: null });
      const recorded = await until(runId, 'error');
      expect(recorded.steps).toEqual([]);
      expect(recorded.waiting).toBeNull();
    }
    expect(posts).toBe(0);
  });

  it('still lets a person answer a run waiting on them', async () => {
    await http()
      .post('/api/runs/asker/events')
      .send({ topic: 'approval', payload: { decision: 'approved' } })
      .expect(200);
    const answered = await asker;
    expect(answered.status).toBe(201);
    expect(answered.body.outputs.approve).toEqual({ decision: 'approved' });
  });

  it(
    'wakes on its own when the time is up',
    async () => {
      const woke = await sleeper;
      expect(woke.status).toBe(201);
      const detail = await until('sleeper', 'completed');
      expect(detail.decided_by).toBeNull();
      expect(detail.waiting).toBeNull();
      const step = (detail.steps as Array<Record<string, unknown>>).find((s) => s.node_id === 'pause');
      expect(step).toMatchObject({ kind: 'delay', status: 'completed' });
      expect(await inboxRunIds()).not.toContain('sleeper');
    },
    PARK_MS + 30_000,
  );
});
