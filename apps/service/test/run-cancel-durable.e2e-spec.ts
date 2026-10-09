import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** Cancel as the containers run it — DBOS on AND run history on, the pairing no other suite boots. */
describe('cancel a durable run (e2e, isolated DB, DBOS on, mock auth)', () => {
  let app: INestApplication;

  const approvalPlan = (id: string) => ({
    id,
    nodes: [{ kind: 'waitForEvent', id: 'approve', topic: 'approval', timeoutMs: 120_000 }],
  });

  /** Poll the run until it reaches `status` — the sync call that started it is still open. */
  async function until(runId: string, status: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 100; i++) {
      const res = await request(app.getHttpServer()).get(`/api/runs/${runId}`);
      if (res.status === 200 && res.body.status === status) return res.body as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`run ${runId} never reached "${status}"`);
  }

  let db: Client;
  let server: Server;
  let base = '';
  const hits = new Map<string, number>();
  const held: ServerResponse[] = [];
  const hitsOn = (path: string): number => hits.get(path) ?? 0;
  /** Answer every request `/gate` is holding, so a step that was in flight can finish. */
  const openGate = (): void => {
    for (const res of held.splice(0)) res.end('{"ok":true}');
  };
  const get = (id: string, path: string) => ({
    kind: 'action',
    id,
    actionId: 'http.send_request',
    props: { method: 'GET', url: `${base}${path}` },
  });
  async function untilHit(path: string): Promise<void> {
    for (let i = 0; i < 200 && hitsOn(path) === 0; i++) await new Promise((r) => setTimeout(r, 25));
    if (hitsOn(path) === 0) throw new Error(`never saw a request on ${path}`);
  }
  const stepsOf = (detail: Record<string, unknown>) =>
    new Map(
      (detail.steps as Array<{ node_id: string; status: string; error: string | null }>).map((s) => [
        s.node_id,
        s,
      ]),
    );

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://local').pathname;
      hits.set(path, hitsOn(path) + 1);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (path === '/gate') held.push(res);
      else res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
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
  }, 60_000);

  afterEach(() => {
    openGate();
    hits.clear();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await db.end();
    await app.close();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
    process.env.DBOS_ENABLED = 'false';
  }, 60_000);

  it('a run cancelled while it waits is recorded as cancelled — the unwinding is not a failure', async () => {
    const parked = request(app.getHttpServer())
      .post('/api/runs')
      .send({ plan: approvalPlan('plan-cancel'), run_id: 'cancel-me' })
      .then((res) => res);
    await until('cancel-me', 'waiting');

    const cancel = await request(app.getHttpServer()).post('/api/runs/cancel-me/cancel').expect(200);
    expect(cancel.body.status).toBe('cancelled');

    // The caller that was waiting on the run is told what happened to it, without an engine id.
    const answer = await parked;
    expect(answer.status).toBe(409);
    expect(answer.body.detail).toBe('Run cancel-me was cancelled');
    expect(answer.body.code).toBe('run_cancelled');

    const detail = await until('cancel-me', 'cancelled');
    expect(detail.error ?? null).toBeNull();
    const step = (detail.steps as Array<{ node_id: string; error: string | null }>)[0]!;
    expect(step).toMatchObject({ node_id: 'approve', error: 'Cancelled before it finished' });

    const list = await request(app.getHttpServer()).get('/api/runs').expect(200);
    const row = (list.body.runs as Array<{ run_id: string; status: string; error: string | null }>).find(
      (r) => r.run_id === 'cancel-me',
    );
    expect(row).toMatchObject({ status: 'cancelled', error: null });
  }, 60_000);

  it('a run cancelled mid-step finishes that step, then starts no other', async () => {
    const answer = request(app.getHttpServer())
      .post('/api/runs')
      .send({
        plan: { id: 'plan-mid', nodes: [get('gate', '/gate'), get('after', '/after')] },
        run_id: 'mid-step',
      })
      .then((res) => res);
    await untilHit('/gate');
    await request(app.getHttpServer()).post('/api/runs/mid-step/cancel').expect(200);
    openGate();
    const res = await answer;

    const detail = await until('mid-step', 'cancelled');
    const steps = stepsOf(detail);
    expect({
      answer: res.body.code,
      afterCalls: hitsOn('/after'),
      gate: steps.get('gate')?.status,
      after: steps.get('after')?.error,
    }).toEqual({
      answer: 'run_cancelled',
      afterCalls: 0,
      gate: 'completed',
      after: 'Cancelled before it finished',
    });
  }, 60_000);

  it('a run cancelled during its last step ends cancelled, never completed', async () => {
    const answer = request(app.getHttpServer())
      .post('/api/runs')
      .send({ plan: { id: 'plan-last', nodes: [get('gate', '/gate')] }, run_id: 'last-step' })
      .then((res) => res);
    await untilHit('/gate');
    await request(app.getHttpServer()).post('/api/runs/last-step/cancel').expect(200);
    openGate();
    const res = await answer;

    const row = await db.query(`SELECT status, outputs FROM runtime_runs WHERE run_id = $1`, ['last-step']);
    expect({ answer: res.body.code, row: row.rows[0] }).toEqual({
      answer: 'run_cancelled',
      row: { status: 'cancelled', outputs: null },
    });
  }, 60_000);

  it('a dry run, which runs in-process even with DBOS on, is cancelled at its next step', async () => {
    const answer = request(app.getHttpServer())
      .post('/api/runs')
      .send({
        plan: { id: 'plan-dry', nodes: [get('gate', '/gate'), get('after', '/after')] },
        run_id: 'dry-cancel',
        dry_run: true,
      })
      .then((res) => res);
    await untilHit('/gate');
    const cancelled = await request(app.getHttpServer()).post('/api/runs/dry-cancel/cancel');
    openGate();
    const res = await answer;

    const detail = await until('dry-cancel', 'cancelled');
    expect({
      cancel: [cancelled.status, cancelled.body.status],
      answer: res.body.code,
      afterCalls: hitsOn('/after'),
      after: stepsOf(detail).get('after')?.error,
    }).toEqual({
      cancel: [200, 'cancelled'],
      answer: 'run_cancelled',
      afterCalls: 0,
      after: 'Cancelled before it finished',
    });
  }, 60_000);

  it('a run that fails on its own is still recorded as a failure', async () => {
    const plan = {
      id: 'plan-fail',
      nodes: [{ kind: 'code', id: 'boom', language: 'js', code: 'throw new Error("no such thing");' }],
    };
    const res = await request(app.getHttpServer()).post('/api/runs').send({ plan, run_id: 'fails-alone' });
    expect(res.body.code).not.toBe('run_cancelled');

    const detail = await until('fails-alone', 'error');
    expect(String(detail.error)).toContain('no such thing');
  }, 60_000);

  it('a run the caller can no longer reach answers not_found, never its stored result from the engine', async () => {
    const plan = {
      id: 'plan-reach',
      nodes: [{ kind: 'code', id: 'answer', language: 'js', code: 'return { secret: 42 };' }],
    };
    await request(app.getHttpServer()).post('/api/runs').send({ plan, run_id: 'out-of-reach' }).expect(201);
    expect((await until('out-of-reach', 'completed')).outputs).toBeTruthy();

    // The run now belongs to an org the caller is not in, as after leaving it.
    await db.query(`UPDATE runtime_runs SET org_id = $2 WHERE run_id = $1`, ['out-of-reach', randomUUID()]);

    const refused = await request(app.getHttpServer()).get('/api/runs/out-of-reach').expect(200);
    expect(refused.body.status).toBe('not_found');
    expect(refused.body.outputs ?? null).toBeNull();
  }, 60_000);
});
