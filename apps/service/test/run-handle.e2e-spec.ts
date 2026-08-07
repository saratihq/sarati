import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import type { EnvConfig } from '../src/config/env.config';
import { DbosRuntime } from '../src/dbos/dbos-runtime';
import type { WorkflowIR } from '../src/ir/models';
import { RunsService } from '../src/runs/runs.service';
import { DagInterpreter } from '../src/runtime/dag-interpreter';
import type { DagPlan } from '../src/runtime/dag-plan';
import { RuntimeCompiler } from '../src/runtime/runtime-compiler';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** How long the stub server holds the "slow" response — comfortably past the bounded wait below. */
const SLOW_STEP_MS = 1_200;
const BOUNDED_WAIT_MS = 150;

const node = (id: string, node_type: string, parameters: Record<string, unknown>) => ({
  id,
  name: id,
  node_type,
  type_version: 1,
  parameters,
  position: { x: 0, y: 0 },
  metadata: {},
});

const ir = (
  name: string,
  nodes: Array<Record<string, unknown>>,
  edges: Array<Record<string, unknown>> = [],
) => ({
  version: '1',
  name,
  description: '',
  nodes,
  edges,
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
});

const edge = (source: string, target: string) => ({
  id: `${source}->${target}`,
  source_node_id: source,
  source_port: 0,
  target_node_id: target,
  target_port: 0,
  port_type: 'main',
});

/**
 * ADR 0052 — a run is debuggable from its own handle: `from-ir` answers with `run_id`, a bounded
 * wait hands back a pollable handle instead of hanging, and a failure carries the failing node.
 */
