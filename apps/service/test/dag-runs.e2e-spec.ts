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

/** Compiled IR and raw plans both lower onto the ONE DagInterpreter; DBOS off (direct path). */
describe('runs endpoint on the general-DAG engine (e2e, isolated DB)', () => {
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
  }, 30_000);

  it('DAG path: compiles + runs a linear WorkflowIR (topo order + cross-node ref)', async () => {
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
      name: 'dag-from-ir',
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
    expect(res.body.outputs.use.body.token).toBe('/data');
  });

  it('DAG path: webhook trigger + IF + $json routes to exactly one branch (generated shape)', async () => {
    const node = (id: string, node_type: string, parameters: Record<string, unknown>) => ({
      id,
      name: id,
      node_type,
      type_version: 2,
      parameters,
      position: { x: 0, y: 0 },
      metadata: {},
    });
    const edge = (source: string, target: string, port = 0) => ({
      id: `${source}->${target}`,
      source_node_id: source,
      source_port: port,
      target_node_id: target,
      target_port: 0,
      port_type: 'main',
    });
    const workflow_ir = {
      version: '1',
      name: 'dag-branching',
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
    expect(res.body.outputs.active_path.body.token).toBe('ada');
    expect(res.body.outputs.inactive_path).toBeUndefined();

    const other = await request(app.getHttpServer())
      .post('/api/runs/from-ir')
      .send({ workflow_ir, trigger_payload: { status: 'archived', user: 'ada' } })
      .expect(201);
    expect(other.body.outputs.inactive_path.body.token).toBe('skipped');
    expect(other.body.outputs.active_path).toBeUndefined();
  });

  it('DAG path: error output routes the error lane, skips the main successor, run completes', async () => {
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
      name: 'dag-error-output',
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
      .send({ workflow_ir, run_id: 'dag-error-output-1' })
      .expect(201);
    expect(String(res.body.outputs.handler)).toContain('handled: ');
    expect(res.body.outputs.main_after).toBeUndefined();
    const detail = await request(app.getHttpServer()).get('/api/runs/dag-error-output-1').expect(200);
    expect(detail.body.status).toBe('completed');
  });

  it('DAG path: continue-on-fail tolerates a throw and composes against the captured error', async () => {
    const workflow_ir = {
      version: '1',
      name: 'dag-continue',
      description: '',
      nodes: [
        {
          id: 'boom',
          name: 'boom',
          node_type: 'nope.do',
          type_version: 1,
          parameters: { onError: 'continue' },
          position: { x: 0, y: 0 },
          metadata: {},
        },
        {
          id: 'after',
          name: 'after',
          node_type: 'text.concat',
          type_version: 1,
          parameters: { texts: ['errored: ', '{{boom.error.message}}'], separator: '' },
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
      .send({ workflow_ir, run_id: 'dag-continue-1' })
      .expect(201);
    expect(res.body.outputs.boom).toEqual({ error: { message: expect.any(String) }, __errored: true });
    expect(String(res.body.outputs.after)).toContain('errored: ');
  });

  it('DAG path: a raw POST /runs plan (nested-tree) lowers through runPlanToDag onto the one engine', async () => {
    // A client-supplied nested-tree RunPlan is lowered to a DagPlan and runs on the same engine.
    const plan = {
      id: 'raw',
      nodes: [
        {
          kind: 'action',
          id: 'hello',
          actionId: 'text.concat',
          props: { texts: ['Hello ', 'DAG'], separator: '' },
        },
      ],
    };
    const res = await request(app.getHttpServer()).post('/api/runs').send({ plan }).expect(201);
    expect(res.body.outputs.hello).toBe('Hello DAG');
  });
});
