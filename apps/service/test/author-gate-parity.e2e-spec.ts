import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/**
 * The author-time gate and the compiler must agree on the SAME document (ADR 0052). Every case here
 * is a document the gate once called valid and the compiler then silently mutilated — or a stored
 * document the diff could not read, which took invariant #3 ("a no-diff commit mints nothing") with it.
 */
describe('author-gate ↔ compiler parity (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let db: Client;

  const node = (id: string, nodeType: string, parameters: Record<string, unknown> = {}) => ({
    id,
    name: id,
    node_type: nodeType,
    type_version: 1,
    parameters,
    position: { x: 0, y: 0 },
    metadata: {},
  });
  /** An edge that names NO lane — the shape a hand-written document and the client both produce. */
  const laneless = (from: string, to: string, sourcePort = 0): Record<string, unknown> => ({
    id: `${from}->${to}:${sourcePort}`,
    source_node_id: from,
    source_port: sourcePort,
    target_node_id: to,
    target_port: 0,
  });
  const doc = (
    name: string,
    nodes: Array<Record<string, unknown>>,
    edges: Array<Record<string, unknown>>,
  ): Record<string, unknown> => ({
    version: '1',
    name,
    description: '',
    nodes,
    edges,
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  });

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.DBOS_ENABLED = 'false';

    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    await request(app.getHttpServer()).get('/api/auth/me').expect(200);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  const http = () => request(app.getHttpServer());

  it('an edge that omits port_type commits AND compiles as a real main-lane guard', async () => {
    const branching = doc(
      'laneless edges',
      [
        node('hook', 'orchestr:webhook', { httpMethod: 'POST', path: 'parity-lane' }),
        node('check', 'orchestr:if', { left: '{{ $json.status }}', op: 'eq', right: 'active' }),
        node('active_path', 'text.concat', { texts: ['active'], separator: '' }),
        node('inactive_path', 'text.concat', { texts: ['inactive'], separator: '' }),
      ],
      [laneless('hook', 'check'), laneless('check', 'active_path'), laneless('check', 'inactive_path', 1)],
    );

    // The gate accepts it …
    const dep = await http().post('/api/deploy').send({ workflow_json: branching }).expect(201);
    const wf = dep.body.workflow_id as string;

    // … and the compiler routes it. A DROPPED edge would leave both branches unconditional roots,
    // so both would produce output regardless of the condition.
    const active = await http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: branching, trigger_payload: { status: 'active' } })
      .expect(201);
    expect(active.body.outputs.active_path).toBeDefined();
    expect(active.body.outputs.inactive_path).toBeUndefined();

    const archived = await http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: branching, trigger_payload: { status: 'archived' } })
      .expect(201);
    expect(archived.body.outputs.inactive_path).toBeDefined();
    expect(archived.body.outputs.active_path).toBeUndefined();

    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('refuses the two wirings the compiler would drop in silence: an unknown lane, a tool edge to a trigger', async () => {
    const seed = doc(
      'parity refusals',
      [node('start', 'orchestr:trigger'), node('step', 'text.concat', { texts: ['hi'], separator: '' })],
      [laneless('start', 'step')],
    );
    const dep = await http().post('/api/deploy').send({ workflow_json: seed }).expect(201);
    const wf = dep.body.workflow_id as string;

    // (a) A lane nothing routes — the edge would reach no step at all.
    const badLane = doc('parity refusals', seed.nodes as Array<Record<string, unknown>>, [
      { ...laneless('start', 'step'), port_type: 'sideways' },
    ]);
    const lane = await http().post(`/api/workflows/${wf}/commit`).send({ workflow_ir: badLane }).expect(422);
    expect(lane.body.code).toBe('unknown_edge_port_type');
    expect(String(lane.body.detail)).toMatch(/main.*error.*tool/is);

    // (b) A tool edge onto a trigger. Every trigger is peeled BEFORE the tool peel, so the binding
    // would vanish and the agent would run with no tools at all.
    const toolToTrigger = doc(
      'parity refusals',
      [node('start', 'orchestr:tool_trigger'), node('brain', 'orchestr:agent', { system_prompt: 'hi' })],
      [{ ...laneless('brain', 'start'), port_type: 'tool' }],
    );
    const bound = await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: toolToTrigger })
      .expect(422);
    expect(bound.body.code).toBe('tool_edge_ineligible_target');

    // Nothing landed — the branch is still on its single deployed version.
    const versions = await http().get(`/api/workflows/${wf}/versions?branch=main`).expect(200);
    expect(versions.body.versions).toHaveLength(1);

    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('a catalog trigger authored as a step is refused for its MISSING MARKER, not as an unknown type', async () => {
    const nodes = [
      { ...node('trigger', 'rss.new_item', { url: 'https://example.com/feed.xml' }) },
      node('step', 'text.concat', { texts: ['hi'], separator: '' }),
    ];
    const unmarked = doc('marker diagnosis', nodes, [laneless('trigger', 'step')]);

    const refused = await http().post('/api/deploy').send({ workflow_json: unmarked }).expect(422);
    expect(refused.body.code).toBe('trigger_not_marked');
    expect(String(refused.body.detail)).toContain('"metadata": {"trigger": true}');
    expect(String(refused.body.detail)).not.toContain("isn't in the catalog");

    // The document the message asks for is the document that deploys.
    const marked = doc(
      'marker diagnosis',
      [{ ...nodes[0], metadata: { trigger: true } }, nodes[1]] as Array<Record<string, unknown>>,
      [laneless('trigger', 'step')],
    );
    const deployed = await http().post('/api/deploy').send({ workflow_json: marked }).expect(201);
    await http()
      .delete(`/api/workflows/${deployed.body.workflow_id as string}`)
      .expect(200);
  });

  it('a stored version with no node positions still diffs, and re-committing it mints nothing', async () => {
    const seed = doc(
      'legacy layout',
      [node('start', 'orchestr:trigger'), node('step', 'text.concat', { texts: ['hi'], separator: '' })],
      [{ ...laneless('start', 'step'), port_type: 'main' }],
    );
    const dep = await http().post('/api/deploy').send({ workflow_json: seed }).expect(201);
    const wf = dep.body.workflow_id as string;

    // Age the stored head into the legacy shape — the way such documents exist in the wild.
    const legacy = structuredClone(seed) as unknown as { nodes: Array<Record<string, unknown>> };
    for (const n of legacy.nodes) delete n.position;
    await db.query(
      `UPDATE workflow_versions SET workflow_json = $1, workflow_ir = $1 WHERE workflow_id = $2`,
      [JSON.stringify(legacy), wf],
    );

    // The diff view answers rather than 500ing on this workflow forever.
    await http().get(`/api/workflows/${wf}/diff?from_version=1&to_version=1&branch=main`).expect(200);

    // Invariant #3 holds against the document the head comparison used to choke on (and swallow).
    const again = await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: legacy, branch: 'main' })
      .expect(201);
    expect(again.body.no_changes).toBe(true);
    const versions = await http().get(`/api/workflows/${wf}/versions?branch=main`).expect(200);
    expect(versions.body.versions).toHaveLength(1);

    await http().delete(`/api/workflows/${wf}`).expect(200);
  });
});
