import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { mintSession } from '../src/auth/local/local-session';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const CANCELLED_STEP = 'Cancelled before it finished';

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
async function untilHitShared(path: string): Promise<void> {
  for (let i = 0; i < 200 && hitsOn(path) === 0; i++) await pause(25);
  if (hitsOn(path) === 0) throw new Error(`never saw a request on ${path}`);
}

/** Answer every request a `/gate…` path is holding, so a step that was in flight can finish. */
const openGate = (status = 200): void => {
  for (const res of held.splice(0)) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 200 ? '{"ok":true}' : '{"error":"refused"}');
  }
};

/** A local endpoint counting hits per path: `/gate…` holds its answer, `/flaky` always fails. */
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
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.on('unhandledRejection', collectUnhandled);
});

afterEach(() => {
  openGate();
  hits.clear();
});

const node = (id: string, nodeType: string, parameters: Record<string, unknown>) => ({
  id,
  name: id,
  node_type: nodeType,
  type_version: 1,
  parameters,
  position: { x: 0, y: 0 },
  metadata: {},
});
const post = (id: string, path: string, extra: Record<string, unknown> = {}) =>
  node(id, 'http.send_request', { method: 'POST', url: `${base}${path}`, body: {}, ...extra });
const waitFor = (id: string, timeoutMs: number) =>
  node(id, 'orchestr:wait_for_event', { topic: 'approval', timeout_ms: timeoutMs });
const edge = (from: string, to: string, portType = 'main') => ({
  id: `${from}->${to}`,
  source_node_id: from,
  source_port: 0,
  target_node_id: to,
  target_port: 0,
  port_type: portType,
});
const ir = (nodes: unknown[], edges: unknown[]) => ({
  version: '1.0',
  name: 'cancel in process',
  description: '',
  nodes,
  edges,
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
});

