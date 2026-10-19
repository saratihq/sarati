import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import type { FetchLike } from '@sarati/actions-sdk';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { ConnectionsService } from '../src/connections/connections.service';
import { AGENT_MODEL_FETCH } from '../src/providers/agent-model-call.provider';
import { SDK_ACTIONS_FETCH } from '../src/providers/sdk-actions.provider';
import { RunsService } from '../src/runs/runs.service';
import type { DagPlan } from '../src/runtime/dag-plan';
import { gmailFake } from './support/gmail-fake';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const STEP = 'Email me the report';

const { fetch: gmailFetch, sent } = gmailFake({
  'tok-owner': 'owner@e2e.local',
  'tok-second': 'second@e2e.local',
  'tok-ops': 'ops@e2e.local',
  'tok-inline': 'service@e2e.local',
});

// Every request the agent's model received, and the key each was called with.
const modelRequests: Array<{ messages: Array<{ content: unknown }>; tools?: unknown[] }> = [];
const modelKeys: string[] = [];

// Claude, in-process: calls the Gmail tool once when it has one, then answers.
const claudeFetch: FetchLike = (_input, init) => {
  const body = JSON.parse(
    typeof init?.body === 'string' ? init.body : '{}',
  ) as (typeof modelRequests)[number];
  modelRequests.push(body);
  const headers = Object.entries(init?.headers ?? {});
  modelKeys.push(String(headers.find(([name]) => name.toLowerCase() === 'x-api-key')?.[1] ?? ''));
  const answered = !body.tools?.length || JSON.stringify(body.messages).includes('tool_result');
  const content = answered
    ? [{ type: 'text', text: 'done' }]
    : [{ type: 'tool_use', id: 'call-1', name: 'gmail_send_email', input: {} }];
  return Promise.resolve({
    status: 200,
    headers: { forEach: (cb) => cb('application/json', 'content-type') },
    text: () => Promise.resolve(JSON.stringify({ content, usage: { input_tokens: 1, output_tokens: 1 } })),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  });
};

const node = (
  id: string,
  name: string,
  nodeType: string,
  parameters: Record<string, unknown>,
  x: number,
) => ({
  id,
  name,
  node_type: nodeType,
  type_version: 1,
  parameters,
  position: { x, y: 0 },
  metadata: {},
});

const edge = (id: string, from: string, to: string) => ({
  id,
  source_node_id: from,
  source_port: 0,
  target_node_id: to,
  target_port: 0,
  port_type: 'main',
});

// main: trigger → build the digest.
function mainDoc(): Record<string, unknown> {
  return {
    version: '1',
    name: 'Weekly digest',
    description: '',
    nodes: [
      node('trigger', 'Trigger', 'orchestr:trigger', {}, 0),
      node(
        'build_digest',
        'Build the digest',
        'orchestr:code',
        { language: 'js', code: "return { text: 'digest' };" },
        300,
      ),
    ],
    edges: [edge('e1', 'trigger', 'build_digest')],
    settings: { execution_order: 'v1', extra: {} },
    metadata: { engine: 'orchestr' },
  };
}

// The branch adds a Gmail step that chooses NO account, sending to whoever it runs as.
function withEmailStep(connectionId?: string): Record<string, unknown> {
  const doc = mainDoc();
  return {
    ...doc,
    nodes: [
      ...(doc.nodes as unknown[]),
      node(
        'send_report',
        STEP,
        'gmail.send_email',
        {
          to: '{{$account.email}}',
          subject: 'Your digest',
          body: '{{build_digest.text}}',
          ...(connectionId ? { connectionId } : {}),
        },
        600,
      ),
    ],
    edges: [...(doc.edges as unknown[]), edge('e2', 'build_digest', 'send_report')],
  };
}

