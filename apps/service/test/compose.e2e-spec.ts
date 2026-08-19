import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** The composer surface over HTTP: catalog search + draft apply-ops, with no LLM involved. */
describe('compose slice (e2e, mock auth)', () => {
  let app: INestApplication;
  let db: Client;

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.LLM_PROVIDER = 'mock';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';
    // Composio projection OFF: the trigger half of the vocabulary makes no live call.

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  it('GET /api/compose/catalog → real catalog rows for the acceptance scenario', async () => {
    const slack = await request(app.getHttpServer())
      .get('/api/compose/catalog')
      .query({ q: 'post a message to a slack channel' })
      .expect(200);
    const types = (slack.body.results as Array<{ type: string }>).map((r) => r.type);
    expect(types).toContain('slack.send_channel_message');
    // The catalog is native-only — no legacy vendor node types leak in.
    expect(types.some((t) => t.startsWith('n8n-nodes-base.'))).toBe(false);

    const branching = await request(app.getHttpServer())
      .get('/api/compose/catalog')
      .query({ q: 'branch if amount greater than 500' })
      .expect(200);
    const branchTypes = (branching.body.results as Array<{ type: string }>).map((r) => r.type);
    expect(branchTypes).toContain('orchestr:if');
  });

  it('GET /api/compose/catalog without q → 400', async () => {
    await request(app.getHttpServer()).get('/api/compose/catalog').expect(400);
  });

  it('GET /api/compose/catalog?type= → one action with its FULL parameter schema; 404 unknown', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/compose/catalog')
      .query({ type: 'slack.send_channel_message' })
      .expect(200);
    expect(res.body.entry.type).toBe('slack.send_channel_message');
    const params = res.body.entry.parameters as Record<string, { required?: boolean }>;
    expect(Object.keys(params).length).toBeGreaterThan(1);
    expect(params.channel).toBeDefined();

    const control = await request(app.getHttpServer())
      .get('/api/compose/catalog')
      .query({ type: 'orchestr:if' })
      .expect(200);
    expect(control.body.entry.parameters.op).toBeDefined();

    await request(app.getHttpServer())
      .get('/api/compose/catalog')
      .query({ type: 'slack.summon_dragon' })
      .expect(404);
  });

  it('POST /api/compose/apply-ops builds a draft graph and computes positions', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/compose/apply-ops')
      .send({
        ir: null,
        ops: [
          { op: 'add_node', node: { id: 'trigger', name: 'Form submitted', node_type: 'orchestr:trigger' } },
          {
            op: 'add_node',
            node: {
              id: 'check_amount',
              node_type: 'orchestr:if',
              parameters: { left: '{{trigger.amount}}', op: 'gt', right: '500' },
            },
          },
          { op: 'add_node', node: { id: 'notify', node_type: 'slack.send_channel_message' } },
          { op: 'connect', source_node_id: 'trigger', target_node_id: 'check_amount' },
          { op: 'connect', source_node_id: 'check_amount', target_node_id: 'notify', source_port: 0 },
        ],
      })
      .expect(201);

    const ir = res.body.ir as {
      nodes: Array<{ id: string; position: { x: number; y: number } }>;
      edges: unknown[];
    };
    expect(ir.nodes.map((n) => n.id)).toEqual(['trigger', 'check_amount', 'notify']);
    expect(ir.edges).toHaveLength(2);
    expect(ir.nodes.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true);

    // Second batch continues from the returned draft.
    const res2 = await request(app.getHttpServer())
      .post('/api/compose/apply-ops')
      .send({
        ir: res.body.ir,
        ops: [
          { op: 'add_node', node: { id: 'log_it', node_type: 'sheets.insert_row' } },
          { op: 'connect', source_node_id: 'check_amount', target_node_id: 'log_it', source_port: 1 },
        ],
      })
      .expect(201);
    expect((res2.body.ir as { nodes: unknown[] }).nodes).toHaveLength(4);
  });

  it('POST /api/compose/merge reconciles co-edits and reports real conflicts (A3)', async () => {
    const node = (id: string, params: Record<string, unknown>, x = 0) => ({
      id,
      name: id,
      node_type: 'http.send_request',
      type_version: 1,
      parameters: params,
      position: { x, y: 0 },
      metadata: {},
    });
    const doc = (nodes: unknown[]) => ({
      version: '1',
      name: 'wf',
      description: '',
      nodes,
      edges: [],
      settings: { execution_order: 'v1', extra: {} },
      metadata: {},
    });
    const base = doc([node('a', { url: 'x' })]);
    const ours = doc([node('a', { url: 'mine' }, 42)]);
    const theirs = doc([node('a', { url: 'agents' }), node('b', { url: 'new' })]);

    const res = await request(app.getHttpServer())
      .post('/api/compose/merge')
      .send({ base, ours, theirs })
      .expect(201);
    const merged = res.body.merged as {
      nodes: Array<{ id: string; parameters: { url: string }; position: { x: number } }>;
    };
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']); // agent's new node + user's node
    expect(merged.nodes.find((n) => n.id === 'a')!.parameters.url).toBe('mine'); // user wins provisionally
    expect(merged.nodes.find((n) => n.id === 'a')!.position.x).toBe(42); // user position wins
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0]).toMatchObject({
      node_id: 'a',
      field_path: 'parameters.url',
      ours: 'mine',
      theirs: 'agents',
    });

    await request(app.getHttpServer())
      .post('/api/compose/merge')
      .send({ base, ours: { nodes: 'nope' }, theirs })
      .expect(422);
  });

  it('POST /api/compose/apply-ops rejects hallucinated action types with 422 + agent-facing detail', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/compose/apply-ops')
      .send({
        ops: [{ op: 'add_node', node: { id: 'x', node_type: 'slack.summon_dragon' } }],
      })
      .expect(422);
    expect(res.body.detail).toMatch(/unknown action type "slack\.summon_dragon"/);
    expect(res.body.detail).toMatch(/search_catalog/);
  });

  it('POST /api/compose/apply-ops rejects an empty batch and a malformed ir', async () => {
    await request(app.getHttpServer()).post('/api/compose/apply-ops').send({ ops: [] }).expect(422);
    const res = await request(app.getHttpServer())
      .post('/api/compose/apply-ops')
      .send({ ir: { nodes: 'nope' }, ops: [{ op: 'remove_node', node_id: 'x' }] })
      .expect(422);
    expect(res.body.detail).toMatch(/WorkflowIR/);
  });
});
