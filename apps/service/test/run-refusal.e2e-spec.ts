import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DbosRuntime } from '../src/dbos/dbos-runtime';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const UNCOMPILABLE_PLAN = {
  id: 'plan-bad',
  nodes: [{ kind: 'waitForEvent', id: 'ask', topic: 'orchestr:timer:x', timeoutMs: 1_000 }],
};

const UNCOMPILABLE_IR = {
  version: '1',
  name: 'uncompilable',
  description: '',
  nodes: [
    {
      id: 'mystery',
      name: 'Mystery',
      node_type: 'mystery',
      type_version: 1,
      parameters: {},
      position: { x: 0, y: 0 },
      metadata: {},
    },
  ],
  edges: [],
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
};

const CONCAT_PLAN = {
  id: 'plan-ok',
  nodes: [{ kind: 'action', id: 'c', actionId: 'text.concat', props: { texts: ['4', '2'], separator: '' } }],
};

const askPlan = (id: string) => ({
  id,
  nodes: [{ kind: 'waitForEvent', id: 'ask', topic: 'go', timeoutMs: 60_000 }],
});

const ASK_IR = {
  version: '1.0',
  name: 'ask',
  description: '',
  nodes: [
    {
      id: 'ask',
      name: 'Ask',
      node_type: 'orchestr:wait_for_event',
      type_version: 1,
      parameters: { topic: 'go', timeout_ms: 60_000 },
      position: { x: 0, y: 0 },
      metadata: {},
    },
  ],
  edges: [],
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
};

