import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

/** The stub holds the "slow" reply well past the bounded wait below, so the handle path is real. */
const SLOW_STEP_MS = 1_200;
const BOUNDED_WAIT_MS = 150;

const toolTrigger = {
  id: 'tool',
  name: 'Callable by an agent',
  node_type: 'orchestr:tool_trigger',
  type_version: 1,
  parameters: {
    tool_name: 'greet_customer',
    description: 'Greets a customer by name.',
    inputs: [{ name: 'customer', type: 'string', description: 'Who to greet', required: true }],
  },
  position: { x: 0, y: 0 },
  metadata: {},
};

const edge = (source: string, target: string): Record<string, unknown> => ({
  id: `${source}->${target}`,
  source_node_id: source,
  source_port: 0,
  target_node_id: target,
  target_port: 0,
  port_type: 'main',
});

const doc = (
  name: string,
  nodes: Array<Record<string, unknown>>,
  edges: Array<Record<string, unknown>>,
): Record<string, unknown> => ({
  version: '1.0',
  name,
  description: '',
  nodes,
  edges,
  settings: { execution_order: 'v1', extra: {} },
  metadata: {},
});

/**
 * A tool-trigger workflow: `step` interpolates the call argument, `sink` is the UNIQUE terminal leaf
 * — so `sink`'s output is the answer and `step`'s never is. `marker` distinguishes versions.
 */
const toolDoc = (marker: string): Record<string, unknown> =>
  doc(
    'greet customer',
    [
      toolTrigger,
      {
        id: 'step',
        name: 'Interpolate',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: [`${marker}:`, '{{trigger.customer}}'], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
      {
        id: 'sink',
        name: 'Answer',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['answer=', '{{step}}'], separator: '' },
        position: { x: 600, y: 0 },
        metadata: {},
      },
    ],
    [edge('tool', 'step'), edge('step', 'sink')],
  );