// The owner's issue 1 on real Postgres with DBOS on: "Test this branch" decides a step's account when it runs, or refuses naming the step.
describe('a step with no account chosen is decided when it runs (e2e, DBOS on)', () => {
  let app: INestApplication;
  let db: Client;
  let me = '';
  let wf = '';
  let review = '';
  let production = '';
  let saved: { ref_warnings: string[] } = { ref_warnings: [] };

  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const gmail = (owner: string, token: string) =>
    app
      .get(ConnectionsService)
      .createOAuth2(owner, 'gmail', { access_token: token, token_type: 'Bearer', raw: {} });
  const readiness = async (environmentId?: string) =>
    (
      await http()
        .get(`/api/workflows/${wf}/reviews/${review}/test/readiness`)
        .query(environmentId ? { environment_id: environmentId } : {})
        .expect(200)
    ).body as { environment: { name: string } | null; blocked: Array<Record<string, unknown>> };
  const testBranch = (body: Record<string, unknown> = {}) =>
    http().post(`/api/workflows/${wf}/reviews/${review}/test`).send(body);
  const reviewRuns = async (): Promise<number> =>
    (
      await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM runtime_runs WHERE review_id = $1 AND source = 'review_test'`,
        [review],
      )
    ).rows[0]!.n;

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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SDK_ACTIONS_FETCH)
      .useValue(gmailFetch)
      .overrideProvider(AGENT_MODEL_FETCH)
      .useValue(claudeFetch)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    me = (await http().get('/api/auth/me').expect(200)).body.user.id as string;
    wf = (await http().post('/api/deploy').send({ workflow_json: mainDoc() }).expect(201)).body
      .workflow_id as string;
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'add-email' }).expect(201);
    saved = (
      await http()
        .post(`/api/workflows/${wf}/commit`)
        .send({ workflow_json: withEmailStep(), branch: 'add-email' })
        .expect(201)
    ).body as typeof saved;
    review = (
      await http()
        .post(`/api/workflows/${wf}/reviews`)
        .send({ source_branch: 'add-email', title: 'Email the digest' })
        .expect(201)
    ).body.id as string;
    const envs = (await http().get('/api/environments').expect(200)).body.environments as Array<{
      id: string;
      name: string;
    }>;
    production = envs.find((env) => env.name === 'production')!.id;

    // The runner has exactly one active Gmail account.
    await gmail(me, 'tok-owner');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    process.env.DATABASE_URL = ADMIN_URL;
    process.env.MOCK_AUTH = 'false';
    process.env.DBOS_ENABLED = 'false';
  }, 60_000);

  beforeEach(() => {
    sent.length = 0;
  });

  it('the branch saved what the person chose — no account', async () => {
    const versions = await db.query<{
      doc: { nodes: Array<{ id: string; parameters: Record<string, unknown> }> };
    }>(
      `SELECT v.workflow_json AS doc FROM workflow_versions v
         JOIN workflow_branches b ON b.head_version_id = v.id
        WHERE b.workflow_id = $1 AND b.name = 'add-email'`,
      [wf],
    );
    const step = versions.rows[0]!.doc.nodes.find((n) => n.id === 'send_report');
    expect(step?.parameters.connectionId).toBeUndefined();
  });

  it('saving it warns about nothing: {{$account.email}} is the account its run decides', async () => {
    expect(saved.ref_warnings).toEqual([]);
    const again = await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_json: withEmailStep(), branch: 'add-email' })
      .expect(201);
    expect(again.body).toMatchObject({ no_changes: true, ref_warnings: [] });
    const created = await http().post('/api/deploy').send({ workflow_json: withEmailStep() }).expect(201);
    expect(created.body.ref_warnings).toEqual([]);
    await http()
      .delete(`/api/workflows/${created.body.workflow_id as string}`)
      .expect(200);
  });

  it('on Default it runs as the runner’s only Gmail account and goes green', async () => {
    expect((await readiness()).blocked).toEqual([]);

    const res = await testBranch().expect(201);
    expect(res.body.head).toMatchObject({ status: 'completed', error: null });
    expect(res.body.verdict).toBe('green');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.token).toBe('tok-owner');
    expect(sent[0]!.raw).toContain('To: owner@e2e.local');
  }, 30_000);

  it('a raw plan step handed a credential inline runs on it as handed — never swapped for your only account', async () => {
    const plan = {
      id: 'inline-credential',
      nodes: [
        {
          kind: 'action',
          id: 'send',
          name: STEP,
          actionId: 'gmail.send_email',
          props: { to: 'ops@e2e.local', subject: 'From the service', body: 'b' },
          auth: { access_token: 'tok-inline' },
        },
      ],
    };
    const run = await http().post('/api/runs').send({ plan }).expect(201);
    expect(run.body.outputs.send).toBeDefined();
    expect(sent.map((s) => s.token)).toEqual(['tok-inline']);
  }, 30_000);

  it('under production with an empty Gmail slot it is refused up front, naming the environment and the step', async () => {
    const ready = await readiness(production);
    expect(ready.environment?.name).toBe('production');
    expect(ready.blocked).toEqual([
      expect.objectContaining({
        node_id: 'send_report',
        node_name: STEP,
        app: 'gmail',
        reason: 'empty_slot',
        message: expect.stringMatching(/^production has no gmail account assigned/),
      }),
    ]);

    await http().get(`/api/workflows/${wf}/reviews/${review}/test/readiness?environment_id=nope`).expect(404);
    const before = await reviewRuns();
    const refused = await testBranch({ environment_id: production }).expect(428);
    expect(refused.body.detail).toBe(
      `production has no gmail account assigned, so "${STEP}" can't run there — assign one under Integrations → Environments, or test on Default (your connections)`,
    );
    expect(refused.body.code).toBe('environment_slots_empty');
    expect(await reviewRuns()).toBe(before);
    expect(sent).toEqual([]);
  });

  it('with production’s Gmail slot filled it goes green and runs as the slot’s owner', async () => {
    const teammate = randomUUID();
    await db.query(`INSERT INTO users (id, email, name) VALUES ($1, 'ops@e2e.local', 'Ops')`, [teammate]);
    const slot = await gmail(teammate, 'tok-ops');
    await db.query(
      `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, 'gmail', $2)`,
      [production, slot.id],
    );

    expect((await readiness(production)).blocked).toEqual([]);
    const res = await testBranch({ environment_id: production }).expect(201);
    expect(res.body.verdict).toBe('green');
    expect(res.body.environment_id).toBe(production);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.token).toBe('tok-ops');
    expect(sent[0]!.raw).toContain('To: ops@e2e.local');
    const runs = await db.query<{ environment: string }>(
      `SELECT DISTINCT environment FROM runtime_runs WHERE review_id = $1 AND environment_id = $2`,
      [review, production],
    );
    expect(runs.rows.map((r) => r.environment)).toEqual(['production']);
  }, 30_000);

  it('with a second Gmail account on Default it fails naming the step — never a guess', async () => {
    await gmail(me, 'tok-second');
    const expected = `Step "${STEP}" has no gmail account chosen and you have 2 active gmail accounts — pick one on the step`;
    expect((await readiness()).blocked).toEqual([
      { node_id: 'send_report', node_name: STEP, app: 'gmail', reason: 'several', message: expected },
    ]);

    const res = await testBranch().expect(201);
    expect(res.body.verdict).toBe('red');
    expect(res.body.head.status).toBe('error');
    expect(res.body.head.error).toContain(expected);
    expect(sent).toEqual([]);
  }, 30_000);

  it('an AI Agent step is decided by the same rule under its model provider, and the card names it', async () => {
    const doc = mainDoc();
    const withAgent = {
      ...doc,
      nodes: [
        ...(doc.nodes as unknown[]),
        node('think', 'Think it over', 'orchestr:agent', { system_prompt: 'Summarise.', max_steps: 2 }, 600),
      ],
      edges: [...(doc.edges as unknown[]), edge('e3', 'build_digest', 'think')],
    };
    await http().post(`/api/workflows/${wf}/branches`).send({ name: 'add-agent' }).expect(201);
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_json: withAgent, branch: 'add-agent' })
      .expect(201);
    const agentReview = (
      await http()
        .post(`/api/workflows/${wf}/reviews`)
        .send({ source_branch: 'add-agent', title: 'Think it over' })
        .expect(201)
    ).body.id as string;

    const expected = 'Step "Think it over" has no Claude account to run as — connect one under Integrations';
    const ready = await http().get(`/api/workflows/${wf}/reviews/${agentReview}/test/readiness`).expect(200);
    expect(ready.body.blocked).toEqual([
      expect.objectContaining({
        node_id: 'think',
        app: 'claude',
        reason: 'none',
        message: expect.stringContaining(expected),
      }),
    ]);
    const res = await http().post(`/api/workflows/${wf}/reviews/${agentReview}/test`).send({}).expect(201);
    expect(res.body.verdict).toBe('red');
    expect(res.body.head.error).toContain(expected);
    expect(ready.body.blocked[0].message).toBe(res.body.head.error);
  }, 30_000);

  it('an account picked by hand runs as that one, and a removed one is named stale — never swapped', async () => {
    const accounts = (await http().get('/api/connections').query({ app: 'gmail' }).expect(200))
      .body as Array<{
      id: string;
      account: { email: string } | null;
    }>;
    const second = accounts.find((c) => c.account?.email === 'second@e2e.local')!;
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_json: withEmailStep(second.id), branch: 'add-email' })
      .expect(201);
    const picked = await testBranch().expect(201);
    expect(picked.body.verdict).toBe('green');
    expect(sent.map((s) => s.token)).toEqual(['tok-second']);

    sent.length = 0;
    await http().delete(`/api/connections/${second.id}`).expect(200);
    expect((await readiness()).blocked).toEqual([expect.objectContaining({ reason: 'stale' })]);
    const stale = await testBranch().expect(201);
    expect(stale.body.head.error).toContain(
      `Step "${STEP}" runs as a gmail account that no longer exists or isn't yours — pick one of your gmail accounts on the step`,
    );
    expect(stale.body.head.error).not.toContain(second.id);
    expect(sent).toEqual([]);
  }, 30_000);

  it("a chosen account of yours that isn't active is named alike by the card, the canvas and the run — never by its id", async () => {
    const pending = await app.get(ConnectionsService).createManaged(me, 'gmail', 'ca_pending');
    await http()
      .post(`/api/workflows/${wf}/commit`)
      .send({ workflow_json: withEmailStep(pending.id), branch: 'add-email' })
      .expect(201);
    const expected = `Step "${STEP}" runs as a gmail account that isn't active — pick another of your gmail accounts on the step`;

    expect((await readiness()).blocked).toEqual([
      { node_id: 'send_report', node_name: STEP, app: 'gmail', reason: 'inactive', message: expected },
    ]);
    const canvas = await http()
      .post('/api/connections/run-as')
      .send({ workflow_json: withEmailStep(pending.id) })
      .expect(200);
    expect(canvas.body.steps[0]).toMatchObject({ state: 'inactive', connection_id: null, message: expected });
    const res = await testBranch().expect(201);
    expect(res.body.verdict).toBe('red');
    expect(res.body.head.error).toBe(expected);
    expect(sent).toEqual([]);
    await http().delete(`/api/connections/${pending.id}`).expect(200);
  }, 30_000);
  it('the canvas asks the same rule, and a malformed account id reads as stale — never an error', async () => {
    const accounts = (await http().get('/api/connections').query({ app: 'gmail' }).expect(200))
      .body as Array<{
      id: string;
      account: { email: string } | null;
    }>;
    const owner = accounts.find((c) => c.account?.email === 'owner@e2e.local')!;

    const unbound = await http()
      .post('/api/connections/run-as')
      .send({ workflow_json: withEmailStep() })
      .expect(200);
    expect(unbound.body.steps).toEqual([
      {
        node_id: 'send_report',
        node_name: STEP,
        app: 'gmail',
        state: 'only',
        connection_id: owner.id,
        accounts: [owner.id],
        managed_only: false,
        message: null,
      },
    ]);

    const malformed = await http()
      .post('/api/connections/run-as')
      .send({ workflow_json: withEmailStep('not-a-uuid') })
      .expect(200);
    expect(malformed.body.steps[0]).toMatchObject({ state: 'stale', connection_id: null });
    expect(malformed.body.steps[0].message).toContain("no longer exists or isn't yours");
  });

  it('a step whose action needs no account ignores one stored on it, as its action does', async () => {
    const doc = mainDoc();
    const withJoin = (texts: string[], connectionId?: string) => ({
      ...doc,
      nodes: [
        ...(doc.nodes as unknown[]),
        node('join', 'Join text', 'text.concat', { texts, ...(connectionId ? { connectionId } : {}) }, 600),
      ],
      edges: [...(doc.edges as unknown[]), edge('e4', 'build_digest', 'join')],
    });

    const canvas = await http()
      .post('/api/connections/run-as')
      .send({ workflow_json: withJoin(['a', 'b'], randomUUID()) })
      .expect(200);
    expect(canvas.body.steps).toEqual([]);
    const run = await http()
      .post('/api/runs/from-ir')
      .send({ workflow_ir: withJoin(['a', 'b'], randomUUID()) })
      .expect(201);
    expect(run.body.outputs.join).toBe('ab');

    // {{$account}} is the account a step runs as, and this one runs as none — whatever it holds, the canvas and the run agree.
    const [own] = (await http().get('/api/connections').query({ app: 'gmail' }).expect(200)).body as Array<{
      id: string;
    }>;
    for (const held of [randomUUID(), own!.id, undefined]) {
      const mine = withJoin(['to:', '{{$account.email}}'], held);
      const asked = await http().post('/api/connections/run-as').send({ workflow_json: mine }).expect(200);
      expect(asked.body.steps).toEqual([]);
      const refused = await http().post('/api/runs/from-ir').send({ workflow_ir: mine }).expect(400);
      expect(refused.body.detail).toBe(
        'Step "Join text" uses no account, so {{$account.email}} has no value — it is filled only on a step that runs as one',
      );
    }
  }, 30_000);

  it("an AI Agent's tool is named by its step's name, in the canvas's words and the run's alike", async () => {
    await app
      .get(ConnectionsService)
      .createToken(me, { provider: 'claude', credential: { api_key: 'sk-ant-me' } });
    await gmail(me, 'tok-second');
    const doc = mainDoc();
    const withTool = {
      ...doc,
      nodes: [
        ...(doc.nodes as unknown[]),
        node('think', 'Think it over', 'orchestr:agent', { system_prompt: 'Send it.', max_steps: 3 }, 600),
        node(
          'send',
          'Send the report',
          'gmail.send_email',
          { to: 'ops@e2e.local', subject: 's', body: 'b' },
          900,
        ),
      ],
      edges: [
        ...(doc.edges as unknown[]),
        edge('e3', 'build_digest', 'think'),
        { ...edge('e-tool', 'think', 'send'), port_type: 'tool' },
      ],
    };
    const expected =
      'Step "Send the report" has no gmail account chosen and you have 2 active gmail accounts — pick one on the step';

    const canvas = await http().post('/api/connections/run-as').send({ workflow_json: withTool }).expect(200);
    expect(canvas.body.steps).toEqual([
      expect.objectContaining({ node_id: 'think', state: 'only' }),
      expect.objectContaining({ node_id: 'send', state: 'several', message: expected }),
    ]);
    modelRequests.length = 0;
    const run = await http().post('/api/runs/from-ir').send({ workflow_ir: withTool }).expect(201);
    const steps = (run.body.outputs.think as { steps: Array<{ kind: string; output?: unknown }> }).steps;
    expect(steps.find((step) => step.kind === 'tool')?.output).toEqual({ error: { message: expected } });
    const [result] = modelRequests.at(-1)!.messages.at(-1)!.content as Array<{ content: string }>;
    expect(JSON.parse(result!.content)).toEqual({ error: { message: expected } });
    expect(sent).toEqual([]);
  }, 30_000);

  it("a plan's AI Agent handed a model key inline calls its model with it — never swapped for your own Claude account", async () => {
    const think = (auth?: unknown): DagPlan => ({
      id: 'inline-model-key',
      nodes: [
        {
          kind: 'agent',
          id: 'think',
          name: 'Think it over',
          systemPrompt: 'Answer.',
          model: { provider: 'claude', model: 'claude-opus-4-8' },
          maxSteps: 2,
          input: 'Say hi',
          inputLiteral: true,
          ...(auth === undefined ? {} : { auth }),
          tools: [],
          guards: [],
        },
      ],
    });
    const dispatch = (plan: DagPlan) =>
      app.get(RunsService).runExecutable(plan, { externalUserId: me, initialScope: { trigger: {} } });

    modelKeys.length = 0;
    await dispatch(think());
    expect(modelKeys).toEqual(['sk-ant-me']);

    modelKeys.length = 0;
    const run = await dispatch(think({ api_key: 'sk-ant-inline' }));
    expect(run.outputs.think).toMatchObject({ text: 'done' });
    expect(modelKeys).toEqual(['sk-ant-inline']);
  }, 30_000);

  it("a plan step handed a credential inline under a filled environment slot runs on it as handed — never swapped for the slot's", async () => {
    const send = (auth?: unknown): DagPlan => ({
      id: 'inline-under-environment',
      nodes: [
        {
          kind: 'action',
          id: 'send',
          name: STEP,
          actionId: 'gmail.send_email',
          props: { to: 'ops@e2e.local', subject: 'From the service', body: 'b' },
          ...(auth === undefined ? {} : { auth }),
          guards: [],
        },
      ],
    });
    const dispatch = (plan: DagPlan) =>
      app.get(RunsService).runExecutable(plan, {
        externalUserId: me,
        environment: 'production',
        environmentId: production,
        initialScope: { trigger: {} },
      });

    await dispatch(send());
    expect(sent.map((s) => s.token)).toEqual(['tok-ops']);

    sent.length = 0;
    const run = await dispatch(send({ access_token: 'tok-inline' }));
    expect(run.outputs.send).toBeDefined();
    expect(sent.map((s) => s.token)).toEqual(['tok-inline']);
  }, 30_000);

  it("the canvas's dry run has a limit of its own, well above the global one", async () => {
    // The suite lifts the global limit, so a 429 here can only be the route's own; earlier calls share its minute.
    let answered = 0;
    for (; answered <= 240; answered++) {
      const res = await http().post('/api/connections/run-as').send({ workflow_json: mainDoc() });
      if (res.status === 429) break;
      expect(res.status).toBe(200);
    }
    expect(answered).toBeGreaterThan(200);
    expect(answered).toBeLessThanOrEqual(240);
  }, 60_000);
});
