import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/**
 * The author-time gate and the compiler must agree on the SAME document. Every case here
 * is a document the gate once called valid and the compiler then silently mutilated — or a stored
 * document the diff could not read, which took invariant #3 ("a no-diff commit mints nothing") with it.
 */
describe('author-gate ↔ compiler parity (e2e, isolated DB, mock auth)', () => {
  let app: INestApplication;
  let db: Client;
  let feedServer: Server;
  let feedUrl: string;

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
    feedServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end('<rss version="2.0"><channel><title>parity</title></channel></rss>');
    });
    await new Promise<void>((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
    feedUrl = `http://127.0.0.1:${(feedServer.address() as AddressInfo).port}/feed.xml`;

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'true';
    process.env.DBOS_ENABLED = 'false';

    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }),
      })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    await request(app.getHttpServer()).get('/api/auth/me').expect(200);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    await new Promise<void>((resolve, reject) => feedServer.close((e) => (e ? reject(e) : resolve())));
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
      { ...node('trigger', 'rss.new_item', { url: feedUrl }) },
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

  const triggerRefusal = (type: string): Record<string, unknown> => ({
    code: 'unknown_trigger_type',
    node_id: 'start',
    node_type: type,
    detail: `Node "start" is this workflow's trigger, but "${type}" is not a known trigger type — pick one from the trigger picker, or search the catalog for kind "trigger" and copy its exact "type"; the built-in ones are orchestr:trigger, orchestr:webhook, orchestr:schedule, orchestr:chat, orchestr:tool_trigger. As it is, the trigger never fires.`,
  });
  const languageRefusal = (language: unknown): string =>
    `Code node "calc" has "language": ${JSON.stringify(language)}, which the sandbox does not run — set it to "js" or "ts", or remove it for "js"`;
  const withCode = (parameters: Record<string, unknown>): Record<string, unknown> =>
    doc(
      'code languages',
      [node('start', 'orchestr:trigger'), node('calc', 'orchestr:code', parameters)],
      [laneless('start', 'calc')],
    );
  const versionsOn = async (wf: string, branch: string): Promise<number> =>
    (
      (await http().get(`/api/workflows/${wf}/versions?branch=${branch}`).expect(200)).body
        .versions as unknown[]
    ).length;

  it('a trigger no rail can fire is refused at create, at save and at an editor run; every native kind and an app trigger save', async () => {
    const step = node('step', 'text.concat', { texts: ['hi'], separator: '' });
    const withTrigger = (trigger: Record<string, unknown>): Record<string, unknown> =>
      doc('trigger kinds', [trigger, step], [laneless('start', 'step')]);
    const marked = (type: string): Record<string, unknown> => ({
      ...node('start', type),
      metadata: { trigger: true },
    });

    const created = await http()
      .post('/api/deploy')
      .send({ workflow_json: withTrigger(marked('orchestr:webhok')) })
      .expect(422);
    expect(created.body).toMatchObject(triggerRefusal('orchestr:webhok'));

    const dep = await http()
      .post('/api/deploy')
      .send({ workflow_json: withTrigger(node('start', 'orchestr:trigger')) })
      .expect(201);
    const wf = dep.body.workflow_id as string;
    const save = (trigger: Record<string, unknown>): request.Test =>
      http()
        .post(`/api/workflows/${wf}/commit`)
        .send({ workflow_ir: withTrigger(trigger) });

    // Each names no app — an app trigger is `<app>.<trigger>`, its app a lowercase slug and never the built-in nodes' `orchestr` — so no listing is asked.
    for (const trigger of [
      node('start', 'form_trigger'),
      ...['Acme.new_deal', '.new_deal', 'gmail.', 'orchestr.webhook'].map(marked),
    ]) {
      const type = trigger.node_type as string;
      const deployed = await http()
        .post('/api/deploy')
        .send({ workflow_json: withTrigger(trigger) })
        .expect(422);
      expect(deployed.body).toMatchObject(triggerRefusal(type));
      const saved = await save(trigger).expect(422);
      expect(saved.body).toMatchObject(triggerRefusal(type));
    }
    expect(await versionsOn(wf, 'main')).toBe(1);

    const run = await http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: withTrigger(marked('orchestr:webhok')) })
      .expect(400);
    expect(run.body).toMatchObject({
      code: 'compile_failed',
      steps: [],
      detail: `Workflow can't run: ${triggerRefusal('orchestr:webhok').detail as string}`,
    });

    const known = [
      node('start', 'orchestr:webhook', { httpMethod: 'POST', path: 'gate-kinds' }),
      node('start', 'orchestr:schedule', { interval_minutes: 60 }),
      node('start', 'orchestr:chat'),
      node('start', 'orchestr:tool_trigger', { tool_name: 'gate_kinds', description: 'Says hi.' }),
      { ...node('start', 'rss.new_item', { url: feedUrl }), metadata: { trigger: true } },
      // No Composio key here, so its listing can't be asked: an app trigger saves, unchecked.
      marked('acmecrm.new_deal'),
    ];
    for (const trigger of known) {
      const res = await save(trigger);
      expect(res.body).not.toHaveProperty('code');
      expect(res.status).toBe(201);
    }
    expect(await versionsOn(wf, 'main')).toBe(1 + known.length);

    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('a Code step in a language the sandbox does not run is refused at create, at save and at an editor run; js, ts, none and null save', async () => {
    const created = await http()
      .post('/api/deploy')
      .send({ workflow_json: withCode({ language: 'python', code: 'return 1' }) })
      .expect(422);
    expect(created.body).toMatchObject({
      code: 'unsupported_code_language',
      node_id: 'calc',
      node_type: 'orchestr:code',
      detail: languageRefusal('python'),
    });
    expect(created.body.errors).toHaveLength(1);

    const dep = await http()
      .post('/api/deploy')
      .send({ workflow_json: withCode({ code: 'return 0;' }) })
      .expect(201);
    const wf = dep.body.workflow_id as string;
    const save = (parameters: Record<string, unknown>): request.Test =>
      http()
        .post(`/api/workflows/${wf}/commit`)
        .send({ workflow_ir: withCode(parameters) });

    const saved = await save({ language: 'typescript', code: 'return 1;' }).expect(422);
    expect(saved.body).toMatchObject({
      code: 'unsupported_code_language',
      node_id: 'calc',
      node_type: 'orchestr:code',
      detail: languageRefusal('typescript'),
    });
    expect(await versionsOn(wf, 'main')).toBe(1);

    const run = await http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: withCode({ language: 'python', code: 'return 1;' }) })
      .expect(400);
    expect(run.body).toMatchObject({
      code: 'compile_failed',
      steps: [],
      detail: `Workflow can't run: ${languageRefusal('python')}`,
    });

    const accepted = [
      { language: 'js', code: 'return 1;' },
      { language: 'ts', code: 'const n: number = 2; return n;' },
      { code: 'return 3;' },
      { language: null, code: 'return 4;' },
    ];
    for (const parameters of accepted) {
      const res = await save(parameters);
      expect(res.body).not.toHaveProperty('code');
      expect(res.status).toBe(201);
    }
    expect(await versionsOn(wf, 'main')).toBe(1 + accepted.length);

    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('a merge resolved into a Code step in a language the sandbox does not run is refused at every merge door, and writes nothing', async () => {
    const dep = await http()
      .post('/api/deploy')
      .send({ workflow_json: withCode({ code: 'return 0;' }) })
      .expect(201);
    const wf = dep.body.workflow_id as string;
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: withCode({ language: 'ts', code: 'return 0;' }), branch: 'lane' })
      .expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: withCode({ language: 'js', code: 'return 0;' }), branch: 'main' })
      .expect(201);
    const review = await http()
      .post(`/api/workflows/${wf}/reviews`)
      .send({ source_branch: 'lane', target_branch: 'main', title: 'lane → main' })
      .expect(201);
    const python = [
      { node_id: 'calc', field_path: 'parameters.language', choice: 'custom', value: 'python' },
    ];
    const written = async (): Promise<unknown[]> => [
      (await http().get(`/api/workflows/${wf}/branches/main/head`).expect(200)).body.head,
      (await http().get(`/api/workflows/${wf}/branches/lane/head`).expect(200)).body.head,
      await versionsOn(wf, 'main'),
      await versionsOn(wf, 'lane'),
    ];
    const before = await written();

    const conflicted = await http()
      .post(`/api/workflows/${wf}/branches/lane/merge`)
      .send({ target_branch: 'main' })
      .expect(201);
    expect(conflicted.body.conflicts).toMatchObject([{ node_id: 'calc', field_path: 'parameters.language' }]);

    for (const door of [
      http()
        .post(`/api/workflows/${wf}/branches/lane/merge`)
        .send({ target_branch: 'main', resolutions: python }),
      http()
        .post(`/api/workflows/${wf}/branches/lane/update`)
        .send({ from_branch: 'main', resolutions: python }),
      http()
        .post(`/api/workflows/${wf}/reviews/${review.body.id as string}/merge`)
        .send({ resolutions: python }),
    ]) {
      const refused = await door.expect(422);
      expect(refused.body).toMatchObject({
        code: 'unsupported_code_language',
        node_id: 'calc',
        node_type: 'orchestr:code',
        detail: languageRefusal('python'),
      });
    }
    expect(await written()).toEqual(before);
    expect(
      (
        await http()
          .get(`/api/workflows/${wf}/reviews/${review.body.id as string}`)
          .expect(200)
      ).body.status,
    ).toBe('open');

    const merged = await http()
      .post(`/api/workflows/${wf}/branches/lane/merge`)
      .send({ target_branch: 'main', resolutions: [{ ...python[0], value: 'ts' }] })
      .expect(201);
    expect(merged.body.status).toBe('merged');

    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('a document with no edges array, which can never compile, is refused at create, at save and at an editor run', async () => {
    const edgeless = (): Record<string, unknown> => {
      const document = withCode({ language: 'python', code: 'return 1;' });
      delete document.edges;
      return document;
    };
    const structure = {
      code: 'invalid_workflow_structure',
      detail:
        'A workflow document needs a "nodes" array and an "edges" array — an empty "edges" when nothing is connected.',
    };
    expect(
      (await http().post('/api/deploy').send({ workflow_json: edgeless() }).expect(422)).body,
    ).toMatchObject(structure);
    const dep = await http()
      .post('/api/deploy')
      .send({ workflow_json: withCode({ code: 'return 0;' }) })
      .expect(201);
    const wf = dep.body.workflow_id as string;
    expect(
      (await http().post(`/api/workflows/${wf}/commit`).send({ workflow_ir: edgeless() }).expect(422)).body,
    ).toMatchObject(structure);
    expect(await versionsOn(wf, 'main')).toBe(1);
    const run = await http().post('/api/runs/from-ir').send({ workflow_ir: edgeless() }).expect(400);
    expect(run.body).toMatchObject({
      code: 'compile_failed',
      steps: [],
      detail: `Workflow can't run: ${structure.detail}`,
    });

    await http().delete(`/api/workflows/${wf}`).expect(200);
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
