import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DbosRuntime } from '../src/dbos/dbos-runtime';
import { RunReaperService } from '../src/runs/run-reaper.service';
import { RunsService } from '../src/runs/runs.service';
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
  const unhandled: unknown[] = [];
  const collectUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  const hitsOn = (path: string): number => hits.get(path) ?? 0;
  const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  /** Answer every request a `/gate…` path is holding, so a step that was in flight can finish. */
  const openGate = (status = 200): void => {
    for (const res of held.splice(0)) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? '{"ok":true}' : '{"error":"refused"}');
    }
  };
  const get = (id: string, path: string) => ({
    kind: 'action',
    id,
    actionId: 'http.send_request',
    props: { method: 'GET', url: `${base}${path}` },
  });
  const post = (id: string, path: string, extra: Record<string, unknown> = {}) => ({
    kind: 'action',
    id,
    actionId: 'http.send_request',
    props: { method: 'POST', url: `${base}${path}`, body: {} },
    ...extra,
  });
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  /** Start a raw plan and leave it in flight; the answer settles only when the run does. */
  const start = (runId: string, nodes: unknown[]) =>
    http()
      .post('/api/runs')
      .send({ plan: { id: `plan-${runId}`, nodes }, run_id: runId })
      .then((res) => res);
  const cancel = (runId: string) => http().post(`/api/runs/${runId}/cancel`);
  const node = (id: string, nodeType: string, parameters: Record<string, unknown>) => ({
    id,
    name: id,
    node_type: nodeType,
    type_version: 1,
    parameters,
    position: { x: 0, y: 0 },
    metadata: {},
  });
  const edge = (from: string, to: string) => ({
    id: `${from}->${to}`,
    source_node_id: from,
    source_port: 0,
    target_node_id: to,
    target_port: 0,
    port_type: 'main',
  });
  const doc = (nodes: unknown[], edges: unknown[]) => ({
    version: '1.0',
    name: 'called by another',
    description: '',
    nodes,
    edges,
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  });
  /** Wait until some backend is blocked on a lock running a statement that matches `pattern`. */
  async function untilBlocked(pattern: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const rows = await db.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [pattern],
      );
      if (rows.rows.length > 0) return;
      await pause(25);
    }
    throw new Error(`nothing ever waited on ${pattern}`);
  }
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
      if (path.startsWith('/gate')) {
        held.push(res);
        return;
      }
      res.writeHead(path === '/flaky' ? 500 : 200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    process.on('unhandledRejection', collectUnhandled);
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
    process.off('unhandledRejection', collectUnhandled);
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

  it('a cancel after an error lane finished beside a parked wait unwinds the run as a cancel, so the wait reads Cancelled before it finished', async () => {
    const answer = start('lane-then-cancel', [
      {
        kind: 'parallel',
        id: 'fork',
        branches: [
          [post('laned', '/flaky', { onErrorBranch: [post('handler', '/handler')] })],
          [{ kind: 'waitForEvent', id: 'approval', topic: 'approval', timeoutMs: 120_000 }],
        ],
      },
    ]);
    await untilHit('/handler');
    await until('lane-then-cancel', 'waiting');
    await cancel('lane-then-cancel').expect(200);
    const res = await answer;

    const steps = stepsOf(await until('lane-then-cancel', 'cancelled'));
    expect({ answer: res.status, approval: steps.get('approval')?.error }).toEqual({
      answer: 409,
      approval: 'Cancelled before it finished',
    });
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

  it.each([
    [
      'a wait for an event',
      'wait',
      { kind: 'waitForEvent', id: 'next', topic: 'approval', timeoutMs: 120_000 },
    ],
    ['a delay that parks', 'park', { kind: 'delay', id: 'next', ms: 120_000 }],
  ])(
    'a cancel that lands just before %s never takes the service down',
    async (_what, shape, next) => {
      unhandled.length = 0;
      for (let round = 0; round < 3; round++) {
        const runId = `before-${shape}-${round}`;
        const answer = start(runId, [post('gate', '/gate'), next, post('after', '/after')]);
        await untilHit('/gate');
        await cancel(runId).expect(200);
        openGate();
        expect((await answer).body.code).toBe('run_cancelled');
        hits.clear();
      }
      await pause(200);
      expect({ unhandled: unhandled.map(String), afterCalls: hitsOn('/after') }).toEqual({
        unhandled: [],
        afterCalls: 0,
      });
    },
    60_000,
  );

  it('a step in flight at the cancel that then fails answers cancelled, as the row reads', async () => {
    const answer = start('fails-after', [post('gate', '/gate'), post('after', '/after')]);
    await untilHit('/gate');
    await cancel('fails-after').expect(200);
    openGate(500);
    const res = await answer;

    const detail = await until('fails-after', 'cancelled');
    expect({ answer: [res.status, res.body.code], gate: stepsOf(detail).get('gate')?.status }).toEqual({
      answer: [409, 'run_cancelled'],
      gate: 'error',
    });
  }, 60_000);

  it('a retrying step makes no attempt after the cancel', async () => {
    const answer = start('retrying', [
      post('flaky', '/flaky', { retry: { maxAttempts: 3, backoffMs: 1_500 } }),
      post('after', '/after'),
    ]);
    await untilHit('/flaky');
    await cancel('retrying').expect(200);
    const res = await answer;
    await pause(2_000);

    expect({ answer: res.body.code, flakyCalls: hitsOn('/flaky'), afterCalls: hitsOn('/after') }).toEqual({
      answer: 'run_cancelled',
      flakyCalls: 1,
      afterCalls: 0,
    });
  }, 60_000);

  it('a run id whose run was cancelled is not run again', async () => {
    const first = start('reused', approvalPlan('plan-reused').nodes);
    await until('reused', 'waiting');
    await cancel('reused').expect(200);
    await first;

    const again = await start('reused', [post('b1', '/b1')]);
    expect({ answer: [again.status, again.body.code], calls: hitsOn('/b1') }).toEqual({
      answer: [409, 'run_cancelled'],
      calls: 0,
    });
  }, 60_000);

  it("a cancel the finish overtook says completed, and the run's caller is told it completed too", async () => {
    const answer = start('finish-first', [post('gate', '/gate')]);
    await untilHit('/gate');
    const lock = new Client({ connectionString: process.env.DATABASE_URL });
    await lock.connect();
    try {
      await lock.query('BEGIN');
      await lock.query(`SELECT 1 FROM runtime_runs WHERE run_id = $1 FOR UPDATE`, ['finish-first']);
      openGate();
      await untilBlocked('%outputs = CAST%');
      const cancelling = cancel('finish-first').then((res) => res);
      await untilBlocked('%FROM runtime_runs WHERE id = $1 FOR NO KEY UPDATE%');
      await lock.query('COMMIT');
      const cancelled = await cancelling;
      const res = await answer;

      const row = await db.query(`SELECT status FROM runtime_runs WHERE run_id = $1`, ['finish-first']);
      expect({ cancel: cancelled.body.status, answer: res.status, row: row.rows[0].status }).toEqual({
        cancel: 'completed',
        answer: 201,
        row: 'completed',
      });
    } finally {
      await lock.query('ROLLBACK').catch(() => undefined);
      await lock.end();
    }
  }, 60_000);

  it('a run another run is calling cannot be cancelled on its own, and goes on untouched', async () => {
    const child = (
      await http()
        .post('/api/deploy')
        .send({
          workflow_json: doc(
            [
              node('trigger', 'orchestr:tool_trigger', {
                tool_name: 'gated',
                description: 'gated for the cancel suite',
                inputs: [{ name: 'q', type: 'string', description: 'unused', required: false }],
              }),
              node('gate', 'http.send_request', { method: 'POST', url: `${base}/gate-child`, body: {} }),
            ],
            [edge('trigger', 'gate')],
          ),
        })
        .expect(201)
    ).body.workflow_id as string;
    const answer = http()
      .post('/api/runs/from-ir')
      .send({
        run_id: 'caller-gated',
        workflow_ir: doc(
          [
            node('call', 'orchestr:call_workflow', { workflow_id: child }),
            node('after', 'http.send_request', { method: 'POST', url: `${base}/parent-after`, body: {} }),
          ],
          [edge('call', 'after')],
        ),
      })
      .then((res) => res);
    await untilHit('/gate-child');
    const called = await db.query<{ run_id: string }>(
      `SELECT r.run_id FROM runtime_runs r JOIN runtime_runs p ON p.id = r.parent_run_id WHERE p.run_id = $1`,
      ['caller-gated'],
    );
    const refused = await cancel(called.rows[0]!.run_id);
    openGate();
    const res = await answer;

    const row = await db.query(`SELECT status FROM runtime_runs WHERE run_id = $1`, [called.rows[0]!.run_id]);
    expect({
      refused: [refused.status, refused.body.code],
      answer: res.status,
      called: row.rows[0].status,
      afterCalls: hitsOn('/parent-after'),
    }).toEqual({ refused: [409, 'called_run'], answer: 201, called: 'completed', afterCalls: 1 });
  }, 60_000);

  it.each([
    ['source', 'lane'],
    ['target', 'main'],
  ])(
    'a pre-merge test whose run is cancelled has no result, and leaves the merge gate as it was, on the %s side',
    async (_side, gated) => {
      const trigger = node('trigger', 'orchestr:trigger', {});
      const announce = (text: string) => node('announce', 'text.concat', { texts: [text], separator: '' });
      const docOn = (branch: string, text: string) =>
        branch === gated
          ? doc(
              [
                trigger,
                node('gate', 'http.send_request', { method: 'POST', url: `${base}/gate-test`, body: {} }),
                announce(text),
              ],
              [edge('trigger', 'gate'), edge('gate', 'announce')],
            )
          : doc([trigger, announce(text)], [edge('trigger', 'announce')]);
      const wf = (
        await http()
          .post('/api/deploy')
          .send({ workflow_json: docOn('main', 'v1') })
          .expect(201)
      ).body.workflow_id as string;
      await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
      await http()
        .post(`/api/workflows/${wf}/commit`)
        .send({ workflow_ir: docOn('lane', 'lane'), branch: 'lane' })
        .expect(201);
      await http()
        .patch(`/api/workflows/${wf}/branches/main/protection`)
        .send({ is_protected: true })
        .expect(200);
      const review = (
        await http()
          .post(`/api/workflows/${wf}/reviews`)
          .send({ source_branch: 'lane', target_branch: 'main', title: 'lane → main' })
          .expect(201)
      ).body.id as string;
      await http()
        .post(`/api/workflows/${wf}/reviews/${review}/approve`)
        .send({ decision: 'approved' })
        .expect(201);
      const heads = await db.query<{ name: string; head_version_id: string }>(
        `SELECT name, head_version_id FROM workflow_branches WHERE workflow_id = $1`,
        [wf],
      );
      const head = (name: string) => heads.rows.find((r) => r.name === name)!.head_version_id;
      await db.query(
        `INSERT INTO review_test_results
           (id, workflow_id, review_id, source_version_id, target_version_id, verdict, decisive, tested_at, summary)
         VALUES ($1, $2, $3, $4, $5, 'green', true, now() - interval '1 minute', '{}'::json)`,
        [randomUUID(), wf, review, head('lane'), head('main')],
      );
      const shown = async () => {
        const body = (await http().get(`/api/workflows/${wf}/reviews/${review}`).expect(200)).body;
        return { blocked: body.merge_blocked_by_test, lastTest: body.last_test };
      };
      expect(await shown()).toEqual({ blocked: null, lastTest: null });

      const tested = http()
        .post(`/api/workflows/${wf}/reviews/${review}/test`)
        .send({ trigger_payload: {} })
        .then((res) => res);
      await untilHit('/gate-test');
      const run = await db.query<{ run_id: string }>(
        `SELECT r.run_id FROM runtime_runs r JOIN runtime_run_steps s ON s.run_id = r.id
          WHERE r.review_id = $1 AND s.node_id = 'gate'`,
        [review],
      );
      await cancel(run.rows[0]!.run_id).expect(200);
      openGate();
      const res = await tested;

      const kept = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM review_test_results WHERE workflow_id = $1`,
        [wf],
      );
      expect({ test: [res.status, res.body.code], kept: kept.rows[0]!.n, ...(await shown()) }).toEqual({
        test: [409, 'test_cancelled'],
        kept: 1,
        blocked: null,
        lastTest: null,
      });
    },
    60_000,
  );

  it('a cancel during a retry wait still records every attempt that went out', async () => {
    const answer = start('counted', [post('flaky', '/flaky', { retry: { maxAttempts: 6, backoffMs: 400 } })]);
    for (let i = 0; i < 200 && hitsOn('/flaky') < 3; i++) await pause(25);
    await cancel('counted').expect(200);
    await answer;
    await pause(1_000);

    const attempts = await db.query<{ attempts: number }>(
      `SELECT s.attempts FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id
        WHERE r.run_id = 'counted' AND s.node_id = 'flaky'`,
    );
    expect(attempts.rows[0]!.attempts).toBe(hitsOn('/flaky'));
  }, 60_000);

  /** Hold the next cancel inside its run-lock transaction, just before it tells DBOS. */
  const holdEngineCancel = () => {
    const engine = app.get(DbosRuntime);
    const real = engine.cancelWorkflow.bind(engine);
    let entered = false;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const spy = jest.spyOn(engine, 'cancelWorkflow').mockImplementationOnce(async (id: string) => {
      entered = true;
      await held;
      return real(id);
    });
    return {
      untilEntered: async () => {
        for (let i = 0; i < 200 && !entered; i++) await pause(25);
        if (!entered) throw new Error('the cancel never reached DBOS');
      },
      release: () => release(),
      restore: () => {
        release();
        spy.mockRestore();
      },
    };
  };
  const parkedOn = async (runId: string) =>
    (
      await db.query<{ status: string; parked: number }>(
        `SELECT r.status, (SELECT count(*)::int FROM runtime_run_steps s
                            WHERE s.run_id = r.id AND s.waiting_topic IS NOT NULL AND s.finished_at IS NULL) AS parked
           FROM runtime_runs r WHERE r.run_id = $1`,
        [runId],
      )
    ).rows[0];
  const approveThenAfter = () => [
    { kind: 'waitForEvent', id: 'approve', topic: 'approval', timeoutMs: 120_000 },
    post('after', '/after'),
  ];

  it('a cancel DBOS cannot be told of answers 500 and changes nothing: the run goes on and takes its decision', async () => {
    const failing = jest
      .spyOn(app.get(DbosRuntime), 'cancelWorkflow')
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    try {
      const answer = start('engine-down', approveThenAfter());
      await until('engine-down', 'waiting');
      const refused = await cancel('engine-down');
      const unchanged = await parkedOn('engine-down');
      await http()
        .post('/api/runs/engine-down/events')
        .send({ topic: 'approval', payload: { decision: 'yes' } })
        .expect(200);
      const res = await answer;

      expect({
        cancel: refused.status,
        unchanged,
        answer: [res.status, res.body.outputs?.approve],
        afterCalls: hitsOn('/after'),
      }).toEqual({
        cancel: 500,
        unchanged: { status: 'waiting', parked: 1 },
        answer: [201, { decision: 'yes' }],
        afterCalls: 1,
      });
    } finally {
      failing.mockRestore();
    }
  }, 60_000);

  it('a cancel retried once DBOS can be told stops the run', async () => {
    const failing = jest
      .spyOn(app.get(DbosRuntime), 'cancelWorkflow')
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    try {
      const answer = start('engine-back', approveThenAfter());
      await until('engine-back', 'waiting');
      const first = await cancel('engine-back');
      const second = await cancel('engine-back');
      const res = await answer;

      expect({
        cancels: [first.status, [second.status, second.body.status]],
        answer: res.body.code,
        afterCalls: hitsOn('/after'),
        row: await parkedOn('engine-back'),
      }).toEqual({
        cancels: [500, [200, 'cancelled']],
        answer: 'run_cancelled',
        afterCalls: 0,
        row: { status: 'cancelled', parked: 0 },
      });
    } finally {
      failing.mockRestore();
    }
  }, 60_000);

  it('a run whose last step finishes while its cancel holds the run lock ends cancelled, and its caller is told so', async () => {
    const hold = holdEngineCancel();
    try {
      const answer = start('cancel-first', [post('gate', '/gate')]);
      await untilHit('/gate');
      const cancelling = cancel('cancel-first').then((res) => res);
      await hold.untilEntered();
      openGate();
      await untilBlocked('%outputs = CAST%');
      hold.release();
      const cancelled = await cancelling;
      const res = await answer;

      const row = await db.query(`SELECT status, outputs FROM runtime_runs WHERE run_id = $1`, [
        'cancel-first',
      ]);
      expect({
        cancel: [cancelled.status, cancelled.body.status],
        answer: [res.status, res.body.code],
        row: row.rows[0],
      }).toEqual({
        cancel: [200, 'cancelled'],
        answer: [409, 'run_cancelled'],
        row: { status: 'cancelled', outputs: null },
      });
    } finally {
      hold.restore();
    }
  }, 60_000);

  it('a cancel holding the run lock while DBOS cancels deadlocks with nothing queued behind it', async () => {
    const deadlocks = async (): Promise<number> =>
      Number(
        (await db.query(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)).rows[0]
          .deadlocks,
      );
    const lockQueue = async (): Promise<number> =>
      (
        await db.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%FROM runtime_runs WHERE id = $1 FOR NO KEY UPDATE%'`,
        )
      ).rows.length;
    const hold = holdEngineCancel();
    try {
      const answer = start('crowded', [
        { kind: 'waitForEvent', id: 'approve', topic: 'approval', timeoutMs: 4_000 },
        post('after', '/after'),
      ]);
      await until('crowded', 'waiting');
      await pause(1_500);
      const before = await deadlocks();
      const cancelling = cancel('crowded').then((res) => res);
      await hold.untilEntered();
      // Behind the run's lock: a decision's claim, a reaper pass, and the run's own unpark when its wait runs out.
      const deciding = http()
        .post('/api/runs/crowded/events')
        .send({ topic: 'approval', payload: { decision: 'yes' } })
        .then((res) => res);
      await db.query(
        `UPDATE runtime_run_steps s SET waiting_timeout_at = now() - interval '1 hour'
           FROM runtime_runs r WHERE r.id = s.run_id AND r.run_id = 'crowded' AND s.waiting_topic IS NOT NULL`,
      );
      const reaping = app.get(RunReaperService).reapStale();
      for (let i = 0; i < 400 && (await lockQueue()) < 3; i++) await pause(25);
      const queued = await lockQueue();
      hold.release();
      const [cancelled, decided, reaped, res] = await Promise.all([cancelling, deciding, reaping, answer]);
      await pause(1_500);

      expect({
        queued,
        cancel: [cancelled.status, cancelled.body.status],
        decided: decided.status,
        lapsedReaped: reaped.timedOutWaits,
        answer: res.body.code,
        afterCalls: hitsOn('/after'),
        row: await parkedOn('crowded'),
        newDeadlocks: (await deadlocks()) - before,
      }).toEqual({
        queued: 3,
        cancel: [200, 'cancelled'],
        decided: 409,
        lapsedReaped: 0,
        answer: 'run_cancelled',
        afterCalls: 0,
        row: { status: 'cancelled', parked: 0 },
        newDeadlocks: 0,
      });
    } finally {
      hold.restore();
    }
  }, 60_000);

  it.each([
    ['a run the caller waits on', 'runDurably', 'window-sync'],
    ['a run started without waiting', 'startDurably', 'window-async'],
  ] as const)(
    'a cancel that lands before DBOS knows %s still stops it before any step',
    async (_what, method, runId) => {
      const engine = app.get(DbosRuntime);
      let entered = false;
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const real = engine[method].bind(engine) as (...args: unknown[]) => Promise<unknown>;
      const holding = jest.spyOn(engine, method).mockImplementationOnce((async (...args: unknown[]) => {
        entered = true;
        await held;
        return real(...args);
      }) as never);
      try {
        const nodes = [post('first', '/first'), post('second', '/second')];
        const answer = http()
          .post(method === 'runDurably' ? '/api/runs' : '/api/runs/async')
          .send({ plan: { id: `plan-${runId}`, nodes }, run_id: runId })
          .then((res) => res);
        for (let i = 0; i < 200 && !entered; i++) await pause(25);
        const cancelled = await cancel(runId).expect(200);
        release();
        await answer;
        await pause(1_000);

        const row = await db.query(`SELECT status FROM runtime_runs WHERE run_id = $1`, [runId]);
        expect({
          cancel: cancelled.body.status,
          calls: [hitsOn('/first'), hitsOn('/second')],
          row: row.rows[0].status,
        }).toEqual({ cancel: 'cancelled', calls: [0, 0], row: 'cancelled' });
      } finally {
        holding.mockRestore();
      }
    },
    60_000,
  );

  const parkedCount = async (runId: string): Promise<number> =>
    (
      await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id
          WHERE r.run_id = $1 AND s.waiting_topic IS NOT NULL AND s.finished_at IS NULL`,
        [runId],
      )
    ).rows[0]!.n;

  it('a cancel while two waits are parked ends both, and nothing after either runs', async () => {
    const wait = (id: string) =>
      node(id, 'orchestr:wait_for_event', { topic: 'approval', timeout_ms: 120_000 });
    const after = (id: string) =>
      node(id, 'http.send_request', { method: 'POST', url: `${base}/${id}`, body: {} });
    const answer = http()
      .post('/api/runs/from-ir')
      .send({
        run_id: 'two-parked',
        workflow_ir: doc(
          [wait('first'), wait('second'), after('after-first'), after('after-second')],
          [edge('first', 'after-first'), edge('second', 'after-second')],
        ),
      })
      .then((res) => res);
    for (let i = 0; i < 200 && (await parkedCount('two-parked')) < 2; i++) await pause(50);
    expect(await parkedCount('two-parked')).toBe(2);
    await cancel('two-parked').expect(200);
    const res = await answer;

    const detail = await until('two-parked', 'cancelled');
    const steps = stepsOf(detail);
    expect({
      answer: res.body.code,
      waits: [steps.get('first')?.error, steps.get('second')?.error],
      parked: await parkedCount('two-parked'),
      calls: [hitsOn('/after-first'), hitsOn('/after-second')],
    }).toEqual({
      answer: 'run_cancelled',
      waits: ['Cancelled before it finished', 'Cancelled before it finished'],
      parked: 0,
      calls: [0, 0],
    });
  }, 60_000);

  it('a cancel landing on a claimed decision before the run takes it: the decision stands as given, and the run takes nothing', async () => {
    const answer = start('claimed', [
      { kind: 'waitForEvent', id: 'approve', topic: 'approval', timeoutMs: 120_000 },
      post('after', '/after'),
    ]);
    await until('claimed', 'waiting');
    const engine = app.get(DbosRuntime);
    const send = engine.sendEvent.bind(engine);
    let cancelled: Response | undefined;
    const holding = jest
      .spyOn(engine, 'sendEvent')
      .mockImplementationOnce(async (runId: string, topic: string, payload: unknown, key?: string) => {
        cancelled = await cancel('claimed');
        await send(runId, topic, payload, key);
      });
    try {
      const decision = await http()
        .post('/api/runs/claimed/events')
        .send({ topic: 'approval', payload: { decision: 'yes' } });
      const res = await answer;
      await pause(1_000);
      const resent = await app.get(RunsService).resendClaims(0);

      const row = await db.query(
        `SELECT r.status, r.decided_by,
                (SELECT count(*)::int FROM runtime_run_steps s WHERE s.run_id = r.id AND s.waiting_topic IS NOT NULL) AS parked,
                (SELECT count(*)::int FROM runtime_run_steps s WHERE s.run_id = r.id AND s.claimed_at IS NOT NULL) AS claimed
           FROM runtime_runs r WHERE r.run_id = 'claimed'`,
      );
      expect({
        decision: decision.status,
        cancel: [cancelled?.status, cancelled?.body.status],
        answer: res.body.code,
        afterCalls: hitsOn('/after'),
        resent,
        row: row.rows[0],
      }).toEqual({
        decision: 200,
        cancel: [200, 'cancelled'],
        answer: 'run_cancelled',
        afterCalls: 0,
        resent: 0,
        row: { status: 'cancelled', decided_by: null, parked: 0, claimed: 0 },
      });
    } finally {
      holding.mockRestore();
    }
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