/** Published, but its trigger is a webhook — nothing declares it agent-callable. */
const webhookDoc = (): Record<string, unknown> =>
  doc(
    'webhook only',
    [
      {
        id: 'trigger',
        name: 'When a request arrives',
        node_type: 'orchestr:webhook',
        type_version: 1,
        parameters: {},
        position: { x: 0, y: 0 },
        metadata: {},
      },
      {
        id: 'sink',
        name: 'Answer',
        node_type: 'text.concat',
        type_version: 1,
        parameters: { texts: ['ok'], separator: '' },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    [edge('trigger', 'sink')],
  );

/** A tool workflow whose only step outlives the caller's bounded wait. */
const slowToolDoc = (stubUrl: string): Record<string, unknown> =>
  doc(
    'slow tool',
    [
      toolTrigger,
      {
        id: 'wait',
        name: 'Slow call',
        node_type: 'http.send_request',
        type_version: 1,
        parameters: { method: 'GET', url: `${stubUrl}/slow` },
        position: { x: 300, y: 0 },
        metadata: {},
      },
    ],
    [edge('tool', 'wait')],
  );

/** The 404 body with the id blanked — two refusals are indistinguishable iff these match. */
const shape = (body: Record<string, unknown>, id: string): Record<string, unknown> => ({
  ...body,
  detail: String(body.detail).replace(id, '<id>'),
});

/**
 * ADR 0053 — a published workflow is a tool an agent can call: only what is LIVE in production is
 * callable, only a `orchestr:tool_trigger` workflow is invocable, the arguments ARE the firing
 * event, and the answer is the terminal-node output (never the whole scope).
 */
describe('workflow-as-tool invocation (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;
  let stub: Server;
  let stubUrl = '';

  const userA = randomUUID();
  const userB = randomUUID();
  const keyA = 'ork_e2e_invoke_aaaaaaaaaaaaaaaaaaaaaa';
  const keyB = 'ork_e2e_invoke_bbbbbbbbbbbbbbbbbbbbbb';
  const invokeOnlyKey = 'ork_e2e_invoke_only_ccccccccccccccccc';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');

  let orgA = '';
  let orgB = '';
  let wfId = '';
  let v1Id = '';
  let v2Id = '';
  let foreignWfId = '';

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const asA = (r: request.Test): request.Test =>
    r.set('Authorization', `Bearer ${keyA}`).set('X-Org-Id', orgA);
  const asB = (r: request.Test): request.Test =>
    r.set('Authorization', `Bearer ${keyB}`).set('X-Org-Id', orgB);
  const invoke = (id: string, body: Record<string, unknown>): request.Test =>
    asA(http().post(`/api/workflows/${id}/invoke`).send(body));

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();

    stub = createServer((req, res) => {
      const reply = (): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ path: req.url }));
      };
      // The SERVER is what makes the run slow — the test never sleeps in place of a real step.
      if (req.url?.startsWith('/slow')) setTimeout(reply, SLOW_STEP_MS);
      else reply();
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES ($1, 'invoke-a@e2e.local', 'Owner A', now(), now()),
              ($2, 'invoke-b@e2e.local', 'Owner B', now(), now())`,
      [userA, userB],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at)
       VALUES (gen_random_uuid(), $1, 'a', $2, $3, now()),
              (gen_random_uuid(), $4, 'b', $5, $6, now())`,
      [userA, hash(keyA), keyA.slice(0, 12), userB, hash(keyB), keyB.slice(0, 12)],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    // The bounded wait and the poll must hold on the direct (in-process) path.
    process.env.DBOS_ENABLED = 'false';
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    orgA = (
      await http().post('/api/orgs').set('Authorization', `Bearer ${keyA}`).send({ name: 'Acme' }).expect(201)
    ).body.id as string;
    orgB = (
      await http()
        .post('/api/orgs')
        .set('Authorization', `Bearer ${keyB}`)
        .send({ name: 'Globex' })
        .expect(201)
    ).body.id as string;
    // The key you paste into an agent: `workflow:invoke` and nothing else (ADR 0053 §3).
    await db.query(
      `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, prefix, scopes, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'invoke-only', $3, $4, $5::json, now())`,
      [userA, orgA, hash(invokeOnlyKey), invokeOnlyKey.slice(0, 12), JSON.stringify(['workflow:invoke'])],
    );
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    await new Promise<void>((resolve, reject) => stub.close((e) => (e ? reject(e) : resolve())));
    process.env.DATABASE_URL = ADMIN_URL;
  }, 30_000);

  it('deploy publishes v1 to production; a later commit moves the head but NOT the pointer', async () => {
    wfId = (
      await asA(
        http()
          .post('/api/deploy')
          .send({ workflow_json: toolDoc('published') }),
      ).expect(201)
    ).body.workflow_id as string;

    const deployed = await asA(http().get(`/api/workflows/${wfId}/versions`)).expect(200);
    v1Id = (deployed.body.versions as Array<{ id: string; version_number: number }>).find(
      (v) => v.version_number === 1,
    )!.id;

    // A key commit must name the head it edits (ADR 0052) — this one lands v2 and moves the branch.
    v2Id = (
      await asA(
        http()
          .post(`/api/workflows/${wfId}/commit`)
          .send({
            workflow_json: toolDoc('draft'),
            commit_message: 'unpublished edit',
            base_version_id: v1Id,
          }),
      ).expect(201)
    ).body.id as string;

    const versions = await asA(http().get(`/api/workflows/${wfId}/versions`)).expect(200);
    const rows = versions.body.versions as Array<{ id: string; version_number: number }>;
    expect(rows.find((v) => v.version_number === 2)!.id).toBe(v2Id);

    // Save ≠ Live: production still points at v1.
    const pointers = await db.query(
      `SELECT environment, version_id FROM workflow_env_pointers WHERE workflow_id = $1`,
      [wfId],
    );
    expect(pointers.rows).toEqual([{ environment: 'production', version_id: v1Id }]);
  });

  it('invocation runs the PRODUCTION version and answers with the terminal node, not the whole scope', async () => {
    const res = await invoke(wfId, { arguments: { customer: 'ada' } }).expect(200);

    // `published:` is v1's marker — the newer committed head (`draft:`) is deliberately unreachable.
    expect(res.body).toEqual({
      run_id: expect.any(String) as unknown,
      status: 'completed',
      output: 'answer=published:ada',
    });
    // The intermediate step's output is NOT in the answer — one reply rule, never the output scope.
    expect(JSON.stringify(res.body)).not.toContain('"published:ada"');

    const run = await db.query(
      `SELECT source, workflow_id, workflow_version_id, user_id FROM runtime_runs WHERE run_id = $1`,
      [res.body.run_id],
    );
    expect(run.rows[0]).toEqual({
      source: 'mcp',
      workflow_id: wfId,
      workflow_version_id: v1Id,
      user_id: userA,
    });
  });

  it('a key holding ONLY workflow:invoke can call the tool but cannot read the workflow', async () => {
    const res = await http()
      .post(`/api/workflows/${wfId}/invoke`)
      .set('Authorization', `Bearer ${invokeOnlyKey}`)
      .set('X-Org-Id', orgA)
      .send({ arguments: { customer: 'grace' } })
      .expect(200);
    expect(res.body.output).toBe('answer=published:grace');

    await http()
      .get(`/api/workflows/${wfId}`)
      .set('Authorization', `Bearer ${invokeOnlyKey}`)
      .set('X-Org-Id', orgA)
      .expect(403);
  });

  it('a workflow with no production pointer is refused — never a fall back to a branch head', async () => {
    const draftId = (
      await asA(
        http()
          .post('/api/deploy')
          .send({ workflow_json: toolDoc('published') }),
      ).expect(201)
    ).body.workflow_id as string;
    const env = await db.query(`SELECT id FROM environments WHERE org_id = $1 AND name = 'production'`, [
      orgA,
    ]);
    await asA(http().delete(`/api/workflows/${draftId}/pointers/${env.rows[0].id}`)).expect(200);

    const res = await invoke(draftId, { arguments: { customer: 'ada' } }).expect(409);
    expect(res.body.code).toBe('not_published');
    expect(String(res.body.detail)).toMatch(/publish it first/i);

    // Un-promoting cleared the legacy prod alias too, so nothing resolves behind the pointer.
    const wf = await db.query(`SELECT active_version_id FROM workflows WHERE id = $1`, [draftId]);
    expect(wf.rows[0].active_version_id).toBeNull();
    // …and no run was recorded: the refusal happens before anything fires.
    const runs = await db.query(`SELECT count(*)::int AS n FROM runtime_runs WHERE workflow_id = $1`, [
      draftId,
    ]);
    expect(runs.rows[0].n).toBe(0);
  });

  it('a workflow whose trigger is not orchestr:tool_trigger is refused with an actionable message', async () => {
    const webhookId = (
      await asA(http().post('/api/deploy').send({ workflow_json: webhookDoc() })).expect(201)
    ).body.workflow_id as string;

    const res = await invoke(webhookId, { arguments: {} }).expect(400);
    expect(res.body.code).toBe('not_invocable');
    expect(String(res.body.detail)).toContain('orchestr:tool_trigger');
    expect(String(res.body.detail)).toMatch(/add that trigger, then publish/i);
  });

  it("another org's workflow is indistinguishable from a missing one", async () => {
    foreignWfId = (
      await asB(
        http()
          .post('/api/deploy')
          .send({ workflow_json: toolDoc('globex') }),
      ).expect(201)
    ).body.workflow_id as string;
    // It really is invocable — by its OWN org, so the refusal below is about reach, not health.
    expect(
      (
        await asB(
          http()
            .post(`/api/workflows/${foreignWfId}/invoke`)
            .send({ arguments: { customer: 'b' } }),
        ).expect(200)
      ).body.output,
    ).toBe('answer=globex:b');

    const missingId = randomUUID();
    const foreign = await invoke(foreignWfId, { arguments: { customer: 'ada' } }).expect(404);
    const missing = await invoke(missingId, { arguments: { customer: 'ada' } }).expect(404);
    expect(shape(foreign.body, foreignWfId)).toEqual(shape(missing.body, missingId));
  });

  it('a long invocation returns a run handle, and polling it reports completion', async () => {
    const slowId = (
      await asA(
        http()
          .post('/api/deploy')
          .send({ workflow_json: slowToolDoc(stubUrl) }),
      ).expect(201)
    ).body.workflow_id as string;

    const res = await invoke(slowId, { arguments: {}, await_ms: BOUNDED_WAIT_MS }).expect(200);
    expect(res.body).toEqual({
      run_id: expect.any(String) as unknown,
      status: 'running',
      poll_with: `/api/runs/${res.body.run_id}`,
    });
    expect(res.body.output).toBeUndefined();

    const deadline = Date.now() + 15_000;
    let detail = await asA(http().get(`/api/runs/${res.body.run_id}`)).expect(200);
    while (detail.body.status === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      detail = await asA(http().get(`/api/runs/${res.body.run_id}`)).expect(200);
    }
    expect(detail.body.status).toBe('completed');
    expect(detail.body.source).toBe('mcp');
    expect((detail.body.outputs as { wait: { status: number } }).wait.status).toBe(200);
  }, 30_000);
});