function deployableIr(name: string): Record<string, unknown> {
  return {
    version: '1.0',
    name,
    description: '',
    nodes: [
      {
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['hi ', 'there'], separator: '' },
        position: { x: 0, y: 0 },
        metadata: {},
      },
    ],
    edges: [],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

/** A run start that is refused writes only a run of its own, and never under a workflow the caller can't reach. */
describe('a refused run start touches no other run (e2e, isolated DB, DBOS on, mock auth)', () => {
  let app: INestApplication;
  let db: Client;

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  async function until(runId: string, status: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 200; i++) {
      const res = await http().get(`/api/runs/${runId}`);
      if (res.status === 200 && res.body.status === status) return res.body as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`run ${runId} never reached "${status}"`);
  }

  async function row(runId: string): Promise<Record<string, unknown> | undefined> {
    const res = await db.query(
      `SELECT status, outputs, error, finished_at, waiting_node_id, waiting_topic, waiting_timeout_at,
              workflow_id, org_id, dry_run, plan
         FROM runtime_runs WHERE run_id = $1`,
      [runId],
    );
    return res.rows[0] as Record<string, unknown> | undefined;
  }

  async function stepsOf(runId: string): Promise<unknown[]> {
    const res = await db.query(
      `SELECT s.node_id, s.status, s.error, s.output
         FROM runtime_run_steps s JOIN runtime_runs r ON r.id = s.run_id
        WHERE r.run_id = $1 ORDER BY s.step_key`,
      [runId],
    );
    return res.rows;
  }

  async function scopedIdOf(runId: string): Promise<string> {
    const res = await db.query(`SELECT id FROM runtime_runs WHERE run_id = $1`, [runId]);
    return (res.rows[0] as { id: string }).id;
  }

  async function inboxRunIds(): Promise<string[]> {
    const res = await http().get('/api/runs/waiting').expect(200);
    return (res.body.runs as Array<{ run_id: string }>).map((r) => r.run_id);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;
    process.env.DBOS_ENABLED = 'true';
    delete process.env.DBOS_SYSTEM_DATABASE_URL;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
    process.env.DBOS_ENABLED = 'false';
  }, 60_000);

  it('leaves a finished run as it was when a refused plan or document reuses its id, on every route', async () => {
    const done = await http().post('/api/runs').send({ plan: CONCAT_PLAN, run_id: 'victim' }).expect(201);
    expect(done.body.outputs.c).toBe('42');
    const before = await row('victim');
    expect(before).toMatchObject({ status: 'completed', error: null, outputs: { c: '42' } });

    for (const [route, body] of [
      ['/api/runs', { plan: UNCOMPILABLE_PLAN, run_id: 'victim' }],
      ['/api/runs/async', { plan: UNCOMPILABLE_PLAN, run_id: 'victim' }],
      ['/api/runs/from-ir', { workflow_ir: UNCOMPILABLE_IR, run_id: 'victim' }],
      ['/api/runs/async', { workflow_ir: UNCOMPILABLE_IR, run_id: 'victim' }],
    ] as const) {
      const refused = await http().post(route).send(body);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('compile_failed');
      expect(await row('victim')).toEqual(before);
    }
    const detail = await until('victim', 'completed');
    expect(detail.outputs).toMatchObject({ c: '42' });
    expect(detail.error).toBeUndefined();
  });

  it('leaves a waiting run waiting when a refused plan reuses its id, and its approver can still answer it', async () => {
    await http()
      .post('/api/runs/async')
      .send({ plan: askPlan('plan-ask'), run_id: 'parked' })
      .expect(201);
    await until('parked', 'waiting');
    const before = await row('parked');
    expect(before).toMatchObject({ status: 'waiting', waiting_topic: 'go' });

    for (const route of ['/api/runs', '/api/runs/async']) {
      const refused = await http().post(route).send({ plan: UNCOMPILABLE_PLAN, run_id: 'parked' });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('compile_failed');
      expect(await row('parked')).toEqual(before);
    }
    expect(await inboxRunIds()).toContain('parked');

    await http()
      .post('/api/runs/parked/events')
      .send({ topic: 'go', payload: { decision: 'approved' } })
      .expect(200);
    const answered = await until('parked', 'completed');
    expect(answered.outputs).toMatchObject({ ask: { decision: 'approved' } });
  });

  it('lets a retry take an id only a refusal holds: it parks, reaches the inbox, and can be answered or cancelled, on every route', async () => {
    const routes = [
      ['/api/runs', { plan: UNCOMPILABLE_PLAN }, { plan: askPlan('plan-retry') }, 'sync'],
      ['/api/runs/async', { plan: UNCOMPILABLE_PLAN }, { plan: askPlan('plan-retry') }, 'async'],
      ['/api/runs/from-ir', { workflow_ir: UNCOMPILABLE_IR }, { workflow_ir: ASK_IR }, 'sync'],
      ['/api/runs/async', { workflow_ir: UNCOMPILABLE_IR }, { workflow_ir: ASK_IR }, 'async'],
    ] as const;

    for (const [i, [route, refusedBody, retryBody, mode]] of routes.entries()) {
      for (const ending of ['answered', 'cancelled'] as const) {
        const runId = `retry-${i}-${ending}`;
        const refused = await http()
          .post(route)
          .send({ ...refusedBody, run_id: runId });
        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe('compile_failed');
        expect(await row(runId)).toMatchObject({ status: 'error' });

        const started = http()
          .post(route)
          .send({ ...retryBody, run_id: runId })
          .then((res) => res);
        const parked = await until(runId, 'waiting');
        expect(parked.error).toBeUndefined();
        expect(parked.waiting).toMatchObject({ kind: 'event' });
        expect(await row(runId)).toMatchObject({
          status: 'waiting',
          error: null,
          finished_at: null,
          waiting_node_id: 'ask',
          waiting_topic: 'go',
        });
        expect(await inboxRunIds()).toContain(runId);

        if (ending === 'answered') {
          await http()
            .post(`/api/runs/${runId}/events`)
            .send({ topic: 'go', payload: { decision: 'approved' } })
            .expect(200);
          const answered = await until(runId, 'completed');
          expect(answered.outputs).toMatchObject({ ask: { decision: 'approved' } });
          expect(answered.error).toBeUndefined();
        } else {
          const cancel = await http().post(`/api/runs/${runId}/cancel`).expect(200);
          expect(cancel.body.status).toBe('cancelled');
          await until(runId, 'cancelled');
          expect(await app.get(DbosRuntime).getRunStatus(await scopedIdOf(runId))).toMatchObject({
            status: 'cancelled',
          });
        }

        const reply = await started;
        if (mode === 'async') {
          expect(reply.status).toBe(201);
          expect(reply.body).toEqual({ run_id: runId, status: 'running' });
        } else if (ending === 'answered') {
          expect(reply.status).toBe(201);
          expect(reply.body.outputs.ask).toEqual({ decision: 'approved' });
        } else {
          expect(reply.status).toBe(409);
          expect(reply.body.code).toBe('run_cancelled');
        }
        expect(await inboxRunIds()).not.toContain(runId);
      }
    }
  }, 120_000);

  it('leaves a failed run with no recorded plan as it was when a start reuses its id, on every route', async () => {
    const failed = await http()
      .post('/api/runs')
      .send({
        plan: {
          id: 'plan-legacy',
          nodes: [{ kind: 'code', id: 'boom', language: 'js', code: 'throw new Error("legacy failure");' }],
        },
        run_id: 'legacy',
      });
    expect(failed.body.detail).toContain('legacy failure');
    await db.query(`UPDATE runtime_runs SET plan = NULL WHERE run_id = 'legacy'`);
    const before = await row('legacy');
    expect(before).toMatchObject({ status: 'error', plan: null });
    const stepsBefore = await stepsOf('legacy');
    expect(stepsBefore).toMatchObject([{ node_id: 'boom', status: 'error' }]);

    for (const [route, body] of [
      ['/api/runs', { plan: CONCAT_PLAN, run_id: 'legacy' }],
      ['/api/runs/async', { plan: CONCAT_PLAN, run_id: 'legacy' }],
      ['/api/runs/from-ir', { workflow_ir: deployableIr('legacy-retry'), run_id: 'legacy' }],
      ['/api/runs/async', { workflow_ir: deployableIr('legacy-retry'), run_id: 'legacy' }],
    ] as const) {
      await http().post(route).send(body);
      expect(await row('legacy')).toEqual(before);
      expect(await stepsOf('legacy')).toEqual(stepsBefore);
    }
    const detail = await until('legacy', 'error');
    expect(String(detail.error)).toContain('legacy failure');
    const list = await http().get('/api/runs').expect(200);
    const listed = (list.body.runs as Array<{ run_id: string; status: string }>).find(
      (r) => r.run_id === 'legacy',
    );
    expect(listed?.status).toBe('error');
    expect(await inboxRunIds()).not.toContain('legacy');
  });

  it('records the latest refusal when an id that only a refusal holds is refused again', async () => {
    const first = await http().post('/api/runs').send({ plan: UNCOMPILABLE_PLAN, run_id: 'twice' });
    expect(first.status).toBe(400);
    const second = await http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: UNCOMPILABLE_IR, run_id: 'twice', dry_run: true });
    expect(second.status).toBe(400);
    expect(second.body.detail).not.toBe(first.body.detail);

    expect(await row('twice')).toMatchObject({ status: 'error', error: second.body.detail, dry_run: true });
    const detail = await until('twice', 'error');
    expect(detail.error).toBe(second.body.detail);
  });

  it('records a refused dry run as the dry run it was', async () => {
    for (const [route, body, runId] of [
      ['/api/runs', { plan: UNCOMPILABLE_PLAN, run_id: 'dry-plan', dry_run: true }, 'dry-plan'],
      ['/api/runs/from-ir', { workflow_ir: UNCOMPILABLE_IR, run_id: 'dry-ir', dry_run: true }, 'dry-ir'],
    ] as const) {
      const refused = await http().post(route).send(body);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('compile_failed');
      expect(await row(runId)).toMatchObject({ status: 'error', dry_run: true });
      const detail = await until(runId, 'error');
      expect(detail.dry_run).toBe(true);
      expect(String(detail.error)).toMatch(/^Workflow can't run: /);
      expect(detail.finished_at).toBeTruthy();
    }
    const list = await http().get('/api/runs').expect(200);
    const dry = (list.body.runs as Array<{ run_id: string; dry_run: boolean }>).filter((r) =>
      ['dry-plan', 'dry-ir'].includes(r.run_id),
    );
    expect(dry.map((r) => r.dry_run)).toEqual([true, true]);
  });

  it("refuses an async raw plan filed under another org's workflow, or one that does not exist, and records nothing", async () => {
    const otherOrg = randomUUID();
    const foreign = randomUUID();
    await db.query(
      `INSERT INTO organizations (id, name, is_personal, created_at, updated_at) VALUES ($1, 'Elsewhere', false, now(), now())`,
      [otherOrg],
    );
    await db.query(`INSERT INTO workflows (id, name, org_id) VALUES ($1, 'theirs', $2)`, [foreign, otherOrg]);

    for (const [runId, workflowId, plan] of [
      ['inject', foreign, askPlan('plan-inject')],
      ['inject-bad', foreign, UNCOMPILABLE_PLAN],
      ['ghost', randomUUID(), askPlan('plan-ghost')],
      ['not-an-id', 'not-a-uuid', askPlan('plan-not-an-id')],
    ] as const) {
      const refused = await http()
        .post('/api/runs/async')
        .send({ plan, workflow_id: workflowId, run_id: runId });
      expect(refused.status).toBe(404);
      expect(refused.body.detail).toBe(`Workflow ${workflowId} not found`);
      expect(await row(runId)).toBeUndefined();
    }
    const filed = await db.query(`SELECT count(*)::int AS n FROM runtime_runs WHERE workflow_id = $1`, [
      foreign,
    ]);
    expect(filed.rows[0]).toEqual({ n: 0 });

    const mine = await http()
      .post('/api/deploy')
      .send({ workflow_json: deployableIr('mine') })
      .expect(201);
    const mineId = mine.body.workflow_id as string;
    await http()
      .post('/api/runs/async')
      .send({ plan: askPlan('plan-linked'), workflow_id: mineId, run_id: 'linked' })
      .expect(201);
    await until('linked', 'waiting');
    expect(await row('linked')).toMatchObject({ status: 'waiting', workflow_id: mineId });
    await http().post('/api/runs/linked/events').send({ topic: 'go', payload: {} }).expect(200);
    await until('linked', 'completed');
  });
});
