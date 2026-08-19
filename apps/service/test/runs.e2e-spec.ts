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

/** POST /api/runs end-to-end through the real router + interpreter, with DBOS off (non-durable path). */
describe('runs endpoint (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let echoServer: Server;
  let echoUrl: string;

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    echoServer = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, token: u.searchParams.get('token') }));
    });
    await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', resolve));
    echoUrl = `http://127.0.0.1:${(echoServer.address() as AddressInfo).port}`;

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.FERNET_KEY = TEST_FERNET_KEY;
    // Pinned off so a dev .env with DBOS_ENABLED=true can't leak in — this suite asserts async → 409.
    process.env.DBOS_ENABLED = 'false';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => echoServer.close((e) => (e ? reject(e) : resolve())));
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  it('runs a pure (no-auth) plan and returns the outputs', async () => {
    const plan = {
      id: 'greet',
      nodes: [
        {
          kind: 'action',
          id: 'hello',
          actionId: 'text.concat',
          props: { texts: ['Hello ', 'World'], separator: '' },
        },
      ],
    };
    const res = await request(app.getHttpServer()).post('/api/runs').send({ plan }).expect(201);
    expect(res.body.planId).toBe('greet');
    expect(res.body.outputs.hello).toBe('Hello World');
  });

  it('runs a plan with a network step + control flow + data passing', async () => {
    const plan = {
      id: 'flow',
      nodes: [
        {
          kind: 'action',
          id: 'call',
          actionId: 'http.send_request',
          props: { method: 'GET', url: `${echoUrl}/x` },
        },
        {
          kind: 'if',
          id: 'gate',
          condition: { left: '{{call.status}}', op: 'eq', right: 200 },
          then: [
            {
              kind: 'action',
              id: 'ok',
              actionId: 'text.concat',
              props: { texts: ['status-', '{{call.body.path}}'], separator: '' },
            },
          ],
        },
      ],
    };
    const res = await request(app.getHttpServer()).post('/api/runs').send({ plan }).expect(201);
    expect(res.body.outputs.call.status).toBe(200);
    expect(res.body.outputs.ok).toBe('status-/x');
  });

  it('surfaces an error for an unregistered action', async () => {
    const plan = {
      id: 'bad',
      nodes: [{ kind: 'action', id: 'x', actionId: 'nope.do', props: {} }],
    };
    const res = await request(app.getHttpServer()).post('/api/runs').send({ plan });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects a body with no plan (validation)', async () => {
    await request(app.getHttpServer()).post('/api/runs').send({ notplan: true }).expect(400);
  });

  it('async endpoints require DBOS — 409 when DBOS_ENABLED is off', async () => {
    const plan = {
      id: 'x',
      nodes: [
        {
          kind: 'action',
          id: 'a',
          actionId: 'text.concat',
          props: { texts: ['a'], separator: '' },
        },
      ],
    };
    await request(app.getHttpServer()).post('/api/runs/async').send({ plan }).expect(409);
    // getRun answers from run HISTORY now (no DBOS needed) — unknown id → not_found.
    const missing = await request(app.getHttpServer()).get('/api/runs/some-id').expect(200);
    expect(missing.body.status).toBe('not_found');
    // Event delivery no longer needs DBOS either — an unknown run is a plain 404.
    await request(app.getHttpServer())
      .post('/api/runs/some-id/events')
      .send({ topic: 't', payload: {} })
      .expect(404);
  });

  it('run history: direct runs land in GET /api/runs with a per-step log (Track B)', async () => {
    const plan = {
      id: 'hist',
      nodes: [
        {
          kind: 'action',
          id: 'one',
          actionId: 'text.concat',
          props: { texts: ['a', 'b'], separator: '' },
        },
        {
          kind: 'action',
          id: 'two',
          // concat outputs a plain string, so the whole upstream output is the ref
          actionId: 'text.concat',
          props: { texts: ['{{one}}', '!'], separator: '' },
        },
      ],
    };
    await request(app.getHttpServer()).post('/api/runs').send({ plan, run_id: 'hist-run-1' }).expect(201);

    const detail = await request(app.getHttpServer()).get('/api/runs/hist-run-1').expect(200);
    expect(detail.body.status).toBe('completed');
    expect(detail.body.finished_at).toBeTruthy();
    const steps = detail.body.steps as Array<Record<string, unknown>>;
    expect(steps.map((s) => s.node_id)).toEqual(['one', 'two']);
    expect(steps.every((s) => s.status === 'completed')).toBe(true);

    const list = await request(app.getHttpServer()).get('/api/runs').expect(200);
    const mine = (list.body.runs as Array<Record<string, unknown>>).find((r) => r.run_id === 'hist-run-1');
    expect(mine?.status).toBe('completed');
    expect(mine?.plan_id).toBe('hist');
    expect(mine?.version_number).toBeNull(); // direct runs carry no workflow version
  });

  it('run history: an oversized step output is capped ALONE — the rest of the map survives, with a head', async () => {
    const big = 'x'.repeat(20_000);
    const plan = {
      id: 'cap',
      nodes: [
        { kind: 'action', id: 'huge', actionId: 'text.concat', props: { texts: [big], separator: '' } },
        {
          kind: 'action',
          id: 'small',
          actionId: 'text.concat',
          props: { texts: ['still', 'here'], separator: '-' },
        },
      ],
    };
    await request(app.getHttpServer()).post('/api/runs').send({ plan, run_id: 'cap-run-1' }).expect(201);

    const detail = await request(app.getHttpServer()).get('/api/runs/cap-run-1').expect(200);
    // The small step is still readable: one oversized value must not blind the whole run.
    expect(detail.body.outputs.small).toBe('still-here');
    // The oversized one is marked with its real size and keeps a head, rather than being dropped.
    expect(detail.body.outputs.huge).toMatchObject({
      truncated: true,
      size_chars: big.length + 2,
      max_chars: 16_000,
    });
    expect(String(detail.body.outputs.huge.preview)).toMatch(/^"x{100}/);

    const steps = detail.body.steps as Array<Record<string, unknown>>;
    const hugeStep = steps.find((s) => s.node_id === 'huge')!;
    const smallStep = steps.find((s) => s.node_id === 'small')!;
    expect(hugeStep.output_truncated).toEqual({ size_chars: big.length + 2, max_chars: 16_000 });
    // The preview field shows the value's head — not the marker repeating itself.
    expect(String(hugeStep.output_preview)).toMatch(/^"x{100}/);
    expect(smallStep.output).toBe('still-here');
    expect(smallStep.output_truncated).toBeNull();
  });

  it('run history: a failing step records error on the step AND the run', async () => {
    const plan = {
      id: 'hist-bad',
      nodes: [{ kind: 'action', id: 'boom', actionId: 'text.nope', props: {} }],
    };
    const res = await request(app.getHttpServer()).post('/api/runs').send({ plan, run_id: 'hist-run-2' });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const detail = await request(app.getHttpServer()).get('/api/runs/hist-run-2').expect(200);
    expect(detail.body.status).toBe('error');
    expect(detail.body.error).toBeTruthy();
    const steps = detail.body.steps as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe('error');
    expect(steps[0]!.error).toBeTruthy();
  });

  it('run history: a from-ir COMPILE failure is still recorded as a failed run', async () => {
    // An IR the compiler rejects (unmapped node type) — the 400 must still leave a run row.
    const workflow_ir = {
      version: '1',
      name: 'uncompilable',
      description: '',
      nodes: [
        {
          id: 'mystery',
          name: 'Mystery Step',
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
    const res = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir, run_id: 'hist-run-compile-fail' })
      .expect(400);
    expect(String(res.body.detail)).toContain(
      'Step "Mystery Step" isn\'t runnable on this engine yet (mystery)',
    );

    // The attempt survives in run history with the humanized error.
    const list = await request(app.getHttpServer()).get('/api/runs').expect(200);
    const mine = (list.body.runs as Array<Record<string, unknown>>).find(
      (r) => r.run_id === 'hist-run-compile-fail',
    );
    expect(mine?.status).toBe('error');
    expect(String(mine?.error)).toContain('Step "Mystery Step" isn\'t runnable on this engine yet');
    expect(mine?.source).toBe('manual');

    const detail = await request(app.getHttpServer()).get('/api/runs/hist-run-compile-fail').expect(200);
    expect(detail.body.status).toBe('error');
    expect(detail.body.finished_at).toBeTruthy();
  });

  it('true pinning: a pinned step REPLAYS its output — the provider is never called', async () => {
    // The pinned node's action would FAIL if executed, so the run can only succeed if the pin
    // short-circuits the provider call entirely.
    const workflow_ir = {
      version: '1',
      name: 'pinned',
      description: '',
      nodes: [
        {
          id: 'boom',
          name: 'boom',
          node_type: 'nope.do', // unregistered → throws if the provider is called
          type_version: 1,
          parameters: {},
          position: { x: 0, y: 0 },
          metadata: {},
        },
        {
          id: 'after',
          name: 'after',
          node_type: 'text.concat',
          type_version: 1,
          parameters: { texts: ['got-', '{{boom.value}}'], separator: '' },
          position: { x: 0, y: 0 },
          metadata: {},
        },
      ],
      edges: [
        {
          id: 'e',
          source_node_id: 'boom',
          source_port: 0,
          target_node_id: 'after',
          target_port: 0,
          port_type: 'main',
        },
      ],
      settings: { execution_order: 'v1', extra: {} },
      metadata: {},
    };

    const res = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir, pins: { boom: { value: 'PINNED' } }, run_id: 'pin-run-1' })
      .expect(201);
    // The pinned step replayed its captured output (the provider was never called)...
    expect(res.body.outputs.boom).toEqual({ value: 'PINNED' });
    // ...and the downstream step composed against the replayed value (scope wiring).
    expect(res.body.outputs.after).toBe('got-PINNED');

    // CONTROL: without the pin, the same IR FAILS — because the provider IS called.
    const control = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir, run_id: 'pin-run-control' });
    expect(control.status).toBeGreaterThanOrEqual(400);

    // Run history is honest: the replayed step is flagged `pinned`, the executed one is not.
    const detail = await request(app.getHttpServer()).get('/api/runs/pin-run-1').expect(200);
    expect(detail.body.status).toBe('completed');
    const steps = detail.body.steps as Array<Record<string, unknown>>;
    const boomStep = steps.find((s) => s.node_id === 'boom');
    expect(boomStep?.status).toBe('completed');
    expect(boomStep?.pinned).toBe(true);
    expect(steps.find((s) => s.node_id === 'after')?.pinned).toBe(false);
  });

  it('continue-on-fail: an errored step with onError:"continue" lets the run go on', async () => {
    // `boom` throws if executed; onError:"continue" must capture the error into scope instead of halting.
    const boom = (parameters: Record<string, unknown>) => ({
      id: 'boom',
      name: 'boom',
      node_type: 'nope.do', // unregistered → throws when executed
      type_version: 1,
      parameters,
      position: { x: 0, y: 0 },
      metadata: {},
    });
    const after = {
      id: 'after',
      name: 'after',
      node_type: 'text.concat',
      type_version: 1,
      parameters: { texts: ['errored: ', '{{boom.error.message}}'], separator: '' },
      position: { x: 0, y: 0 },
      metadata: {},
    };
    const edges = [
      {
        id: 'e',
        source_node_id: 'boom',
        source_port: 0,
        target_node_id: 'after',
        target_port: 0,
        port_type: 'main',
      },
    ];
    const base = {
      version: '1',
      name: 'continue',
      description: '',
      edges,
      settings: { execution_order: 'v1', extra: {} },
      metadata: {},
    };

    const res = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({
        workflow_ir: { ...base, nodes: [boom({ onError: 'continue' }), after] },
        run_id: 'continue-run-1',
      })
      .expect(201);
    // The run COMPLETED despite boom throwing; boom's captured error sits in scope...
    expect(res.body.outputs.boom).toEqual({ error: { message: expect.any(String) }, __errored: true });
    // ...and the downstream step composed against the captured error message.
    expect(String(res.body.outputs.after)).toContain('errored: ');

    // CONTROL: the SAME throw without the policy HALTS the run (status >= 400).
    const control = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir: { ...base, nodes: [boom({}), after] }, run_id: 'continue-run-control' });
    expect(control.status).toBeGreaterThanOrEqual(400);

    // Run history is honest: boom is status='error' but flagged `continued`.
    const detail = await request(app.getHttpServer()).get('/api/runs/continue-run-1').expect(200);
    expect(detail.body.status).toBe('completed');
    const steps = detail.body.steps as Array<Record<string, unknown>>;
    const boomStep = steps.find((s) => s.node_id === 'boom');
    expect(boomStep?.status).toBe('error');
    expect(boomStep?.continued).toBe(true);
    expect(steps.find((s) => s.node_id === 'after')?.continued).toBe(false);
  });

  it('retry-on-fail: a failing step is retried up to maxAttempts', async () => {
    const boom = (parameters: Record<string, unknown>) => ({
      id: 'boom',
      name: 'boom',
      node_type: 'nope.do', // unregistered → throws every attempt
      type_version: 1,
      parameters,
      position: { x: 0, y: 0 },
      metadata: {},
    });
    const base = {
      version: '1',
      name: 'retry',
      description: '',
      edges: [],
      settings: { execution_order: 'v1', extra: {} },
      metadata: {},
    };

    // 3 attempts, all failing → the run fails and the step records attempts=3.
    const run = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({
        workflow_ir: { ...base, nodes: [boom({ retry: { maxAttempts: 3, backoffMs: 1 } })] },
        run_id: 'retry-run-1',
      });
    expect(run.status).toBeGreaterThanOrEqual(400);
    const detail = await request(app.getHttpServer()).get('/api/runs/retry-run-1').expect(200);
    const retried = (detail.body.steps as Array<Record<string, unknown>>).find((s) => s.node_id === 'boom');
    expect(retried?.attempts).toBe(3);
    expect(retried?.status).toBe('error');

    // CONTROL: no retry policy → a single attempt.
    await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir: { ...base, nodes: [boom({})] }, run_id: 'retry-control' });
    const ctl = await request(app.getHttpServer()).get('/api/runs/retry-control').expect(200);
    expect(
      (ctl.body.steps as Array<Record<string, unknown>>).find((s) => s.node_id === 'boom')?.attempts,
    ).toBe(1);

    // COMPOSES with continue-on-fail: retries exhaust, then the failure is tolerated.
    const combo = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({
        workflow_ir: {
          ...base,
          nodes: [boom({ retry: { maxAttempts: 2, backoffMs: 1 }, onError: 'continue' })],
        },
        run_id: 'retry-continue-1',
      })
      .expect(201);
    expect(combo.body.outputs.boom).toEqual({ error: { message: expect.any(String) }, __errored: true });
    const comboStep = (
      (await request(app.getHttpServer()).get('/api/runs/retry-continue-1').expect(200)).body.steps as Array<
        Record<string, unknown>
      >
    ).find((s) => s.node_id === 'boom');
    expect(comboStep?.attempts).toBe(2);
    expect(comboStep?.continued).toBe(true);
  });

  it('error output: a throwing step routes to its error lane, skipping the main successor', async () => {
    // `boom` throws and has both a `main` and an `error` outgoing edge — only the error lane may run.
    const concat = (id: string, texts: string[]) => ({
      id,
      name: id,
      node_type: 'text.concat',
      type_version: 1,
      parameters: { texts, separator: '' },
      position: { x: 0, y: 0 },
      metadata: {},
    });
    const workflow_ir = {
      version: '1',
      name: 'error-output',
      description: '',
      nodes: [
        {
          id: 'boom',
          name: 'boom',
          node_type: 'nope.do',
          type_version: 1,
          parameters: {},
          position: { x: 0, y: 0 },
          metadata: {},
        },
        concat('main_after', ['MAIN-RAN']),
        concat('handler', ['handled: ', '{{boom.error.message}}']),
      ],
      edges: [
        {
          id: 'e-main',
          source_node_id: 'boom',
          source_port: 0,
          target_node_id: 'main_after',
          target_port: 0,
          port_type: 'main',
        },
        {
          id: 'e-err',
          source_node_id: 'boom',
          source_port: 0,
          target_node_id: 'handler',
          target_port: 0,
          port_type: 'error',
        },
      ],
      settings: { execution_order: 'v1', extra: {} },
      metadata: {},
    };
    const res = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir, run_id: 'error-output-1' })
      .expect(201);
    expect(String(res.body.outputs.handler)).toContain('handled: '); // the error lane ran + composed the captured error
    expect(res.body.outputs.main_after).toBeUndefined(); // the main successor was skipped — never both lanes
    const detail = await request(app.getHttpServer()).get('/api/runs/error-output-1').expect(200);
    expect(detail.body.status).toBe('completed'); // the error lane replaced the halt
  });

  it('compiles + runs a WorkflowIR (from-ir): topo order + cross-node ref', async () => {
    const node = (id: string, url: string) => ({
      id,
      name: id,
      node_type: 'http.send_request',
      type_version: 1,
      parameters: { method: 'GET', url },
      position: { x: 0, y: 0 },
      metadata: {},
    });
    const workflow_ir = {
      version: '1',
      name: 'from-ir-test',
      description: '',
      nodes: [
        node('use', `${echoUrl}/echo?token={{ $node["fetch"].json.path }}`),
        node('fetch', `${echoUrl}/data`),
      ],
      edges: [
        {
          id: 'e',
          source_node_id: 'fetch',
          source_port: 0,
          target_node_id: 'use',
          target_port: 0,
          port_type: 'main',
        },
      ],
      settings: { execution_order: 'v1', extra: {} },
      metadata: {},
    };
    const res = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir })
      .expect(201);
    expect(res.body.outputs.fetch.body.path).toBe('/data');
    // The upstream output ('/data') flowed into the downstream node's URL (decoded back from the query).
    expect(res.body.outputs.use.body.token).toBe('/data');
  });

  it('from-ir runs a GENERATED-shaped workflow: webhook trigger + IF + $json (trigger_payload)', async () => {
    // The trigger compiles away; trigger_payload supplies its event to the $json expressions.
    const node = (
      id: string,
      node_type: string,
      parameters: Record<string, unknown>,
    ): Record<string, unknown> => ({
      id,
      name: id,
      node_type,
      type_version: 2,
      parameters,
      position: { x: 0, y: 0 },
      metadata: {},
    });
    const edge = (source: string, target: string, port = 0): Record<string, unknown> => ({
      id: `${source}->${target}`,
      source_node_id: source,
      source_port: port,
      target_node_id: target,
      target_port: 0,
      port_type: 'main',
    });
    const workflow_ir = {
      version: '1',
      name: 'branching',
      description: '',
      nodes: [
        node('hook', 'orchestr:webhook', { httpMethod: 'POST', path: 'wf-x' }),
        node('check', 'orchestr:if', { left: '{{ $json.status }}', op: 'eq', right: 'active' }),
        node('active_path', 'http.send_request', {
          method: 'GET',
          url: `=${echoUrl}/echo?token={{ $json.user }}`,
        }),
        node('inactive_path', 'http.send_request', {
          method: 'GET',
          url: `${echoUrl}/echo?token=skipped`,
        }),
      ],
      edges: [edge('hook', 'check'), edge('check', 'active_path'), edge('check', 'inactive_path', 1)],
      settings: { execution_order: 'v1', extra: {} },
      metadata: {},
    };

    const res = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir, trigger_payload: { status: 'active', user: 'ada' } })
      .expect(201);
    // True branch ran with the trigger payload; false branch never fired.
    expect(res.body.outputs.active_path.body.token).toBe('ada');
    expect(res.body.outputs.inactive_path).toBeUndefined();

    // And the payload flipping the condition takes the OTHER branch.
    const other = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir, trigger_payload: { status: 'archived', user: 'ada' } })
      .expect(201);
    expect(other.body.outputs.inactive_path.body.token).toBe('skipped');
    expect(other.body.outputs.active_path).toBeUndefined();
  });
});