afterAll(async () => {
  process.off('unhandledRejection', collectUnhandled);
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

interface StepRow {
  node_id: string;
  status: string;
  error: string | null;
  continued: boolean;
  output: unknown;
}

/** Cancel with DBOS off: the in-process run must stop at its next step boundary, as a durable one does. */
describe('cancel an in-process run (e2e, isolated DB, DBOS off, mock auth)', () => {
  let app: INestApplication;
  let db: Client;

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  /** Start a run and leave it in flight; the answer settles only when the run does. */
  const start = (runId: string, workflowIr: unknown) =>
    http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: workflowIr, run_id: runId })
      .then((res) => res);

  const detail = async (runId: string) => {
    const res = await http().get(`/api/runs/${runId}`).expect(200);
    const steps = new Map((res.body.steps as StepRow[]).map((s) => [s.node_id, s]));
    return { body: res.body as Record<string, unknown>, steps };
  };

  async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await pause(25);
    }
    throw new Error(`never saw ${what}`);
  }
  const untilStatus = (runId: string, status: string) =>
    until(async () => (await detail(runId)).body.status === status, `${runId} ${status}`);
  const untilStepRunning = (runId: string, nodeId: string) =>
    until(async () => (await detail(runId)).steps.get(nodeId)?.status === 'running', `${nodeId} running`);
  const untilHit = (path: string) => until(() => hitsOn(path) > 0, `a request on ${path}`);

  const cancel = (runId: string) => http().post(`/api/runs/${runId}/cancel`);
  const decide = (runId: string, decision: string) =>
    http().post(`/api/runs/${runId}/events`).send({ topic: 'approval', payload: { decision } });

  beforeAll(async () => {
    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
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
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  it('a run cancelled while it waits never runs the step after the wait, even once the wait would have timed out', async () => {
    const answer = start(
      'parked',
      ir([waitFor('approval', 1_500), post('after', '/after')], [edge('approval', 'after')]),
    );
    await untilStatus('parked', 'waiting');
    const cancelled = await cancel('parked').expect(200);
    const res = await answer;
    await pause(2_000);

    const { body, steps } = await detail('parked');
    expect({
      cancel: cancelled.body.status,
      answer: res.status,
      code: res.body.code,
      afterCalls: hitsOn('/after'),
      status: body.status,
      error: body.error ?? null,
      approval: steps.get('approval')?.error,
      afterStep: steps.has('after'),
    }).toEqual({
      cancel: 'cancelled',
      answer: 409,
      code: 'run_cancelled',
      afterCalls: 0,
      status: 'cancelled',
      error: null,
      approval: CANCELLED_STEP,
      afterStep: false,
    });
  }, 30_000);

  it('a run cancelled mid-step finishes that step, then starts no other', async () => {
    const answer = start(
      'mid-step',
      ir([post('gate', '/gate'), post('after', '/after')], [edge('gate', 'after')]),
    );
    await untilHit('/gate');
    const cancelled = await cancel('mid-step').expect(200);
    openGate();
    const res = await answer;

    const { body, steps } = await detail('mid-step');
    expect({
      cancel: cancelled.body.status,
      answer: res.status,
      code: res.body.code,
      afterCalls: hitsOn('/after'),
      status: body.status,
      gate: steps.get('gate')?.status,
      after: steps.get('after')?.error,
    }).toEqual({
      cancel: 'cancelled',
      answer: 409,
      code: 'run_cancelled',
      afterCalls: 0,
      status: 'cancelled',
      gate: 'completed',
      after: CANCELLED_STEP,
    });
  }, 30_000);

  it('a run cancelled during its last step ends cancelled, never completed', async () => {
    const answer = start('last-step', ir([post('gate', '/gate')], []));
    await untilHit('/gate');
    await cancel('last-step').expect(200);
    openGate();
    const res = await answer;

    const { body, steps } = await detail('last-step');
    expect({
      answer: res.status,
      code: res.body.code,
      status: body.status,
      outputs: body.outputs ?? null,
      gate: steps.get('gate')?.status,
    }).toEqual({ answer: 409, code: 'run_cancelled', status: 'cancelled', outputs: null, gate: 'completed' });
  }, 30_000);

  it('a cancel is not a failure for continue-on-fail or an error lane to absorb', async () => {
    const answer = start(
      'policies',
      ir(
        [
          post('gate', '/gate'),
          post('tolerant', '/tolerant', { onError: 'continue' }),
          post('final', '/final'),
          post('laned', '/laned'),
          post('handler', '/handler'),
        ],
        [
          edge('gate', 'tolerant'),
          edge('tolerant', 'final'),
          edge('gate', 'laned'),
          edge('laned', 'handler', 'error'),
        ],
      ),
    );
    await untilHit('/gate');
    await cancel('policies').expect(200);
    openGate();
    const res = await answer;

    const { body, steps } = await detail('policies');
    expect({
      answer: res.status,
      status: body.status,
      calls: ['/tolerant', '/final', '/laned', '/handler'].map(hitsOn),
      tolerantContinued: steps.get('tolerant')?.continued,
      lanedContinued: steps.get('laned')?.continued,
      handlerStep: steps.has('handler'),
      finalStep: steps.has('final'),
    }).toEqual({
      answer: 409,
      status: 'cancelled',
      calls: [0, 0, 0, 0],
      tolerantContinued: false,
      lanedContinued: false,
      handlerStep: false,
      finalStep: false,
    });
  }, 30_000);

  it.each([
    ['sleeps in place', 1],
    ['parks on its timer', 2],
  ])(
    'a run cancelled during a delay that %s ends at once',
    async (_how, minutes) => {
      const runId = `delay-${minutes}`;
      const answer = start(
        runId,
        ir(
          [
            node('hold', 'orchestr:wait_for_duration', { amount: minutes, unit: 'minutes' }),
            post('after', '/after'),
          ],
          [edge('hold', 'after')],
        ),
      );
      await untilStepRunning(runId, 'hold');
      const startedAt = Date.now();
      await cancel(runId).expect(200);
      const res = await answer;

      const { body, steps } = await detail(runId);
      expect({
        answer: res.status,
        promptly: Date.now() - startedAt < 5_000,
        afterCalls: hitsOn('/after'),
        status: body.status,
        hold: steps.get('hold')?.error,
      }).toEqual({ answer: 409, promptly: true, afterCalls: 0, status: 'cancelled', hold: CANCELLED_STEP });
    },
    30_000,
  );

  it('a decision delivered before the cancel resumes the run, which the cancel then stops at its next step', async () => {
    const answer = start(
      'decided-first',
      ir(
        [waitFor('approval', 30_000), post('gate', '/gate'), post('after', '/after')],
        [edge('approval', 'gate'), edge('gate', 'after')],
      ),
    );
    await untilStatus('decided-first', 'waiting');
    await decide('decided-first', 'yes').expect(200);
    await untilHit('/gate');
    await cancel('decided-first').expect(200);
    openGate();
    const res = await answer;

    const { body, steps } = await detail('decided-first');
    expect({
      answer: res.status,
      status: body.status,
      decided: body.decided_by !== null,
      approval: [steps.get('approval')?.status, steps.get('approval')?.output],
      afterCalls: hitsOn('/after'),
    }).toEqual({
      answer: 409,
      status: 'cancelled',
      decided: true,
      approval: ['completed', { decision: 'yes' }],
      afterCalls: 0,
    });
  }, 30_000);

  it('a decision sent after the cancel is refused', async () => {
    const answer = start(
      'cancelled-first',
      ir([waitFor('approval', 30_000), post('after', '/after')], [edge('approval', 'after')]),
    );
    await untilStatus('cancelled-first', 'waiting');
    await cancel('cancelled-first').expect(200);
    const decision = await decide('cancelled-first', 'yes');
    const res = await answer;

    const { body } = await detail('cancelled-first');
    expect({
      decision: decision.status,
      answer: res.status,
      status: body.status,
      decided: body.decided_by !== null,
      afterCalls: hitsOn('/after'),
    }).toEqual({ decision: 409, answer: 409, status: 'cancelled', decided: false, afterCalls: 0 });
  }, 30_000);

  it('a decision and a cancel sent together: the wait ends exactly once, and the run ends cancelled', async () => {
    for (let i = 0; i < 12; i++) {
      const runId = `race-${i}`;
      const answer = start(
        runId,
        ir(
          [waitFor('approval', 30_000), post('gate', '/gate'), post('after', '/after')],
          [edge('approval', 'gate'), edge('gate', 'after')],
        ),
      );
      await untilStatus(runId, 'waiting');
      // Alternate which goes out first and by how much, so both orders actually occur.
      const lead = (i % 3) * 2;
      const [decision, cancelled] = await Promise.all(
        i % 2 === 0
          ? [decide(runId, 'yes').then((r) => r), pause(lead).then(() => cancel(runId))]
          : [pause(lead).then(() => decide(runId, 'yes')), cancel(runId).then((r) => r)],
      );
      const releasing = setInterval(openGate, 20);
      const res = await answer.finally(() => clearInterval(releasing));

      const { body, steps } = await detail(runId);
      const approval = steps.get('approval');
      const delivered = decision.status === 200;
      expect({
        decision: delivered ? 200 : [decision.status, decision.body.detail],
        cancel: cancelled.status,
        answer: res.status,
        status: body.status,
        decided: body.decided_by !== null,
        approval: delivered ? [approval?.status, approval?.output] : [approval?.status, approval?.error],
        afterCalls: hitsOn('/after'),
      }).toEqual({
        decision: delivered ? 200 : [409, `Run ${runId} is not waiting for an event`],
        cancel: 200,
        answer: 409,
        status: 'cancelled',
        decided: delivered,
        approval: delivered ? ['completed', { decision: 'yes' }] : ['error', CANCELLED_STEP],
        afterCalls: 0,
      });
      hits.clear();
    }
  }, 120_000);

  it.each([
    ['a wait for an event', 'before-wait', () => waitFor('next', 30_000)],
    [
      'a delay that parks',
      'before-park',
      () => node('next', 'orchestr:wait_for_duration', { amount: 2, unit: 'minutes' }),
    ],
  ])(
    'a cancel that lands just before %s never takes the service down',
    async (_what, runId, next) => {
      unhandled.length = 0;
      const answer = start(
        runId,
        ir(
          [post('gate', '/gate'), next(), post('after', '/after')],
          [edge('gate', 'next'), edge('next', 'after')],
        ),
      );
      await untilHit('/gate');
      await cancel(runId).expect(200);
      openGate();
      const res = await answer;
      await pause(100);

      const { body, steps } = await detail(runId);
      expect({
        unhandled: unhandled.map(String),
        answer: res.body.code,
        status: body.status,
        next: steps.get('next')?.error,
        afterCalls: hitsOn('/after'),
      }).toEqual({
        unhandled: [],
        answer: 'run_cancelled',
        status: 'cancelled',
        next: CANCELLED_STEP,
        afterCalls: 0,
      });
    },
    30_000,
  );

  it.each([
    ['no failure policy', 'fails-plain', {}, false],
    ['continue-on-fail', 'fails-tolerated', { onError: 'continue' }, false],
    ['an error lane', 'fails-laned', {}, true],
  ])(
    'a step in flight at the cancel that then fails answers cancelled, as the row reads, with %s',
    async (_policy, runId, extra, laned) => {
      const nodes = [post('gate', '/gate', extra), post('after', '/after'), post('handler', '/handler')];
      const edges = [edge('gate', 'after'), ...(laned ? [edge('gate', 'handler', 'error')] : [])];
      const answer = start(runId, ir(laned ? nodes : nodes.slice(0, 2), edges));
      await untilHit('/gate');
      await cancel(runId).expect(200);
      openGate(500);
      const res = await answer;

      const { body, steps } = await detail(runId);
      expect({
        answer: [res.status, res.body.code],
        status: body.status,
        gate: [steps.get('gate')?.status, steps.get('gate')?.continued],
        handlerStep: steps.has('handler'),
        calls: [hitsOn('/after'), hitsOn('/handler')],
      }).toEqual({
        answer: [409, 'run_cancelled'],
        status: 'cancelled',
        gate: ['error', false],
        handlerStep: false,
        calls: [0, 0],
      });
    },
    30_000,
  );

  it('a pinned step after the cancel does not replay', async () => {
    const answer = http()
      .post('/api/runs/from-ir')
      .send({
        run_id: 'pinned',
        pins: { replayed: { from: 'a pin' } },
        workflow_ir: ir(
          [post('gate', '/gate'), post('replayed', '/replayed'), post('after', '/after')],
          [edge('gate', 'replayed'), edge('replayed', 'after')],
        ),
      })
      .then((res) => res);
    await untilHit('/gate');
    await cancel('pinned').expect(200);
    openGate();
    const res = await answer;

    const { steps } = await detail('pinned');
    expect({
      answer: res.body.code,
      replayed: [steps.get('replayed')?.status, steps.get('replayed')?.error],
      calls: [hitsOn('/replayed'), hitsOn('/after')],
    }).toEqual({ answer: 'run_cancelled', replayed: ['error', CANCELLED_STEP], calls: [0, 0] });
  }, 30_000);

  it('a retrying step makes no attempt after the cancel, and the run does not wait out its backoff', async () => {
    const answer = start(
      'retrying',
      ir(
        [post('flaky', '/flaky', { retry: { maxAttempts: 4, backoffMs: 3_000 } }), post('after', '/after')],
        [edge('flaky', 'after')],
      ),
    );
    await untilHit('/flaky');
    const cancelledAt = Date.now();
    await cancel('retrying').expect(200);
    const res = await answer;
    const answeredIn = Date.now() - cancelledAt;
    await pause(3_500);

    const { body } = await detail('retrying');
    expect({
      answer: res.body.code,
      promptly: answeredIn < 1_500,
      flakyCalls: hitsOn('/flaky'),
      afterCalls: hitsOn('/after'),
      status: body.status,
    }).toEqual({
      answer: 'run_cancelled',
      promptly: true,
      flakyCalls: 1,
      afterCalls: 0,
      status: 'cancelled',
    });
  }, 30_000);

  it('a cancel during a retry wait still records every attempt that went out', async () => {
    const answer = start(
      'counted',
      ir([post('flaky', '/flaky', { retry: { maxAttempts: 6, backoffMs: 400 } })], []),
    );
    await until(() => hitsOn('/flaky') >= 3, 'three attempts');
    await cancel('counted').expect(200);
    await answer;
    await pause(500);

    const attempts = await db.query<{ attempts: number }>(
      `SELECT s.attempts FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id
        WHERE r.run_id = 'counted' AND s.node_id = 'flaky'`,
    );
    expect({ recorded: attempts.rows[0]!.attempts, sent: hitsOn('/flaky') }).toEqual({
      recorded: hitsOn('/flaky'),
      sent: hitsOn('/flaky'),
    });
  }, 30_000);

  it('a run id whose run was cancelled is not run again', async () => {
    const first = start('reused', ir([waitFor('approval', 30_000)], []));
    await untilStatus('reused', 'waiting');
    await cancel('reused').expect(200);
    await first;

    const again = await start('reused', ir([post('b1', '/b1')], []));
    expect({ answer: [again.status, again.body.code], calls: hitsOn('/b1') }).toEqual({
      answer: [409, 'run_cancelled'],
      calls: 0,
    });
  }, 30_000);

  it('a parallel run lets every branch settle before it unwinds', async () => {
    const action = (id: string, path: string) => ({
      kind: 'action',
      id,
      actionId: 'http.send_request',
      props: { method: 'POST', url: `${base}${path}`, body: {} },
    });
    const plan = {
      id: 'plan-fork',
      nodes: [
        {
          kind: 'parallel',
          id: 'fork',
          branches: [
            [action('gate', '/gate'), action('afterGate', '/after-gate')],
            [{ kind: 'delay', id: 'nap', ms: 30_000 }],
          ],
        },
      ],
    };
    let answered = false;
    const answer = http()
      .post('/api/runs')
      .send({ plan, run_id: 'fork' })
      .then((res) => {
        answered = true;
        return res;
      });
    await untilHit('/gate');
    await cancel('fork').expect(200);
    await pause(300);
    const answeredWhileGateHeld = answered;
    openGate();
    const res = await answer;

    const { steps } = await detail('fork');
    expect({
      answeredWhileGateHeld,
      answer: res.body.code,
      afterGate: steps.get('afterGate')?.error,
      calls: hitsOn('/after-gate'),
    }).toEqual({
      answeredWhileGateHeld: false,
      answer: 'run_cancelled',
      afterGate: CANCELLED_STEP,
      calls: 0,
    });
  }, 30_000);

  it('a pre-merge test whose run is cancelled has no result, and leaves the merge gate as it was', async () => {
    const trigger = node('trigger', 'orchestr:trigger', {});
    const announce = (text: string) => node('announce', 'text.concat', { texts: [text], separator: '' });
    const mainDoc = ir([trigger, announce('v1')], [edge('trigger', 'announce')]);
    const laneDoc = ir(
      [trigger, post('gate', '/gate-test'), announce('lane')],
      [edge('trigger', 'gate'), edge('gate', 'announce')],
    );
    const wf = (await http().post('/api/deploy').send({ workflow_json: mainDoc }).expect(201)).body
      .workflow_id as string;
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: laneDoc, branch: 'lane' })
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
    const blocked = async () =>
      (await http().get(`/api/workflows/${wf}/reviews/${review}`).expect(200)).body.merge_blocked_by_test;
    expect(await blocked()).toBeNull();

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
    expect({ test: [res.status, res.body.code], kept: kept.rows[0]!.n, blocked: await blocked() }).toEqual({
      test: [409, 'test_cancelled'],
      kept: 1,
      blocked: null,
    });
  }, 30_000);
});

