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
  let server: Server;
  let base = '';
  const hits = new Map<string, number>();
  const held: ServerResponse[] = [];

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const hitsOn = (path: string): number => hits.get(path) ?? 0;

  /** Answer every request `/gate` is holding, so a step that was in flight can finish. */
  const openGate = (): void => {
    for (const res of held.splice(0)) res.end('{"ok":true}');
  };

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

  afterEach(() => {
    openGate();
    hits.clear();
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
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
  const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
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
});