describe('run handle: run_id, bounded wait, and debuggable failure (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let stub: Server;
  let stubUrl: string;

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    stub = createServer((req, res) => {
      const reply = (): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ path: req.url }));
      };
      if (req.url?.startsWith('/slow')) {
        // The SERVER is what makes the run slow — the test never sleeps in place of a real step.
        setTimeout(reply, SLOW_STEP_MS);
      } else if (req.url?.startsWith('/boom')) {
        res.destroy(); // a transport failure, so the step throws a plain error rather than refusing
      } else {
        reply();
      }
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;
    // Direct (in-process) path: the bounded wait and the poll must hold without durable execution.
    process.env.DBOS_ENABLED = 'false';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => stub.close((e) => (e ? reject(e) : resolve())));
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  }, 30_000);

  const fastIr = () => ir('fast', [node('greet', 'text.concat', { texts: ['hi ', 'there'], separator: '' })]);
  const slowIr = () =>
    ir('slow', [node('wait', 'http.send_request', { method: 'GET', url: `${stubUrl}/slow` })]);

  /** Read a run until it leaves `running`, or give up — the poll a handle-holder is told to make. */
  const pollUntilSettled = async (runId: string): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const res = await request(app.getHttpServer()).get(`/api/runs/${runId}`).expect(200);
      if (res.body.status !== 'running' || Date.now() > deadline) return res.body as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it('a run returns its own handle: run_id comes back on the result and GET /api/runs/:id resolves it', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir: fastIr() })
      .expect(201);
    expect(res.body.outputs.greet).toBe('hi there');
    expect(typeof res.body.run_id).toBe('string');
    expect(res.body.status).toBeUndefined(); // a settled result is not a handle

    // The id the caller was handed resolves the run it just started — no id-scraping from a message.
    const detail = await request(app.getHttpServer()).get(`/api/runs/${res.body.run_id}`).expect(200);
    expect(detail.body.run_id).toBe(res.body.run_id);
    expect(detail.body.status).toBe('completed');
    expect((detail.body.steps as Array<Record<string, unknown>>).map((s) => s.node_id)).toEqual(['greet']);
  });

  it('bounded wait: a run that settles in time returns the FULL result, not a handle', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir: fastIr(), await_ms: 10_000 })
      .expect(201);
    expect(res.body.outputs.greet).toBe('hi there');
    expect(res.body.status).toBeUndefined();
    expect(typeof res.body.run_id).toBe('string');
  });

  it('bounded wait: a run that outlives it returns a handle, and polling that id reports completion', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir: slowIr(), await_ms: BOUNDED_WAIT_MS })
      .expect(201);
    // The handle, and nothing that pretends to be a result.
    expect(res.body.status).toBe('running');
    expect(typeof res.body.run_id).toBe('string');
    expect(res.body.outputs).toBeUndefined();

    // The run is readable WHILE it is still going.
    const inFlight = await request(app.getHttpServer()).get(`/api/runs/${res.body.run_id}`).expect(200);
    expect(inFlight.body.status).toBe('running');

    // …and the same id reports completion once the slow step lands.
    const settled = await pollUntilSettled(res.body.run_id as string);
    expect(settled.status).toBe('completed');
    expect((settled.outputs as { wait: { status: number } }).wait.status).toBe(200);
    expect((settled.steps as Array<Record<string, unknown>>)[0]?.status).toBe('completed');
  }, 30_000);

  /** A run whose first node succeeds and whose second one fails — so "the failing node" is a real choice. */
  const failingIr = (boom: Record<string, unknown>) =>
    ir(
      'failing',
      [node('ok', 'text.concat', { texts: ['fine'], separator: '' }), boom],
      [edge('ok', 'boom')],
    );

  it('a failed run is debuggable from its own error: run_id + failing node + steps', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({
        // The transport dies mid-request, so the step throws a plain error → a run outcome, 422.
        workflow_ir: failingIr(node('boom', 'http.send_request', { method: 'GET', url: `${stubUrl}/boom` })),
      })
      .expect(422);

    expect(String(res.body.detail)).toContain('failed');
    expect(typeof res.body.run_id).toBe('string');
    expect(res.body.failed_node_id).toBe('boom'); // the node that ended the run, not the one that passed
    const steps = res.body.steps as Array<Record<string, unknown>>;
    expect(steps.map((s) => s.node_id)).toEqual(['ok', 'boom']);
    expect(steps.find((s) => s.node_id === 'boom')?.status).toBe('error');
    expect(steps.find((s) => s.node_id === 'boom')?.error).toBeTruthy();
    expect(steps.every((s) => !('output' in s))).toBe(true); // payloads stay out of the error body

    // The handle in the error resolves the failed run itself.
    const detail = await request(app.getHttpServer()).get(`/api/runs/${res.body.run_id}`).expect(200);
    expect(detail.body.status).toBe('error');
    expect(detail.body.error).toBeTruthy();
    expect(
      (detail.body.steps as Array<Record<string, unknown>>).find((s) => s.node_id === 'boom')?.error,
    ).toBeTruthy();
  });

  it('a step failure that is already a domain refusal keeps its status AND gains the run handle', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      // No rail runs `nope.do`: the provider refuses (400), which is the caller's document problem.
      .send({ workflow_ir: failingIr(node('boom', 'nope.do', {})) })
      .expect(400);

    expect(typeof res.body.run_id).toBe('string');
    expect(res.body.failed_node_id).toBe('boom');
    expect((res.body.steps as Array<Record<string, unknown>>).map((s) => s.node_id)).toEqual(['ok', 'boom']);
    expect(
      (await request(app.getHttpServer()).get(`/api/runs/${res.body.run_id}`).expect(200)).body.status,
    ).toBe('error');
  });

  it('a compile failure still 400s, says why, and hands back the run it recorded', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir: ir('uncompilable', [node('mystery', 'mystery', {})]) })
      .expect(400);
    expect(String(res.body.detail)).toContain("isn't runnable on this engine yet (mystery)");
    expect(res.body.failed_node_id).toBeNull(); // nothing ran, so no node failed
    expect(res.body.steps).toEqual([]);

    const detail = await request(app.getHttpServer()).get(`/api/runs/${res.body.run_id}`).expect(200);
    expect(detail.body.status).toBe('error');
    expect(String(detail.body.error)).toContain("isn't runnable on this engine yet");
  });

  it('async: the body must carry exactly one document, and a dry run is never durable', async () => {
    await request(app.getHttpServer())
      .post('/api/runs/async')
      .send({ plan: { id: 'p', nodes: [] }, workflow_ir: fastIr() })
      .expect(400)
      .expect(({ body }) => expect(String(body.detail)).toContain('not both'));

    await request(app.getHttpServer()).post('/api/runs/async').send({}).expect(400);

    await request(app.getHttpServer())
      .post('/api/runs/async')
      .send({ workflow_ir: fastIr(), dry_run: true })
      .expect(400)
      .expect(({ body }) => expect(String(body.detail)).toContain('never durable'));

    // A well-formed IR still needs durable execution to start unattended.
    await request(app.getHttpServer()).post('/api/runs/async').send({ workflow_ir: fastIr() }).expect(409);
  });

  it('async: a WorkflowIR takes the SAME compile seam, and that plan is what starts durably', async () => {
    const started: Array<{ plan: DagPlan; runId: string; initialScope?: Record<string, unknown> }> = [];
    const dbos = {
      startDurably: (
        plan: DagPlan,
        opts: { runId: string; initialScope?: Record<string, unknown> },
      ): Promise<string> => {
        started.push({ plan, runId: opts.runId, initialScope: opts.initialScope });
        return Promise.resolve(opts.runId);
      },
    } as unknown as DbosRuntime;
    // The real interpreter + compiler, with durability the only thing stubbed (proven separately
    // by dbos-durable-step.e2e-spec.ts) — what is under test here is the compile seam.
    const runs = new RunsService(app.get(DagInterpreter), app.get(RuntimeCompiler), dbos, {
      get: () => ({ dbosEnabled: true }),
    } as unknown as ConfigService<{ env: EnvConfig }, true>);

    const { runId } = await runs.startRun(
      { ir: slowIr() as unknown as WorkflowIR },
      { externalUserId: 'u', initialScope: { trigger: { who: 'ada' } } },
    );

    expect(started).toHaveLength(1);
    expect(started[0]!.runId).toBe(`u:${runId}`); // the durable id stays user-scoped
    expect(started[0]!.plan.nodes.map((n) => n.id)).toEqual(['wait']); // the IR really was compiled
    expect(started[0]!.initialScope).toEqual({ trigger: { who: 'ada' } });

    // The document `from-ir` refuses is refused here too — one seam, one refusal.
    await expect(
      runs.startRun(
        { ir: ir('uncompilable', [node('mystery', 'mystery', {})]) as unknown as WorkflowIR },
        {
          externalUserId: 'u',
        },
      ),
    ).rejects.toMatchObject({ status: 400, details: { code: 'compile_failed' } });
  });
});