/**
 * The window chance timing rarely hits: another member's decision has read the run as waiting when the
 * owner's cancel lands. The approver's own reach check is held on a lock, so the cancel lands exactly there.
 */
describe('a cancel landing mid-decision (e2e, isolated DB, DBOS off, local sessions)', () => {
  const SECRET = 'run-cancel-in-process-secret';
  let app: INestApplication;
  let db: Client;
  const owner = randomUUID();
  const approver = randomUUID();
  const orgId = randomUUID();
  let asOwner = '';
  let asApprover = '';

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const inOrg = (r: request.Test, token: string): request.Test =>
    r.set('Authorization', `Bearer ${token}`).set('X-Org-Id', orgId);

  const approvalIr = {
    version: '1.0',
    name: 'mid-decision cancel',
    description: '',
    nodes: [
      {
        id: 'approval',
        name: 'approval',
        node_type: 'orchestr:wait_for_event',
        type_version: 1,
        parameters: { topic: 'approval', timeout_ms: 30_000 },
        position: { x: 0, y: 0 },
        metadata: {},
      },
    ],
    edges: [],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'owner@e2e.local', 'Owner', now(), now()), ($2, 'approver@e2e.local', 'Approver', now(), now())`,
      [owner, approver],
    );
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Acme', false, now(), now())`,
      [orgId],
    );
    await db.query(
      `INSERT INTO org_members (id, org_id, user_id, role, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'owner', now()), (gen_random_uuid(), $1, $3, 'member', now())`,
      [orgId, owner, approver],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DBOS_ENABLED = 'false';
    process.env.SECRET_KEY = SECRET;
    asOwner = (await mintSession(owner, SECRET)).token;
    asApprover = (await mintSession(approver, SECRET)).token;

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

  /** Start the owner's run of a fresh workflow and read its unique handle off the approver's inbox. */
  async function parkedRun(): Promise<{ runRef: string; answer: Promise<request.Response> }> {
    const deployed = await inOrg(http().post('/api/deploy'), asOwner)
      .send({ workflow_json: approvalIr })
      .expect(201);
    const workflowId = deployed.body.workflow_id as string;
    const answer = inOrg(http().post('/api/runs/from-ir'), asOwner)
      .send({ workflow_ir: approvalIr, workflow_id: workflowId })
      .then((res) => res);
    for (let i = 0; i < 200; i++) {
      const inbox = await inOrg(http().get('/api/runs/waiting'), asApprover).expect(200);
      const row = (inbox.body.runs as Array<{ id: string; workflow_id: string }>).find(
        (r) => r.workflow_id === workflowId,
      );
      if (row) return { runRef: row.id, answer };
      await pause(25);
    }
    throw new Error('the run never parked');
  }

  /**
   * Hold the approver's `request` on its own reach check — the one read of `workflows`, made after it read
   * the run — then run `meanwhile` before letting it go on with what it read.
   */
  async function heldOnReach(
    request: () => Promise<request.Response>,
    meanwhile: () => Promise<void>,
  ): Promise<request.Response> {
    const lock = new Client({ connectionString: process.env.DATABASE_URL });
    await lock.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE workflows IN ACCESS EXCLUSIVE MODE');
      const held = request();
      let blocked = false;
      for (let i = 0; i < 200 && !blocked; i++) {
        const rows = await db.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT 1 FROM workflows WHERE id = $1 AND org_id = $2%'`,
        );
        blocked = rows.rows.length > 0;
        if (!blocked) await pause(25);
      }
      expect(blocked).toBe(true);
      await meanwhile();
      await lock.query('COMMIT');
      return await held;
    } finally {
      await lock.query('ROLLBACK').catch(() => undefined);
      await lock.end();
    }
  }

  it('a decision the cancel overtook is refused as not waiting, never blamed on a restart', async () => {
    const { runRef, answer } = await parkedRun();
    const ref = encodeURIComponent(runRef);

    const refused = await heldOnReach(
      () =>
        inOrg(http().post(`/api/runs/${ref}/events`), asApprover)
          .send({ topic: 'approval', payload: { decision: 'yes' } })
          .then((res) => res),
      async () => {
        await inOrg(http().post(`/api/runs/${ref}/cancel`), asOwner).expect(200);
        expect((await answer).body.code).toBe('run_cancelled');
      },
    );

    const run = await inOrg(http().get(`/api/runs/${ref}`), asOwner).expect(200);
    expect({
      decision: [refused.status, refused.body.detail],
      status: run.body.status,
      decided: run.body.decided_by !== null,
    }).toEqual({
      decision: [409, `Run ${runRef} is not waiting for an event`],
      status: 'cancelled',
      decided: false,
    });
  }, 30_000);

  it('a cancel the finish overtook says the run completed, and the run keeps that outcome', async () => {
    const { runRef, answer } = await parkedRun();
    const ref = encodeURIComponent(runRef);

    let finished: request.Response | undefined;
    const cancelled = await heldOnReach(
      () => inOrg(http().post(`/api/runs/${ref}/cancel`), asApprover).then((res) => res),
      async () => {
        await inOrg(http().post(`/api/runs/${ref}/events`), asOwner)
          .send({ topic: 'approval', payload: { decision: 'yes' } })
          .expect(200);
        finished = await answer;
      },
    );

    const run = await inOrg(http().get(`/api/runs/${ref}`), asOwner).expect(200);
    expect({
      cancel: [cancelled.status, cancelled.body.status],
      answer: finished?.status,
      status: run.body.status,
      outputs: run.body.outputs,
    }).toEqual({
      cancel: [200, 'completed'],
      answer: 201,
      status: 'completed',
      outputs: { approval: { decision: 'yes' } },
    });
  }, 30_000);

  /** Deploy a workflow other workflows may call: a tool trigger, then `steps` in order. */
  async function callable(name: string, steps: Array<{ id: string }>): Promise<string> {
    const trigger = node('trigger', 'orchestr:tool_trigger', {
      tool_name: name,
      description: `${name} for the cancel suite`,
      inputs: [{ name: 'q', type: 'string', description: 'unused', required: false }],
    });
    const chain = [trigger, ...steps];
    const doc = ir(
      chain,
      chain.slice(1).map((step, i) => edge(chain[i]!.id, step.id)),
    );
    const deployed = await inOrg(http().post('/api/deploy'), asOwner)
      .send({ workflow_json: doc })
      .expect(201);
    return deployed.body.workflow_id as string;
  }

  /** The owner's run of `call_workflow(child) → POST /parent-after`, left in flight. */
  const callerRun = (runId: string, childId: string) =>
    inOrg(http().post('/api/runs/from-ir'), asOwner)
      .send({
        run_id: runId,
        workflow_ir: ir(
          [
            node('call', 'orchestr:call_workflow', { workflow_id: childId }),
            post('parent-after', '/parent-after'),
          ],
          [edge('call', 'parent-after')],
        ),
      })
      .then((res) => res);

  const childRowOf = async (callerRunId: string) =>
    (
      await db.query<{ run_id: string; status: string }>(
        `SELECT run_id, status FROM runtime_runs WHERE parent_run_id = $1`,
        [`${owner}:${callerRunId}`],
      )
    ).rows[0];

  it('cancelling a run reaches the workflow it is calling: that run ends at once, and nothing after either starts', async () => {
    const child = await callable('napper', [
      node('hold', 'orchestr:wait_for_duration', { amount: 1, unit: 'minutes' }),
      post('child-after', '/child-after'),
    ]);
    const answer = callerRun('caller-nap', child);
    for (let i = 0; i < 200; i++) {
      const napping = await db.query(
        `SELECT 1 FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id
          WHERE r.parent_run_id = $1 AND s.node_id = 'hold' AND s.status = 'running'`,
        [`${owner}:caller-nap`],
      );
      if (napping.rows.length > 0) break;
      await pause(25);
    }
    const cancelledAt = Date.now();
    await inOrg(http().post('/api/runs/caller-nap/cancel'), asOwner).expect(200);
    const res = await answer;

    const caller = await inOrg(http().get('/api/runs/caller-nap'), asOwner).expect(200);
    expect({
      answer: res.body.code,
      promptly: Date.now() - cancelledAt < 5_000,
      caller: caller.body.status,
      called: (await childRowOf('caller-nap'))?.status,
      calls: [hitsOn('/child-after'), hitsOn('/parent-after')],
    }).toEqual({
      answer: 'run_cancelled',
      promptly: true,
      caller: 'cancelled',
      called: 'cancelled',
      calls: [0, 0],
    });
  }, 30_000);

  it('a run another run is calling cannot be cancelled on its own, and goes on untouched', async () => {
    const child = await callable('gated', [
      post('child-gate', '/gate-child'),
      post('child-after', '/child-after'),
    ]);
    const answer = callerRun('caller-gated', child);
    await untilHitShared('/gate-child');
    const called = (await childRowOf('caller-gated'))!;
    const refused = await inOrg(http().post(`/api/runs/${called.run_id}/cancel`), asOwner);
    openGate();
    const res = await answer;

    expect({
      refused: [refused.status, refused.body.code],
      answer: res.status,
      called: (await childRowOf('caller-gated'))?.status,
      calls: [hitsOn('/child-after'), hitsOn('/parent-after')],
    }).toEqual({ refused: [409, 'called_run'], answer: 201, called: 'completed', calls: [1, 1] });
  }, 30_000);

  it("a called run's retry with no wait between tries makes no attempt after its caller is cancelled", async () => {
    const child = await callable('retrier', [
      post('flaky', '/gate-retry', { retry: { maxAttempts: 3 } }),
      post('child-after', '/child-after'),
    ]);
    const answer = callerRun('caller-retry', child);
    await untilHitShared('/gate-retry');
    await inOrg(http().post('/api/runs/caller-retry/cancel'), asOwner).expect(200);
    const releasing = setInterval(() => openGate(500), 20);
    const res = await answer.finally(() => clearInterval(releasing));

    expect({
      answer: res.body.code,
      attempts: hitsOn('/gate-retry'),
      called: (await childRowOf('caller-retry'))?.status,
      calls: [hitsOn('/child-after'), hitsOn('/parent-after')],
    }).toEqual({ answer: 'run_cancelled', attempts: 1, called: 'cancelled', calls: [0, 0] });
  }, 30_000);

  it("a called run's continue-on-fail does not apply to a failure after its caller's cancel", async () => {
    const child = await callable('tolerant', [
      post('tol', '/gate-tol', { onError: 'continue' }),
      post('child-after', '/child-after'),
    ]);
    const answer = callerRun('caller-tolerant', child);
    await untilHitShared('/gate-tol');
    await inOrg(http().post('/api/runs/caller-tolerant/cancel'), asOwner).expect(200);
    openGate(500);
    const res = await answer;

    const called = (await childRowOf('caller-tolerant'))!;
    const steps = await db.query<{ node_id: string; status: string; continued: boolean }>(
      `SELECT s.node_id, s.status, s.continued FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id
        WHERE r.run_id = $1 AND s.node_id = 'tol'`,
      [called.run_id],
    );
    expect({
      answer: res.body.code,
      tol: steps.rows[0],
      called: called.status,
      calls: [hitsOn('/child-after'), hitsOn('/parent-after')],
    }).toEqual({
      answer: 'run_cancelled',
      tol: { node_id: 'tol', status: 'error', continued: false },
      called: 'cancelled',
      calls: [0, 0],
    });
  }, 30_000);
});
