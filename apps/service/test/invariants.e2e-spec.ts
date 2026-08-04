import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { compileWorkflowIrDag } from '../src/compiler/compile-ir-dag';
import { computeDiff } from '../src/ir/diff';
import { type AgentResult } from '../src/runtime/agent';
import { ScriptedAgentModel } from '../src/runtime/agent.testkit';
import type { DagAgentNode } from '../src/runtime/dag-plan';
import { DagInterpreter } from '../src/runtime/dag-interpreter';
import { TriggerReconcilerService } from '../src/triggers/canvas/trigger-reconciler.service';
import { listenOnLoopback } from './support/listen';
import { createE2eDatabase } from './support/test-db';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://orchestr:orchestr@localhost:5432/orchestr';
const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/**
 * THE CONSTITUTION (src/domain/README.md): one named test per load-bearing rule.
 * A red test here means the change is wrong or needs an ADR — never edit the test to pass.
 */
describe('domain invariants (the constitution)', () => {
  let app: INestApplication;
  let db: Client;
  let reconciler: TriggerReconcilerService;

  const ir = (texts: string[], name = 'invariant probe') => ({
    version: '1',
    name,
    description: '',
    nodes: [
      {
        id: 'trigger',
        name: 'Trigger',
        node_type: 'orchestr:trigger',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: {},
      },
      {
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts, separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e1',
        source_node_id: 'trigger',
        source_port: 0,
        target_node_id: 'announce',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  });

  const http = () => request(app.getHttpServer());
  const seed = async (name: string): Promise<string> => {
    const dep = await http()
      .post('/api/deploy')
      .send({ workflow_json: ir(['v1'], name) })
      .expect(201);
    return dep.body.workflow_id as string;
  };

  // ─── ADR 0018 fixtures: a trigger is an IR NODE in the version doc ───

  /** A version doc whose SOURCE is a native canvas trigger node feeding an `announce` step. */
  const triggerIr = (
    trigger: { node_type: string; parameters?: Record<string, unknown> },
    marker: string,
    name = 'canvas trigger probe',
  ) => ({
    version: '1',
    name,
    description: '',
    nodes: [
      {
        id: 'trig',
        name: 'Trigger',
        node_type: trigger.node_type,
        type_version: 1,
        parameters: trigger.parameters ?? {},
        position: { x: 0, y: 0 },
        metadata: {},
      },
      {
        id: 'announce',
        name: 'Announce',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { values: [marker], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'e1',
        source_node_id: 'trig',
        source_port: 0,
        target_node_id: 'announce',
        target_port: 0,
        port_type: 'main',
      },
    ],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  });

  const webhookIr = (marker: string, name?: string) =>
    triggerIr({ node_type: 'orchestr:webhook' }, marker, name);
  const scheduleIr = (marker: string, props: Record<string, unknown>, name?: string) =>
    triggerIr({ node_type: 'orchestr:schedule', parameters: props }, marker, name);

  const seedDoc = async (doc: Record<string, unknown>): Promise<string> => {
    const dep = await http().post('/api/deploy').send({ workflow_json: doc }).expect(201);
    return dep.body.workflow_id as string;
  };

  const versionId = async (wf: string, versionNumber: number): Promise<string> => {
    const res = await http().get(`/api/workflows/${wf}/versions?branch=main`).expect(200);
    const found = (res.body.versions as Array<{ id: string; version_number: number }>).find(
      (v) => v.version_number === versionNumber,
    );
    return found!.id;
  };

  const awaitRun = async (runId: string): Promise<Record<string, unknown>> => {
    let run: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      const res = await http().get(`/api/runs/${runId}`).expect(200);
      run = res.body as Record<string, unknown>;
      if (run.status === 'completed' || run.status === 'error') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return run;
  };

  /** The activation row for a workflow's env — scoped by NAME because deploy also auto-promotes to production. */
  const activationRow = async (
    wf: string,
    envName: string,
  ): Promise<{ id: string; version_id: string; trigger_node_id: string; kind: string }> => {
    const res = await db.query(
      `SELECT a.id, a.version_id, a.trigger_node_id, a.kind
         FROM runtime_trigger_activations a
         JOIN environments e ON e.id = a.environment_id
        WHERE a.workflow_id = $1 AND e.name = $2`,
      [wf, envName],
    );
    return res.rows[0];
  };

  const scheduleCursor = async (activationId: string): Promise<string | null> => {
    const res = await db.query(
      `SELECT value FROM runtime_activation_store WHERE activation_id = $1 AND key = 'schedule.lastFire'`,
      [activationId],
    );
    return (res.rows[0]?.value as string | null) ?? null;
  };

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
    // pg-boss is off in e2e, so pointer moves reconcile inline and the reconciler can be driven directly.
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    reconciler = app.get(TriggerReconcilerService);
  }, 30_000);

  afterAll(async () => {
    await db.end();
    await app.close();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
  });

  it('per-branch numbering: a branch inherits its fork point and its first own commit is v1', async () => {
    const wf = await seed('inv numbering');
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['v2']), branch: 'main' })
      .expect(201);
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
    const commit = await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['lane-1']), branch: 'lane' })
      .expect(201);
    expect(commit.body.version_number).toBe(1); // the branch's OWN lane starts at 1
    const main = await http().get(`/api/workflows/${wf}/versions?branch=main`).expect(200);
    expect(main.body.versions.map((v: { version_number: number }) => v.version_number).sort()).toEqual([
      1, 2,
    ]);
    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('save never moves live: commits advance the head, only publish moves the pointer', async () => {
    const wf = await seed('inv save-live');
    const before = await http().get(`/api/workflows/${wf}`).expect(200);
    expect(before.body.live_version).toBe(1);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['v2']), branch: 'main' })
      .expect(201);
    const after = await http().get(`/api/workflows/${wf}`).expect(200);
    expect(after.body.latest_version).toBe(2);
    expect(after.body.live_version).toBe(1); // untouched by the save
    await http().post(`/api/workflows/${wf}/publish`).send({}).expect(201);
    const published = await http().get(`/api/workflows/${wf}`).expect(200);
    expect(published.body.live_version).toBe(2); // the explicit act moved it
    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('no-diff commits mint nothing: the head is the save', async () => {
    const wf = await seed('inv no-diff');
    const again = await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['v1']), branch: 'main' })
      .expect(201);
    expect(again.body.no_changes).toBe(true);
    expect(again.body.version_number).toBe(1);
    const versions = await http().get(`/api/workflows/${wf}/versions?branch=main`).expect(200);
    expect(versions.body.versions).toHaveLength(1);
    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('field-level conflicts: same-field edits collide, different-field edits merge clean', async () => {
    const wf = await seed('inv conflicts');
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
    // Same field both sides → conflict reported, nothing merged.
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['main-side']), branch: 'main' })
      .expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['lane-side']), branch: 'lane' })
      .expect(201);
    const merge = await http()
      .post(`/api/workflows/${wf}/branches/lane/merge`)
      .send({ target_branch: 'main' })
      .expect(201);
    expect(merge.body.status).toBe('conflicts'); // reported, nothing merged
    const conflict = merge.body.conflicts[0];
    expect(conflict.field_path).toBe('parameters.texts'); // FIELD-level, keyed inside the node
    expect(conflict.source_value).toEqual(['lane-side']);
    expect(conflict.target_value).toEqual(['main-side']);
    await http().delete(`/api/workflows/${wf}`).expect(200);

    // Different fields of the SAME node merge clean — this goes red if granularity coarsens field→node.
    const wf2 = await seed('inv field-level');
    await http().post(`/api/workflows/${wf2}/branches`).send({ name: 'lane' }).expect(201);
    const sepDoc = ir(['v1']); // ancestor announce: { texts: ['v1'], separator: '' }
    (sepDoc.nodes[1] as { parameters: { separator: string } }).parameters.separator = ' | '; // MAIN edits separator
    await http()
      .post(`/api/workflows/${wf2}/commit`)
      .send({ workflow_ir: sepDoc, branch: 'main' })
      .expect(201);
    await http()
      .post(`/api/workflows/${wf2}/commit`)
      .send({ workflow_ir: ir(['lane-edit']), branch: 'lane' }) // LANE edits texts (a different field)
      .expect(201);
    const clean = await http()
      .post(`/api/workflows/${wf2}/branches/lane/merge`)
      .send({ target_branch: 'main' })
      .expect(201);
    expect(clean.body.status).toBe('merged'); // different fields → NO collision, merged clean
    const versions = await http().get(`/api/workflows/${wf2}/versions?branch=main`).expect(200);
    const mergedV = (
      versions.body.versions as Array<{ id: string; workflow_ir: { nodes: Array<Record<string, unknown>> } }>
    ).find((v) => v.id === clean.body.merged_version_id)!;
    const announce = mergedV.workflow_ir.nodes.find((n) => n.id === 'announce') as {
      parameters: Record<string, unknown>;
    };
    expect(announce.parameters.separator).toBe(' | '); // main's field survived
    expect(announce.parameters.texts).toEqual(['lane-edit']); // lane's field survived
    await http().delete(`/api/workflows/${wf2}`).expect(200);
  });

  it('latest floats to the merge commit, inside the merge itself', async () => {
    const wf = await seed('inv latest-floats');
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['lane-change']), branch: 'lane' })
      .expect(201);
    await http().post(`/api/workflows/${wf}/branches/lane/merge`).send({}).expect(201);
    const main = await http().get(`/api/workflows/${wf}/versions?branch=main`).expect(200);
    const head = main.body.versions.reduce((a: { version_number: number }, b: { version_number: number }) =>
      b.version_number > a.version_number ? b : a,
    );
    expect(head.commit_message).toContain("Merge 'lane'");
    expect(head.tags).toContain('latest');
    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  it('env protection: production and uat are locked; prod is reserved and maps to production', async () => {
    const envs = await http().get('/api/environments').expect(200);
    const list = envs.body.environments as Array<{ id: string; name: string; is_prod: boolean }>;
    const production = list.find((e) => e.is_prod)!;
    const uat = list.find((e) => e.name === 'uat')!;
    expect(production.name).toBe('production');
    await http().patch(`/api/environments/${production.id}`).send({ name: 'live' }).expect(409);
    await http().delete(`/api/environments/${production.id}`).expect(409);
    await http().patch(`/api/environments/${uat.id}`).send({ name: 'acceptance' }).expect(409);
    await http().delete(`/api/environments/${uat.id}`).expect(409);
    await http().post('/api/environments').send({ name: 'prod' }).expect(400); // reserved
  });

  it('main-only promotion: prod/uat refuse branch versions; staging accepts them', async () => {
    const wf = await seed('inv main-only');
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'lane' }).expect(201);
    const laneCommit = await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: ir(['lane']), branch: 'lane' })
      .expect(201);
    const laneVersionId = laneCommit.body.id as string;
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'production', version_id: laneVersionId })
      .expect(400);
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'uat', version_id: laneVersionId })
      .expect(400);
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'staging', version_id: laneVersionId })
      .expect(201);
    await http().delete(`/api/workflows/${wf}`).expect(200);
  });

  // ─── ADR 0018 — triggers in the canvas (invariant #9 amendment + new invariant #11) ───

  it('invariant 9 (ADR 0018): per-(workflow,env) webhook fires the pinned version, resolved from the version-doc trigger node', async () => {
    // v1 has a native webhook trigger node (the SOURCE) + an announce step that echoes the version.
    const wf = await seedDoc(webhookIr('v1', 'inv9 canvas'));
    const v1 = await versionId(wf, 1);
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'staging', version_id: v1 })
      .expect(201);
    // Commit v2 — the head advances, but staging stays pinned to v1 (Save ≠ Live).
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: webhookIr('v2'), branch: 'main' })
      .expect(201);

    // A hit on /api/hooks/<wf>/staging resolves the env pointer → pinned v1 → its trigger node → runs ONLY v1.
    const fired = await http().post(`/api/hooks/${wf}/staging`).send({}).expect(202);
    const run = await awaitRun(fired.body.run_id as string);
    // Attribution is recorded at dispatch, so this holds independently of the downstream step's success.
    expect(run.environment).toBe('staging');
    expect(run.workflow_version_id).toBe(v1); // fired ONLY the env's pinned version, from its trigger node
    await http().delete(`/api/workflows/${wf}`).expect(200);
  }, 30_000);

  it('invariant 11 (ADR 0018): a commit changes no activation', async () => {
    const wf = await seedDoc(scheduleIr('v1', { interval_minutes: 60 }, 'inv11 no-touch'));
    const v1 = await versionId(wf, 1);
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'staging', version_id: v1 })
      .expect(201);
    await reconciler.reconcile(wf); // materialize the derived activation (pinned v1, seeded cursor)
    const before = await activationRow(wf, 'staging');
    expect(before.version_id).toBe(v1);
    const cursor0 = await scheduleCursor(before.id);
    expect(cursor0).toBeTruthy();

    // A commit advances the head but moves no pointer — so it must change no activation.
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: scheduleIr('v2', { interval_minutes: 60 }), branch: 'main' })
      .expect(201);
    await reconciler.reconcile(wf); // reconciling after a bare commit is a no-op (pointer still v1)

    const after = await activationRow(wf, 'staging');
    expect(after.id).toBe(before.id);
    expect(after.version_id).toBe(v1); // still pinned to v1 — the commit touched nothing
    expect(await scheduleCursor(after.id)).toBe(cursor0); // cursor untouched
    await http().delete(`/api/workflows/${wf}`).expect(200);
  }, 30_000);

  it('invariant 11 (ADR 0018): promote keeps an unchanged trigger cursor, resets a changed one', async () => {
    const wf = await seedDoc(scheduleIr('v1', { interval_minutes: 60 }, 'inv11 cursor'));
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'staging', version_id: await versionId(wf, 1) })
      .expect(201);
    await reconciler.reconcile(wf);
    const activation = await activationRow(wf, 'staging');
    const cursor0 = await scheduleCursor(activation.id);
    expect(cursor0).toBeTruthy();

    // v2 changes ONLY the downstream step; the schedule node is byte-identical → KEEP the cursor.
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: scheduleIr('v2', { interval_minutes: 60 }), branch: 'main' })
      .expect(201);
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'staging', version_id: await versionId(wf, 2) })
      .expect(201);
    await reconciler.reconcile(wf);
    expect(await scheduleCursor(activation.id)).toBe(cursor0); // KEEP — computeDiff shows the node unchanged

    // v3 changes the SCHEDULE node's own props → RESET the cursor from now.
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_ir: scheduleIr('v3', { interval_minutes: 30 }), branch: 'main' })
      .expect(201);
    await http()
      .post(`/api/workflows/${wf}/promote`)
      .send({ environment: 'staging', version_id: await versionId(wf, 3) })
      .expect(201);
    await reconciler.reconcile(wf);
    const cursor2 = await scheduleCursor(activation.id);
    expect(cursor2).not.toBe(cursor0); // RESET — the trigger node's config changed across the promote
    await http().delete(`/api/workflows/${wf}`).expect(200);
  }, 30_000);

  it('invariant 12 (ADR 0020): error output routes the error lane, never both, as a distinct edge', () => {
    const concat = (id: string, texts: string[]) => ({
      id,
      name: id,
      node_type: 'text.concat',
      type_version: 1,
      parameters: { texts, separator: '' },
      position: { x: 0, y: 0 },
      metadata: {},
    });
    const boom = {
      id: 'boom',
      name: 'boom',
      node_type: 'fault.throw', // throws when executed
      type_version: 1,
      parameters: {},
      position: { x: 0, y: 0 },
      metadata: {},
    };
    const edge = (id: string, from: string, to: string, port_type: string) => ({
      id,
      source_node_id: from,
      source_port: 0,
      target_node_id: to,
      target_port: 0,
      port_type,
    });
    const doc = {
      version: '1',
      name: 'err',
      description: '',
      nodes: [boom, concat('after', ['MAIN']), concat('handler', ['handled'])],
      edges: [edge('e-main', 'boom', 'after', 'main'), edge('e-err', 'boom', 'handler', 'error')],
      settings: { execution_order: 'v1', extra: {} },
      metadata: {},
    };

    // (a) The compiler lowers the error edge into boom.onErrorBranch — the handler leaves the main flow.
    const plan = compileWorkflowIrDag(doc);
    const boomNode = plan.nodes.find((n) => n.kind === 'action' && n.id === 'boom');
    expect(boomNode?.kind === 'action' ? boomNode.onErrorBranch?.nodes.map((n) => n.id) : null).toEqual([
      'handler',
    ]);
    expect(plan.nodes.map((n) => n.id)).toEqual(['boom', 'after']);

    // (b) The error lane runs IFF boom throws, in place of the main successor — never both.
    return new DagInterpreter({
      key: 'mock',
      runAction: (input) =>
        input.actionId === 'fault.throw'
          ? Promise.reject(new Error('kaboom'))
          : Promise.resolve({ output: 'ran' }),
      enableTrigger: () => Promise.resolve(),
      pollTrigger: () => Promise.resolve([]),
      disableTrigger: () => Promise.resolve(),
    })
      .run(plan, { externalUserId: 'u' })
      .then((result) => {
        expect(result.outputs.handler).toBe('ran'); // error lane ran
        expect(result.outputs.after).toBeUndefined(); // main successor skipped — never both

        // (c) The edge key includes `port_type` (invariant #4), so main→error is a remove + add.
        const mainOnly = { ...doc, edges: [edge('e', 'boom', 'handler', 'main')] };
        const errOnly = { ...doc, edges: [edge('e', 'boom', 'handler', 'error')] };
        const ops = computeDiff(mainOnly, errOnly).entries.map((x) => x.operation);
        expect(ops).toContain('remove_edge');
        expect(ops).toContain('add_edge');
      });
  });

  it('invariant 14 (ADR 0045): a tool edge binds a tool, distinct from a main edge, never collapses', () => {
    const node = (id: string, node_type: string, parameters: Record<string, unknown> = {}) => ({
      id,
      name: id,
      node_type,
      type_version: 1,
      parameters,
      position: { x: 0, y: 0 },
      metadata: {},
    });
    const edge = (id: string, from: string, to: string, port_type: string) => ({
      id,
      source_node_id: from,
      source_port: 0,
      target_node_id: to,
      target_port: 0,
      port_type,
    });
    const doc = {
      version: '1',
      name: 'agent',
      description: '',
      nodes: [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 5, input: '{{trigger.chatInput}}' }),
        node('search', 'slack.send_message', { channel: '#ops' }), // the bound tool
        node('reply', 'text.concat', { texts: ['{{agent.text}}'], separator: '' }),
      ],
      edges: [
        edge('e-in', 'chat', 'agent', 'main'),
        edge('e-tool', 'agent', 'search', 'tool'),
        edge('e-out', 'agent', 'reply', 'main'),
      ],
      settings: { execution_order: 'v1', extra: {} },
      metadata: { engine: 'orchestr' },
    };

    // (a) The compiler PEELS the tool edge into agent.tools[] — the bound node leaves the main flow.
    const plan = compileWorkflowIrDag(doc);
    expect(plan.nodes.map((n) => n.id)).toEqual(['agent', 'reply']);
    const agent = plan.nodes.find((n) => n.id === 'agent') as DagAgentNode;
    expect(agent.tools).toEqual([
      {
        kind: 'action',
        // Sanitized to a provider-legal identifier (ADR 0045 addendum); actionId keeps the routing id.
        name: 'slack_send_message',
        actionId: 'slack.send_message',
        props: { channel: '#ops' },
      },
    ]);
    expect(agent.tools[0]!.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);

    // (b) The bound tool runs through the durable dispatch, never as a main step.
    const model = new ScriptedAgentModel([
      // The model calls the tool by its SANITIZED model-facing name; the loop resolves it back.
      { text: 'searching', toolCalls: [{ id: 'c1', name: 'slack_send_message', input: { text: 'hi' } }] },
      { text: 'done', toolCalls: [] },
    ]);
    const provider = {
      key: 'mock',
      runAction: (input: { actionId: string }) => Promise.resolve({ output: { ran: input.actionId } }),
      enableTrigger: () => Promise.resolve(),
      pollTrigger: () => Promise.resolve([]),
      disableTrigger: () => Promise.resolve(),
    };
    return new DagInterpreter(provider, undefined, undefined, undefined, model)
      .run(plan, { externalUserId: 'u', initialScope: { trigger: { chatInput: 'go' } } })
      .then((result) => {
        const out = result.outputs.agent as AgentResult;
        expect(out.text).toBe('done');
        expect(out.steps.find((s) => s.kind === 'tool')?.tool).toBe('slack_send_message');

        // (c) The edge key includes `port_type` (invariant #4/#13), so main→tool is a remove + add.
        const mainOnly = { ...doc, edges: [edge('e', 'agent', 'search', 'main')] };
        const toolOnly = { ...doc, edges: [edge('e', 'agent', 'search', 'tool')] };
        const ops = computeDiff(mainOnly, toolOnly).entries.map((x) => x.operation);
        expect(ops).toContain('remove_edge');
        expect(ops).toContain('add_edge');
      });
  });
});
