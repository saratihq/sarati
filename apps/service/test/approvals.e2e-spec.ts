import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';
const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** A one-node built-in-engine WorkflowIR (the deployable stand-in workflow). */
function simpleIr(name: string): Record<string, unknown> {
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

/** Parks on `orchestr:wait_for_event`, then announces `{{approval.decision}}` — the delivered event payload. */
function approvalIr(topic: string, timeoutMs: number, withAnnounce = true): Record<string, unknown> {
  const wait = {
    id: 'approval',
    name: 'Approval',
    node_type: 'orchestr:wait_for_event',
    type_version: 1,
    parameters: { topic, timeout_ms: timeoutMs },
    position: { x: 0, y: 0 },
    metadata: {},
  };
  const announce = {
    id: 'announce',
    name: 'Announce',
    node_type: 'text.concat',
    type_version: 1,
    parameters: { texts: ['decision: ', '{{approval.decision}}'], separator: '' },
    position: { x: 200, y: 0 },
    metadata: {},
  };
  const edge = {
    id: 'approval->announce',
    source_node_id: 'approval',
    source_port: 0,
    target_node_id: 'announce',
    target_port: 0,
    port_type: 'main',
  };
  return {
    version: '1.0',
    name: 'approval flow',
    description: '',
    nodes: withAnnounce ? [wait, announce] : [wait],
    edges: withAnnounce ? [edge] : [],
    settings: { execution_order: 'v1', extra: {} },
    metadata: {},
  };
}

/** Runs panel + approvals; DBOS is off, so this exercises the direct-path in-process pause/resume. */
describe('runs history + approvals (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let wfId = '';

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  /** Poll the approvals inbox until `runId` shows up (the run is parked). */
  async function awaitWaiting(runId: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 100; i++) {
      const res = await http().get('/api/runs/waiting').expect(200);
      const found = (res.body.runs as Array<Record<string, unknown>>).find((r) => r.run_id === runId);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`run ${runId} never appeared on /api/runs/waiting`);
  }

  it('manual from-ir runs link to their workflow; the list carries the panel fields', async () => {
    const deployed = await http()
      .post('/api/deploy')
      .send({ workflow_json: simpleIr('panel workflow') })
      .expect(201);
    wfId = deployed.body.workflow_id;

    const run = await http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: simpleIr('panel workflow'), workflow_id: wfId, run_id: 'manual-1' })
      .expect(201);
    expect(run.body.outputs.announce).toBe('hi there');

    // List: newest first, caller-scoped, with the runs-panel fields.
    const list = await http().get('/api/runs').expect(200);
    const mine = (list.body.runs as Array<Record<string, unknown>>).find((r) => r.run_id === 'manual-1');
    expect(mine).toMatchObject({
      run_id: 'manual-1',
      workflow_id: wfId,
      workflow_name: 'panel workflow',
      status: 'completed',
      source: 'manual',
      error: null,
    });
    expect(typeof mine?.duration_ms).toBe('number');
    expect(mine?.started_at).toBeTruthy();
    expect(mine?.finished_at).toBeTruthy();

    // ?workflow_id= filters; garbage is a 400; an unknown workflow just matches nothing.
    const filtered = await http().get(`/api/runs?workflow_id=${wfId}`).expect(200);
    expect((filtered.body.runs as Array<{ run_id: string }>).map((r) => r.run_id)).toContain('manual-1');
    const none = await http().get(`/api/runs?workflow_id=${randomUUID()}`).expect(200);
    expect(none.body.runs).toEqual([]);
    await http().get('/api/runs?workflow_id=not-a-uuid').expect(400);

    // Detail: linkage + per-step log with a bounded output preview.
    const detail = await http().get('/api/runs/manual-1').expect(200);
    expect(detail.body.workflow_id).toBe(wfId);
    expect(detail.body.workflow_name).toBe('panel workflow');
    expect(detail.body.source).toBe('manual');
    expect(typeof detail.body.duration_ms).toBe('number');
    const steps = detail.body.steps as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ node_id: 'announce', status: 'completed', error: null });
    expect(steps[0]!.started_at).toBeTruthy();
    expect(steps[0]!.finished_at).toBeTruthy();
    expect(steps[0]!.output_preview).toBe(JSON.stringify('hi there'));
  });

  it("from-ir workflow_id is org-scoped: another org's workflow (or a ghost) is a 404", async () => {
    const org = await http().post('/api/orgs').send({ name: 'Gamma' }).expect(201);
    const deployed = await http()
      .post('/api/deploy')
      .set('X-Org-Id', org.body.id as string)
      .send({ workflow_json: simpleIr('gamma workflow') })
      .expect(201);

    // Active org = personal ≠ the workflow's org → 404, indistinguishable from nonexistent.
    await http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: simpleIr('x'), workflow_id: deployed.body.workflow_id })
      .expect(404);
    await http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: simpleIr('x'), workflow_id: randomUUID() })
      .expect(404);
    await http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: simpleIr('x'), workflow_id: 'not-a-uuid' })
      .expect(404);
  });

  it('approval cycle: pause on wait_for_event → waiting list → event delivers → run completes with the payload', async () => {
    // Kick the run off WITHOUT awaiting — it parks on the wait node.
    const pending = http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: approvalIr('approve', 15_000), workflow_id: wfId, run_id: 'appr-1' })
      .then((r) => r);

    // The parked run surfaces on the approvals inbox, with the panel's fields.
    const waiting = await awaitWaiting('appr-1');
    expect(waiting).toMatchObject({
      run_id: 'appr-1',
      workflow_id: wfId,
      workflow_name: 'panel workflow',
      node_id: 'approval',
      topic: 'approve',
    });
    expect(waiting.waiting_since).toBeTruthy();
    expect(waiting.timeout_at).toBeTruthy();
    // ?workflow_id= filters the inbox too.
    const filtered = await http().get(`/api/runs/waiting?workflow_id=${wfId}`).expect(200);
    expect((filtered.body.runs as Array<{ run_id: string }>).map((r) => r.run_id)).toContain('appr-1');
    const none = await http().get(`/api/runs/waiting?workflow_id=${randomUUID()}`).expect(200);
    expect(none.body.runs).toEqual([]);

    // Detail while parked says `waiting`.
    const during = await http().get('/api/runs/appr-1').expect(200);
    expect(during.body.status).toBe('waiting');

    // Wrong topic → 409 (the wait stays parked); unknown run → 404.
    await http().post('/api/runs/appr-1/events').send({ topic: 'reject', payload: {} }).expect(409);
    await http().post(`/api/runs/${randomUUID()}/events`).send({ topic: 'approve', payload: {} }).expect(404);

    // Deliver the decision: the run resumes and the payload IS the node's output.
    const sent = await http()
      .post('/api/runs/appr-1/events')
      .send({ topic: 'approve', payload: { decision: 'approved' } })
      .expect(200);
    expect(sent.body.status).toBe('sent');

    const result = await pending;
    expect(result.status).toBe(201);
    expect(result.body.outputs.approval).toEqual({ decision: 'approved' });
    expect(result.body.outputs.announce).toBe('decision: approved');

    // Resumed → off the waiting list; history shows the completed cycle.
    const after = await http().get('/api/runs/waiting').expect(200);
    expect((after.body.runs as Array<{ run_id: string }>).map((r) => r.run_id)).not.toContain('appr-1');
    const detail = await http().get('/api/runs/appr-1').expect(200);
    expect(detail.body.status).toBe('completed');
    expect(detail.body.outputs.approval).toEqual({ decision: 'approved' });
    const waitStep = (detail.body.steps as Array<Record<string, unknown>>).find(
      (s) => s.node_id === 'approval',
    );
    expect(waitStep).toMatchObject({ kind: 'waitForEvent', status: 'completed' });

    // A completed run is not waiting on anything — late events are a 409.
    await http().post('/api/runs/appr-1/events').send({ topic: 'approve', payload: {} }).expect(409);
  });

  it('a wait that times out resolves to null and leaves the waiting list', async () => {
    const pending = http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: approvalIr('never-comes', 1_200, false), run_id: 'appr-timeout' })
      .then((r) => r);

    const waiting = await awaitWaiting('appr-timeout');
    expect(waiting.workflow_id).toBeNull(); // no linkage requested on this one
    expect(waiting.topic).toBe('never-comes');

    // No event arrives — the wait times out and the run completes with a null payload.
    const result = await pending;
    expect(result.status).toBe(201);
    expect(result.body.outputs.approval).toBeNull();

    const after = await http().get('/api/runs/waiting').expect(200);
    expect((after.body.runs as Array<{ run_id: string }>).map((r) => r.run_id)).not.toContain('appr-timeout');
    const detail = await http().get('/api/runs/appr-timeout').expect(200);
    expect(detail.body.status).toBe('completed');
  }, 20_000);
});
