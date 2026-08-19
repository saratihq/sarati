import { createHash, randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import type { FetchLike, FetchLikeResponse } from '@sarati/actions-sdk';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { compileWorkflowIrDag } from '../src/compiler/compile-ir-dag';
import { ConnectionsService } from '../src/connections/connections.service';
import type { WorkflowIR } from '../src/ir/models';
import { SDK_ACTIONS_FETCH } from '../src/providers/sdk-actions.provider';
import {
  AGENT_MODEL_CALL,
  type AgentModelPort,
  type AgentResult,
  type AgentStep,
  type ModelCallRequest,
  type ModelTurn,
} from '../src/runtime/agent';
import { MAX_SUB_WORKFLOW_DEPTH, MAX_SUB_WORKFLOW_INVOCATIONS } from '../src/runtime/base-plan-interpreter';
import { RunsService } from '../src/runs/runs.service';
import { DagInterpreter } from '../src/runtime/dag-interpreter';
import { listenOnLoopback } from './support/listen';
import { ADMIN_URL, createE2eDatabase } from './support/test-db';

const TEST_FERNET_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const STRIPE_OWNER_KEY = 'sk_test_slot_owner_key'; // the CALLER env slot's key → what a run-AS-caller resolves
const STRIPE_SUBOWNER_KEY = 'sk_test_subworkflow_owner_personal'; // the sub-workflow OWNER's personal key → must NOT appear

/** Scripted AGENT_MODEL_CALL strategies; both resolve the tool name from the request, never hard-coded. */
let modelCalls = 0;
type Strategy = (req: ModelCallRequest) => ModelTurn;

const callOnceThenAnswer: Strategy = (req) => {
  const toolResult = [...req.messages].reverse().find((m) => m.role === 'tool');
  if (toolResult) {
    return {
      text: `answer:${toolResult.content}`,
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  const tool = req.tools[0];
  if (!tool) return { text: 'no-tools', toolCalls: [], usage: {} };
  return {
    text: 'calling the sub-workflow',
    toolCalls: [{ id: `call-${modelCalls}`, name: tool.name, input: { q: 'hello' } }],
    usage: {},
  };
};

const alwaysCallTool: Strategy = (req) => {
  const tool = req.tools[0];
  if (!tool) return { text: 'no-tools', toolCalls: [], usage: {} };
  return {
    text: 'again',
    toolCalls: [{ id: `call-${modelCalls}`, name: tool.name, input: { q: 'x' } }],
    usage: {},
  };
};

let strategy: Strategy = callOnceThenAnswer;
const model: AgentModelPort = {
  call(req: ModelCallRequest): Promise<ModelTurn> {
    modelCalls += 1;
    return Promise.resolve(strategy(req));
  },
};

/** Every SDK-action HTTP hop (SDK_ACTIONS_FETCH) — url + the injected credential header. */
const actionCalls: Array<{ url: string; headers: Record<string, string> }> = [];
const actionFetch: FetchLike = (input, init) => {
  const url = String(input);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
  actionCalls.push({ url, headers });
  const res: FetchLikeResponse = {
    status: 200,
    headers: { forEach: (cb) => cb('application/json', 'content-type') },
    text: () => Promise.resolve(JSON.stringify({ available: [{ amount: 4200, currency: 'usd' }] })),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
  return Promise.resolve(res);
};

const wfNode = (id: string, node_type: string, parameters: Record<string, unknown> = {}) => ({
  id,
  name: id,
  node_type,
  type_version: 1,
  parameters,
  position: { x: 0, y: 0 },
  metadata: {},
});
/** A trigger DECLARING the workflow callable — what a caller now requires of a target. */
const toolTrigger = (tool_name: string, description: string) =>
  wfNode('trigger', 'orchestr:tool_trigger', {
    tool_name,
    description,
    inputs: [{ name: 'q', type: 'string', description: 'the question', required: false }],
  });
const wfEdge = (id: string, from: string, to: string, port_type: string) => ({
  id,
  source_node_id: from,
  source_port: 0,
  target_node_id: to,
  target_port: 0,
  port_type,
});

/** A leaf sub-workflow: trigger → text.concat echoing its firing input as `SUB_RESULT:<q>`. */
const echoDoc = (): Record<string, unknown> => ({
  version: '1.0',
  name: 'sub echo',
  description: '',
  nodes: [
    toolTrigger('sub_echo', 'Echoes its input back'),
    wfNode('concat', 'text.concat', { texts: ['SUB_RESULT:', '{{trigger.q}}'], separator: '' }),
  ],
  edges: [wfEdge('e', 'trigger', 'concat', 'main')],
  settings: { execution_order: 'v1', extra: {} },
  metadata: { engine: 'orchestr' },
});

/** A connection'd sub-workflow: trigger → stripe.get_balance on a dummy connectionId (engages the env slot). */
const stripeDoc = (): Record<string, unknown> => ({
  version: '1.0',
  name: 'sub stripe',
  description: '',
  nodes: [
    toolTrigger('sub_stripe', 'Reads the Stripe balance'),
    wfNode('balance', 'stripe.get_balance', { connectionId: 'dummy-node-conn' }),
  ],
  edges: [wfEdge('e', 'trigger', 'balance', 'main')],
  settings: { execution_order: 'v1', extra: {} },
  metadata: { engine: 'orchestr' },
});

/** A sub-workflow pinned to the OWNER's own stripe connection — the caller's env slot must still win. */
const ownedStripeDoc = (connectionId: string): Record<string, unknown> => ({
  version: '1.0',
  name: 'sub stripe (owned)',
  description: '',
  nodes: [
    toolTrigger('sub_owned', 'Reads the owner Stripe balance'),
    wfNode('balance', 'stripe.get_balance', { connectionId }),
  ],
  edges: [wfEdge('e', 'trigger', 'balance', 'main')],
  settings: { execution_order: 'v1', extra: {} },
  metadata: { engine: 'orchestr' },
});

/** A sub-workflow that PAUSES for a human (a wait_for_event node) — can't be used as a tool. */
const waitDoc = (): Record<string, unknown> => ({
  version: '1.0',
  name: 'sub wait',
  description: '',
  nodes: [
    toolTrigger('sub_wait', 'Pauses for a human'),
    wfNode('hold', 'orchestr:wait_for_event', { topic: 'approval', timeout_ms: 1000 }),
    wfNode('done', 'text.concat', { texts: ['done'], separator: '' }),
  ],
  edges: [wfEdge('e1', 'trigger', 'hold', 'main'), wfEdge('e2', 'hold', 'done', 'main')],
  settings: { execution_order: 'v1', extra: {} },
  metadata: { engine: 'orchestr' },
});

/** A MID sub-workflow whose agent calls `subInnerId` as a tool — the middle of a 2-level chain. */
const midAgentDoc = (subInnerId: string): Record<string, unknown> => ({
  version: '1.0',
  name: 'sub mid',
  description: '',
  nodes: [
    toolTrigger('sub_mid', 'Runs an agent that calls another workflow'),
    wfNode('agent', 'orchestr:agent', {
      model: { provider: 'claude', model: 'claude-opus-4-8' },
      system_prompt: 'Use the tool then answer.',
      max_steps: 4,
      input: '{{trigger.q}}',
    }),
    wfNode('callinner', 'orchestr:call_workflow', { workflow_id: subInnerId }),
  ],
  edges: [wfEdge('e-in', 'trigger', 'agent', 'main'), wfEdge('e-tool', 'agent', 'callinner', 'tool')],
  settings: { execution_order: 'v1', extra: {} },
  metadata: { engine: 'orchestr' },
});

/** The PARENT: chat → agent, agent → call_workflow (tool edge) → the given sub-workflow. */
const parentDoc = (subWorkflowId: string, agentParams: Record<string, unknown> = {}): WorkflowIR => ({
  version: '1.0',
  name: 'parent',
  description: '',
  nodes: [
    wfNode('chat', 'orchestr:chat'),
    wfNode('agent', 'orchestr:agent', {
      model: { provider: 'claude', model: 'claude-opus-4-8' },
      system_prompt: 'Use the tool then answer.',
      max_steps: 4,
      input: '{{trigger.chatInput}}',
      ...agentParams,
    }),
    wfNode('callwf', 'orchestr:call_workflow', { workflow_id: subWorkflowId }),
  ],
  edges: [wfEdge('e-in', 'chat', 'agent', 'main'), wfEdge('e-tool', 'agent', 'callwf', 'tool')],
  settings: { execution_order: 'v1', extra: {} },
  metadata: { engine: 'orchestr' },
});

/** A sub-workflow that never declared itself callable — a plain manual trigger. */
const undeclaredDoc = (): Record<string, unknown> => ({
  version: '1.0',
  name: 'sub undeclared',
  description: '',
  nodes: [
    wfNode('trigger', 'orchestr:trigger'),
    wfNode('concat', 'text.concat', { texts: ['NOPE'], separator: '' }),
  ],
  edges: [wfEdge('e', 'trigger', 'concat', 'main')],
  settings: { execution_order: 'v1', extra: {} },
  metadata: { engine: 'orchestr' },
});

/** A parent calling a workflow as an ordinary STEP: trigger → call_workflow → concat. */
const stepParentDoc = (
  subWorkflowId: string,
  input: Record<string, unknown> = { q: 'hello' },
): WorkflowIR => ({
  version: '1.0',
  name: 'step parent',
  description: '',
  nodes: [
    wfNode('trigger', 'orchestr:trigger'),
    wfNode('callwf', 'orchestr:call_workflow', { workflow_id: subWorkflowId, input }),
    wfNode('after', 'text.concat', { texts: ['GOT:', '{{callwf}}'], separator: '' }),
  ],
  edges: [wfEdge('e1', 'trigger', 'callwf', 'main'), wfEdge('e2', 'callwf', 'after', 'main')],
  settings: { execution_order: 'v1', extra: {} },
  metadata: { engine: 'orchestr' },
});

/** The agent output's FIRST tool step (most tests call one tool once). */
function toolStep(result: { outputs: Record<string, unknown> }): AgentStep | undefined {
  const agent = result.outputs.agent as AgentResult;
  return agent.steps.find((s) => s.kind === 'tool');
}

/** All of the agent's tool steps — for the fan-out budget assertions. */
function toolSteps(result: { outputs: Record<string, unknown> }): AgentStep[] {
  return (result.outputs.agent as AgentResult).steps.filter((s) => s.kind === 'tool');
}

/** Did a tool step come back a normalized error (vs a real result)? */
function isToolError(step: AgentStep): boolean {
  return typeof step.output === 'object' && step.output !== null && 'error' in step.output;
}

/** Sub-workflow-as-tool (feature A) end-to-end, isolated DB, DBOS OFF (direct path). */
describe('sub-workflow-as-tool — runner + node (e2e, isolated DB)', () => {
  let app: INestApplication;
  let db: Client;

  const callerId = randomUUID(); // the run tenant + owner of the deployed sub-workflows
  const ownerId = randomUUID(); // owns the prod stripe slot's connection (distinct key)
  const otherUserId = randomUUID(); // owns a cross-org workflow the caller may NOT call
  const subOwnerId = randomUUID(); // a DIFFERENT user who owns an in-org sub-workflow (run-as-caller isolation)
  const keyA = 'ork_e2e_subwf_aaaaaaaaaaaaaaaaaaaaaa';
  const hash = (k: string): string => createHash('sha256').update(k, 'utf8').digest('hex');
  const asA = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${keyA}`);
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  let orgId = '';
  let prodEnvId = '';
  let echoWfId = '';
  let stripeWfId = '';
  let unpromotedWfId = '';
  let waitWfId = '';
  let ownedStripeWfId = ''; // owned by subOwnerId (a different user), in the caller's org
  let subInnerWfId = '';
  let subMidWfId = '';
  let undeclaredWfId = ''; // never declared callable → refused on both call paths
  const crossOrgWfId = randomUUID();
  const otherOrgId = randomUUID();

  const deploy = async (doc: Record<string, unknown>): Promise<string> => {
    const res = await asA(
      http().post('/api/deploy').set('X-Org-Id', orgId).send({ workflow_json: doc }),
    ).expect(201);
    return res.body.workflow_id as string;
  };

  beforeAll(async () => {
    const e2eUrl = await createE2eDatabase(ADMIN_URL);
    db = new Client({ connectionString: e2eUrl });
    await db.connect();
    await db.query(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES ($1, 'caller-subwf@e2e.local', 'Caller', now(), now())`,
      [callerId],
    );
    await db.query(
      `INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (gen_random_uuid(), $1, 'a', $2, $3, now())`,
      [callerId, hash(keyA), keyA.slice(0, 12)],
    );

    process.env.DATABASE_URL = e2eUrl;
    process.env.PGBOSS_ENABLED = 'false';
    process.env.DBOS_ENABLED = 'false'; // direct path so the nested run resolves synchronously
    process.env.THROTTLE_LIMIT = '10000';
    process.env.MOCK_AUTH = 'false';
    process.env.CLERK_ISSUER = '';
    process.env.DRIFT_POLL_INTERVAL_SECONDS = '0';
    process.env.FERNET_KEY = TEST_FERNET_KEY;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AGENT_MODEL_CALL)
      .useValue(model)
      .overrideProvider(SDK_ACTIONS_FETCH)
      .useValue(actionFetch)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false, bufferLogs: true });
    configureApp(app);
    await app.init();
    await listenOnLoopback(app);

    // Org (caller = owner) → deploy the sub-workflows (each promoted to production).
    orgId = (await asA(http().post('/api/orgs').send({ name: 'Acme' })).expect(201)).body.id as string;
    echoWfId = await deploy(echoDoc());
    stripeWfId = await deploy(stripeDoc());
    unpromotedWfId = await deploy(echoDoc());
    waitWfId = await deploy(waitDoc()); // L3: contains a wait_for_event → rejected as a tool
    subInnerWfId = await deploy(echoDoc()); // L4b: the leaf of a real 2-level chain
    subMidWfId = await deploy(midAgentDoc(subInnerWfId)); // L4b: an agent that calls subInner
    undeclaredWfId = await deploy(undeclaredDoc()); // S4: no tool_trigger → not callable

    // The production env row was created by the first promote — grab its id.
    prodEnvId = (
      await db.query(`SELECT id FROM environments WHERE org_id = $1 AND name = 'production'`, [orgId])
    ).rows[0].id as string;

    // Un-promote one sub-workflow so it has NO live version in production (honest-error case).
    await db.query(`DELETE FROM workflow_env_pointers WHERE workflow_id = $1`, [unpromotedWfId]);
    await db.query(`UPDATE workflows SET active_version_id = NULL WHERE id = $1`, [unpromotedWfId]);

    // The prod STRIPE slot: a connection owned by a DISTINCT user, with a distinct key.
    await db.query(`INSERT INTO users (id, email, name) VALUES ($1, 'slot-owner@e2e.local', 'Slot Owner')`, [
      ownerId,
    ]);
    const ownerConn = await app.get(ConnectionsService).createToken(ownerId, {
      provider: 'stripe',
      credential: { api_key: STRIPE_OWNER_KEY },
      displayName: 'Prod Stripe',
    });
    await db.query(
      `INSERT INTO environment_connections (environment_id, app, connection_id) VALUES ($1, 'stripe', $2)`,
      [prodEnvId, ownerConn.id],
    );

    // L4a — a sub-workflow owned by a DIFFERENT in-org user, pinned to that user's own stripe key.
    await db.query(`INSERT INTO users (id, email, name) VALUES ($1, 'subowner@e2e.local', 'Sub Owner')`, [
      subOwnerId,
    ]);
    const subOwnerConn = await app.get(ConnectionsService).createToken(subOwnerId, {
      provider: 'stripe',
      credential: { api_key: STRIPE_SUBOWNER_KEY },
      displayName: 'Sub Owner Personal Stripe',
    });
    ownedStripeWfId = randomUUID();
    const ownedVersionId = randomUUID();
    const ownedIr = ownedStripeDoc(subOwnerConn.id);
    // The two rows reference each other, so the workflow's live-alias pointer is set last.
    await db.query(`INSERT INTO workflows (id, name, org_id, user_id) VALUES ($1, 'owned', $2, $3)`, [
      ownedStripeWfId,
      orgId,
      subOwnerId,
    ]);
    await db.query(
      `INSERT INTO workflow_versions (id, workflow_id, version_number, workflow_json, workflow_ir)
       VALUES ($1, $2, 1, $3, $4)`,
      [ownedVersionId, ownedStripeWfId, JSON.stringify(ownedIr), JSON.stringify(ownedIr)],
    );
    await db.query(`UPDATE workflows SET active_version_id = $2 WHERE id = $1`, [
      ownedStripeWfId,
      ownedVersionId,
    ]);

    // A workflow in ANOTHER org, owned by ANOTHER user — the caller may not call it.
    await db.query(`INSERT INTO users (id, email, name) VALUES ($1, 'other@e2e.local', 'Other')`, [
      otherUserId,
    ]);
    await db.query(`INSERT INTO organizations (id, name) VALUES ($1, 'OtherOrg')`, [otherOrgId]);
    await db.query(`INSERT INTO workflows (id, name, org_id, user_id) VALUES ($1, 'cross', $2, $3)`, [
      crossOrgWfId,
      otherOrgId,
      otherUserId,
    ]);
  }, 45_000);

  afterAll(async () => {
    await app.close();
    await db.end();
    process.env.DATABASE_URL = ADMIN_URL;
  });

  beforeEach(() => {
    modelCalls = 0;
    actionCalls.length = 0;
    strategy = callOnceThenAnswer;
  });

  const runParent = (
    subWorkflowId: string,
    extra: Record<string, unknown> = {},
    agentParams: Record<string, unknown> = {},
  ) =>
    app.get(DagInterpreter).run(compileWorkflowIrDag(parentDoc(subWorkflowId, agentParams)), {
      externalUserId: callerId,
      environment: 'production',
      environmentId: prodEnvId,
      orgId,
      initialScope: { trigger: { chatInput: 'hi' } },
      ...extra,
    });

  it('(a) the agent calls the sub-workflow and its terminal output returns to the model', async () => {
    const result = await runParent(echoWfId);

    const step = toolStep(result);
    expect(step?.output).toBe('SUB_RESULT:hello'); // {{trigger.q}} resolved the model's `{ q: 'hello' }`
    // The model answered off that result, proving it flowed back into the loop.
    expect((result.outputs.agent as AgentResult).text).toBe('answer:SUB_RESULT:hello');
  });

  it('(a2) a Default (no-env) run resolves the sub-workflow PRODUCTION version', async () => {
    const result = await app.get(DagInterpreter).run(compileWorkflowIrDag(parentDoc(echoWfId)), {
      externalUserId: callerId, // owns the sub-workflow → allowed on a Default run
      initialScope: { trigger: { chatInput: 'hi' } },
    });
    expect(toolStep(result)?.output).toBe('SUB_RESULT:hello');
  });

  it('(b) the sub-workflow runs AS the caller — its stripe step resolves the CALLER env slot owner', async () => {
    const result = await runParent(stripeWfId);

    // The PROD slot owner's decrypted key was injected — proving run-AS-caller.
    const stripe = actionCalls.find((c) => c.url.includes('api.stripe.com'));
    expect(stripe).toBeDefined();
    expect(stripe!.headers['authorization']).toBe(`Bearer ${STRIPE_OWNER_KEY}`);
    // The balance output flowed back as the tool result, not an error.
    const step = toolStep(result);
    expect(step?.output).toBeDefined();
    expect(step?.output).not.toMatchObject({ error: expect.anything() });
    expect(JSON.stringify(step?.output)).toContain('4200');
  });

  it('(c) a workflow that calls ITSELF is an author-time compile error', () => {
    const selfId = randomUUID();
    const selfIr = parentDoc(selfId);
    expect(() => compileWorkflowIrDag(selfIr, selfId)).toThrow(/call its own workflow/i);
    // It compiles fine when the enclosing id differs, or is unknown.
    expect(() => compileWorkflowIrDag(selfIr, randomUUID())).not.toThrow();
    expect(() => compileWorkflowIrDag(selfIr)).not.toThrow();
  });

  it('(d) exceeding the sub-workflow depth cap is a clean tool error, not a crash', async () => {
    // Seeded already at the cap, so the very next sub-workflow call is over the bound.
    const result = await runParent(echoWfId, { subWorkflowDepth: MAX_SUB_WORKFLOW_DEPTH });

    const step = toolStep(result);
    expect(step?.output).toMatchObject({
      error: { message: expect.stringMatching(/maximum sub-workflow call depth/i) },
    });
    // The run still COMPLETED — the model got the error and answered.
    expect(typeof (result.outputs.agent as AgentResult).text).toBe('string');
  });

  it('(e) missing / cross-org / unpromoted sub-workflows are honest tool errors, not crashes', async () => {
    // (e1) a workflow id that does not exist.
    const missing = await runParent(randomUUID());
    expect(toolStep(missing)?.output).toMatchObject({
      error: { message: expect.stringMatching(/not found or not accessible/i) },
    });

    // (e2) a workflow in another org, owned by another user — indistinguishable from missing.
    const cross = await runParent(crossOrgWfId);
    expect(toolStep(cross)?.output).toMatchObject({
      error: { message: expect.stringMatching(/not found or not accessible/i) },
    });

    // (e3) a workflow with no live version in the run's environment.
    const unpromoted = await runParent(unpromotedWfId);
    expect(toolStep(unpromoted)?.output).toMatchObject({
      error: { message: expect.stringMatching(/no live version|promote/i) },
    });

    // None of these crashed the run — each agent still produced an answer.
    for (const r of [missing, cross, unpromoted]) {
      expect(typeof (r.outputs.agent as AgentResult).text).toBe('string');
    }
  });

  it('(D1) a run that calls sub-workflows past the invocation budget errors cleanly (fan-out cap)', async () => {
    // max_steps (70) is above the budget, so the tree-wide budget — not depth — is the binding cap.
    strategy = alwaysCallTool;
    const result = await runParent(echoWfId, {}, { max_steps: 70 });

    const steps = toolSteps(result);
    const succeeded = steps.filter((s) => !isToolError(s));
    const budgetErrors = steps.filter(
      (s) => isToolError(s) && /invocation budget/i.test(JSON.stringify(s.output)),
    );
    expect(succeeded).toHaveLength(MAX_SUB_WORKFLOW_INVOCATIONS);
    expect(budgetErrors.length).toBeGreaterThanOrEqual(1);
    // The run still completed — bounded, no crash or hang.
    expect(typeof (result.outputs.agent as AgentResult).text).toBe('string');
  }, 20_000);

  it('(D1b) an agent max_steps over the ceiling is an author-time compile error', () => {
    expect(() => compileWorkflowIrDag(parentDoc(echoWfId, { max_steps: 101 }))).toThrow(
      /max_steps.*(ceiling|exceeds)/i,
    );
    // The ceiling itself compiles.
    expect(() => compileWorkflowIrDag(parentDoc(echoWfId, { max_steps: 100 }))).not.toThrow();
  });

  it("(L3) a sub-workflow that pauses for human input can't be used as a tool (honest error, no hang)", async () => {
    const result = await runParent(waitWfId);
    expect(toolStep(result)?.output).toMatchObject({
      error: { message: expect.stringMatching(/can't be used as an agent tool|wait for event|human input/i) },
    });
    // Rejected up front — the run completed instead of hanging to the wait's timeout.
    expect(typeof (result.outputs.agent as AgentResult).text).toBe('string');
  });

  it("(L4a) run-as-caller uses the CALLER env slot, NOT the sub-workflow owner's own account", async () => {
    const result = await runParent(ownedStripeWfId);

    const stripe = actionCalls.find((c) => c.url.includes('api.stripe.com'));
    expect(stripe).toBeDefined();
    expect(stripe!.headers['authorization']).toBe(`Bearer ${STRIPE_OWNER_KEY}`); // the CALLER's env slot
    // The sub-workflow OWNER's personal key was NEVER injected — no leak of the owner's context.
    for (const c of actionCalls) {
      expect(c.headers['authorization']).not.toBe(`Bearer ${STRIPE_SUBOWNER_KEY}`);
    }
    expect(toolStep(result)?.output).not.toMatchObject({ error: expect.anything() });
  });

  it('(L4b) a REAL 2-level chain runs end-to-end and the deepest output propagates up', async () => {
    // parent → subMid (an agent, depth 1) → subInner (leaf, depth 2), with no seeded depth.
    const result = await runParent(subMidWfId);

    const step = toolStep(result);
    expect(step?.output).toBeDefined();
    expect(step?.output).not.toMatchObject({ error: expect.anything() });
    // subInner echoed at depth 2 and rode subMid's answer back to the parent's model.
    expect(JSON.stringify(step?.output)).toContain('SUB_RESULT:hello');
  }, 15_000);

  // ── the same runner reached from an ORDINARY STEP, no agent involved ──

  const runStep = (ir: WorkflowIR, extra: Record<string, unknown> = {}) =>
    app.get(DagInterpreter).run(compileWorkflowIrDag(ir), {
      externalUserId: callerId,
      environment: 'production',
      environmentId: prodEnvId,
      orgId,
      initialScope: { trigger: { topic: 'from-the-parent' } },
      ...extra,
    });

  it('(S1) a call_workflow STEP runs the child and its output is readable downstream', async () => {
    // The input carries a {{ref}}, so this also proves the step's input is resolved against the
    // parent's scope before it becomes the child's firing event.
    const result = await runStep(stepParentDoc(echoWfId, { q: '{{trigger.topic}}' }));

    expect(result.outputs.callwf).toBe('SUB_RESULT:from-the-parent');
    // A later step reads it exactly like any other step's result.
    expect(result.outputs.after).toBe('GOT:SUB_RESULT:from-the-parent');
  });

  it('(S2) the child is recorded as a run of its OWN workflow, pointing back at the calling step', async () => {
    const { run_id: parentRunId } = await app
      .get(RunsService)
      .runExecutable(compileWorkflowIrDag(stepParentDoc(echoWfId)), {
        externalUserId: callerId,
        environment: 'production',
        environmentId: prodEnvId,
        orgId,
        source: 'manual',
        initialScope: { trigger: {} },
      });

    const child = await db.query(
      `SELECT id, run_id, workflow_id, source, parent_run_id, parent_step_key, status
         FROM runtime_runs WHERE parent_run_id = $1`,
      [`${callerId}:${parentRunId}`],
    );
    expect(child.rowCount).toBe(1);
    expect(child.rows[0]).toMatchObject({
      workflow_id: echoWfId, // the CHILD's workflow, not the caller's
      source: 'sub_workflow',
      parent_step_key: 'callwf',
      status: 'completed',
    });

    // Its steps are recorded too — the whole point: a failure inside is readable.
    const steps = await db.query(`SELECT node_id, status FROM runtime_run_steps WHERE run_id = $1`, [
      child.rows[0].id,
    ]);
    expect(steps.rows.map((r) => r.node_id)).toContain('concat');

    // And the calling step is recorded in the PARENT with its own kind.
    const callStep = await db.query(
      `SELECT kind, status FROM runtime_run_steps WHERE run_id = $1 AND step_key = 'callwf'`,
      [`${callerId}:${parentRunId}`],
    );
    expect(callStep.rows[0]).toMatchObject({ kind: 'callWorkflow', status: 'completed' });

    // Both ends resolve over HTTP — the link is only real if it survives the controller.
    const parentBody = (await asA(http().get(`/api/runs/${parentRunId}`)).expect(200)).body;
    expect(parentBody.called_by).toBeNull();
    expect(parentBody.calls).toEqual([
      expect.objectContaining({
        run_id: child.rows[0].run_id,
        step_key: 'callwf',
        workflow_id: echoWfId,
        status: 'completed',
      }),
    ]);

    const childBody = (await asA(http().get(`/api/runs/${child.rows[0].run_id}`)).expect(200)).body;
    expect(childBody.called_by).toMatchObject({ run_id: parentRunId, step_key: 'callwf' });
    expect(childBody.calls).toEqual([]);
  });

  it('(S3) a STEP that calls its own workflow is an author-time compile error', () => {
    const selfId = randomUUID();
    const ir = stepParentDoc(selfId);
    // The guard used to live inside the agent-tool peel, which a main-path node never reached.
    expect(() => compileWorkflowIrDag(ir, selfId)).toThrow(/call its own workflow/i);
    expect(() => compileWorkflowIrDag(ir, randomUUID())).not.toThrow();
  });

  it('(S4) a target that never declared itself callable is refused, with a message saying how', async () => {
    await expect(runStep(stepParentDoc(undeclaredWfId))).rejects.toThrow(/doesn't declare itself callable/i);
    // The SAME refusal on the agent path — one rule, both callers.
    const viaAgent = await runParent(undeclaredWfId);
    expect(toolStep(viaAgent)?.output).toMatchObject({
      error: { message: expect.stringMatching(/doesn't declare itself callable/i) },
    });
  });

  it("(S5) the agent's fan-out budget does not bind an authored step", async () => {
    // Seeded exhausted: the agent path refuses here, and the step path must not even consult it —
    // how often an authored step runs is the loop the author wrote, not a model's choice.
    const viaStep = await runStep(stepParentDoc(echoWfId), { subWorkflowBudget: { remaining: 0 } });
    expect(viaStep.outputs.callwf).toBe('SUB_RESULT:hello');

    const viaAgent = await runParent(echoWfId, { subWorkflowBudget: { remaining: 0 } });
    expect(toolStep(viaAgent)?.output).toMatchObject({
      error: { message: expect.stringMatching(/invocation budget/i) },
    });
  });

  it('(S6) the depth cap still bounds a step chain', async () => {
    await expect(
      runStep(stepParentDoc(echoWfId), { subWorkflowDepth: MAX_SUB_WORKFLOW_DEPTH }),
    ).rejects.toThrow(/maximum sub-workflow call depth/i);
  });
});
