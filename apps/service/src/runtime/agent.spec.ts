import { compileWorkflowIrDag } from '../compiler/compile-ir-dag';
import { emptySettings, type IREdge, type IRNode, type WorkflowIR } from '../ir/models';
import { type AgentResult, type ModelTurn } from './agent';
import { ScriptedAgentModel } from './agent.testkit';
import type { DagAgentNode } from './dag-plan';
import { DagInterpreter } from './dag-interpreter';
import type { ManagedIntegrationProvider } from '../providers/managed-integration-provider';

/**
 * The `orchestr:agent` engine: the compiler's tool-edge peel plus the durable loop.
 * A recording provider proves a tool actually ran through the durable dispatch, and the model is
 * scripted so the loop's control flow is exercised deterministically without a network.
 */

// ─── Recording provider: echoes each action + captures the calls it received ───
interface ActionCall {
  actionId: string;
  props: Record<string, unknown>;
}
function recordingProvider(
  calls: ActionCall[],
  onCall: (actionId: string) => unknown = (id) => ({ ran: id }),
): ManagedIntegrationProvider {
  return {
    key: 'rec',
    runAction: (input) => {
      calls.push({ actionId: input.actionId, props: input.props });
      return Promise.resolve({ output: onCall(input.actionId) });
    },
    enableTrigger: () => Promise.resolve(),
    pollTrigger: () => Promise.resolve([]),
    disableTrigger: () => Promise.resolve(),
  };
}

// ─── Native IR builders ────────────────────────────────────────────────────────
function node(id: string, nodeType: string, parameters: Record<string, unknown> = {}): IRNode {
  return {
    id,
    name: id,
    node_type: nodeType,
    type_version: 1,
    parameters,
    position: { x: 0, y: 0 },
    metadata: {},
  };
}
function edge(source: string, target: string, portType = 'main', sourcePort = 0): IREdge {
  return {
    id: `${source}-${portType}-${sourcePort}->${target}`,
    source_node_id: source,
    source_port: sourcePort,
    target_node_id: target,
    target_port: 0,
    port_type: portType,
  };
}
function ir(nodes: IRNode[], edges: IREdge[]): WorkflowIR {
  return {
    version: '1',
    name: 'agent-wf',
    description: '',
    nodes,
    edges,
    settings: emptySettings(),
    metadata: {},
  };
}

/** chat trigger → agent (bound to ONE action tool) → reply — the flow the constitution pins. */
function chatAgentIr(agentParams: Record<string, unknown> = {}): WorkflowIR {
  return ir(
    [
      node('chat', 'orchestr:chat'),
      node('agent', 'orchestr:agent', {
        system_prompt: 'You are helpful.',
        max_steps: 25,
        input: '{{trigger.chatInput}}',
        ...agentParams,
      }),
      node('search', 'slack.send_message', { channel: '#ops' }), // the bound tool node
      node('reply', 'text.concat', { texts: ['{{agent.text}}'], separator: '' }),
    ],
    [edge('chat', 'agent'), edge('agent', 'search', 'tool'), edge('agent', 'reply')],
  );
}

const modelTurn = (over: Partial<ModelTurn> = {}): ModelTurn => ({ toolCalls: [], ...over });

describe('orchestr:agent — compiler tool-edge peel (invariant #14)', () => {
  it('peels the tool edge: the tool target leaves the main flow and attaches to the agent step', () => {
    const plan = compileWorkflowIrDag(chatAgentIr());
    // The main flow is agent → reply; the `search` tool node is NOT a standalone step.
    expect(plan.nodes.map((n) => n.id)).toEqual(['agent', 'reply']);
    const agent = plan.nodes.find((n) => n.id === 'agent') as DagAgentNode;
    expect(agent.kind).toBe('agent');
    expect(agent.tools).toEqual([
      {
        kind: 'action',
        // The model-facing name is sanitized to a provider-legal identifier (the dotted
        // `slack.send_message` node_type would 400 the model call); actionId is untouched.
        name: 'slack_send_message',
        actionId: 'slack.send_message',
        props: { channel: '#ops' },
      },
    ]);
    expect(agent.tools[0]!.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    // Config is first-class IR on the node.
    expect(agent.systemPrompt).toBe('You are helpful.');
    expect(agent.maxSteps).toBe(25);
    expect(agent.model).toEqual({ provider: 'claude', model: 'claude-opus-4-8' });
  });

  it('a sub-workflow tool binds an orchestr:call_workflow node (not a workflow id in params)', () => {
    const doc = ir(
      [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 5 }),
        node('sub', 'orchestr:call_workflow', { workflow_id: 'wf-123', tool_name: 'run_report' }),
      ],
      [edge('chat', 'agent'), edge('agent', 'sub', 'tool')],
    );
    const agent = compileWorkflowIrDag(doc).nodes.find((n) => n.id === 'agent') as DagAgentNode;
    expect(agent.tools).toEqual([{ kind: 'workflow', name: 'run_report', workflowId: 'wf-123' }]);
  });

  it('rejects a tool target that is also a main-flow node (a tool must be dedicated)', () => {
    const doc = ir(
      [node('chat', 'orchestr:chat'), node('agent', 'orchestr:agent', {}), node('shared', 'text.concat')],
      [edge('chat', 'agent'), edge('agent', 'shared'), edge('agent', 'shared', 'tool')],
    );
    expect(() => compileWorkflowIrDag(doc)).toThrow(/dedicated node/);
  });

  it('rejects a tool node with an outgoing MAIN edge — it would orphan the downstream into a DAG root', () => {
    // agent —tool→ search —main→ leak : `search` is a leaf; a main edge off it would peel `search`
    // out of the flow yet leave `leak` behind as an unconditional root (fires detached from the agent).
    const doc = ir(
      [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 5 }),
        node('search', 'slack.send_message', { channel: '#ops' }),
        node('leak', 'text.concat', { texts: ['{{search}}'], separator: '' }),
      ],
      [edge('chat', 'agent'), edge('agent', 'search', 'tool'), edge('search', 'leak')],
    );
    expect(() => compileWorkflowIrDag(doc)).toThrow(/Agent tool "search" cannot have an outgoing main edge/);
  });

  it('rejects a tool node with an outgoing ERROR edge (same leaf rule)', () => {
    const doc = ir(
      [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 5 }),
        node('search', 'slack.send_message'),
        node('handler', 'text.concat'),
      ],
      [edge('chat', 'agent'), edge('agent', 'search', 'tool'), edge('search', 'handler', 'error')],
    );
    expect(() => compileWorkflowIrDag(doc)).toThrow(/Agent tool "search" cannot have an outgoing error edge/);
  });

  it('a tool bound with NO outgoing edge still compiles fine (the leaf case)', () => {
    const doc = ir(
      [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 5 }),
        node('search', 'slack.send_message', { channel: '#ops' }),
      ],
      [edge('chat', 'agent'), edge('agent', 'search', 'tool')],
    );
    const plan = compileWorkflowIrDag(doc);
    expect(plan.nodes.map((n) => n.id)).toEqual(['agent']);
    const agent = plan.nodes.find((n) => n.id === 'agent') as DagAgentNode;
    expect(agent.tools.map((t) => t.name)).toEqual(['slack_send_message']);
  });

  it('a normal (non-tool) main edge off the agent is unaffected — only tool nodes are leaves', () => {
    // agent —tool→ search (leaf) alongside agent —main→ reply —main→ next : the reply→next main
    // edge leaves a NON-tool node, so the leaf guard must NOT fire — the chain compiles.
    const doc = ir(
      [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 5 }),
        node('search', 'slack.send_message', { channel: '#ops' }),
        node('reply', 'text.concat', { texts: ['{{agent.text}}'], separator: '' }),
        node('next', 'text.concat', { texts: ['{{reply}}'], separator: '' }),
      ],
      [edge('chat', 'agent'), edge('agent', 'search', 'tool'), edge('agent', 'reply'), edge('reply', 'next')],
    );
    const plan = compileWorkflowIrDag(doc);
    expect(plan.nodes.map((n) => n.id)).toEqual(['agent', 'reply', 'next']);
  });

  it('rejects a non-positive max_steps (the hard loop cap is required)', () => {
    expect(() => compileWorkflowIrDag(chatAgentIr({ max_steps: 0 }))).toThrow(/max_steps/);
  });
});

describe('orchestr:agent — durable loop (scripted model)', () => {
  const runWith = (
    doc: WorkflowIR,
    turns: ModelTurn[],
    provider: ManagedIntegrationProvider,
    calls: ActionCall[] = [],
  ) => {
    const model = new ScriptedAgentModel(turns);
    const interpreter = new DagInterpreter(provider, undefined, undefined, undefined, model);
    return { model, interpreter, calls, plan: compileWorkflowIrDag(doc) };
  };

  it("hands the model the sub-workflow's DECLARED contract, and its own text still wins", async () => {
    const doc = ir(
      [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 3 }),
        node('sub', 'orchestr:call_workflow', { workflow_id: 'wf-doubler', tool_name: 'doubler' }),
      ],
      [edge('chat', 'agent'), edge('agent', 'sub', 'tool')],
    );
    const { model, interpreter, plan } = runWith(
      doc,
      [{ text: 'done', toolCalls: [], usage: { totalTokens: 1 } }],
      recordingProvider([], () => ({})),
    );
    interpreter.setAgentWorkflowCatalog({
      describeWorkflow: () =>
        Promise.resolve({
          description: 'Doubles a number. Pass the number as n.',
          parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
        }),
    });

    await interpreter.run(plan, { externalUserId: 'u1', initialScope: { trigger: { chatInput: 'go' } } });

    const tool = model.requests[0]!.tools[0]!;
    expect(tool.description).toBe('Doubles a number. Pass the number as n.');
    // Without this the model is handed an open schema and can only ever call the tool with {}.
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: { n: { type: 'number' } },
      required: ['n'],
    });
  });

  it('offers an open schema when the sub-workflow declares nothing, rather than failing the run', async () => {
    const doc = ir(
      [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 3 }),
        node('sub', 'orchestr:call_workflow', { workflow_id: 'wf-bare', tool_name: 'bare' }),
      ],
      [edge('chat', 'agent'), edge('agent', 'sub', 'tool')],
    );
    const { model, interpreter, plan } = runWith(
      doc,
      [{ text: 'done', toolCalls: [], usage: { totalTokens: 1 } }],
      recordingProvider([], () => ({})),
    );
    interpreter.setAgentWorkflowCatalog({ describeWorkflow: () => Promise.resolve(undefined) });

    await interpreter.run(plan, { externalUserId: 'u1', initialScope: { trigger: { chatInput: 'go' } } });

    const tool = model.requests[0]!.tools[0]!;
    expect(tool.description).toBe('Runs the bare workflow');
    expect(tool.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('runs the tool via the durable dispatch, returns {text,...}, and records steps[] in the pinned shape', async () => {
    const calls: ActionCall[] = [];
    const provider = recordingProvider(calls, () => ({ ok: true, msg: 'sent' }));
    const { model, interpreter, plan } = runWith(
      chatAgentIr(),
      [
        modelTurn({
          text: 'searching',
          // The model calls the tool by its SANITIZED model-facing name (what it saw in the schema).
          toolCalls: [{ id: 'c1', name: 'slack_send_message', input: { text: 'hello' } }],
          usage: { totalTokens: 10 },
        }),
        modelTurn({ text: 'all done', usage: { totalTokens: 5 } }),
      ],
      provider,
    );

    const result = await interpreter.run(plan, {
      externalUserId: 'u',
      initialScope: { trigger: { chatInput: 'find the thing' } },
    });

    // The tool ACTUALLY ran through the provider seam — base props merged with the model's input —
    // and the downstream reply node then ran, reading the agent's deterministic text.
    expect(calls).toEqual([
      { actionId: 'slack.send_message', props: { channel: '#ops', text: 'hello' } },
      { actionId: 'text.concat', props: { texts: ['all done'], separator: '' } },
    ]);

    // The agent output is the deterministic reply object.
    const agentOut = result.outputs.agent as AgentResult;
    expect(agentOut.text).toBe('all done');
    expect(agentOut.usage).toEqual({ totalTokens: 15 });
    expect(agentOut.steps).toEqual([
      { step_index: 0, kind: 'model', text: 'searching' },
      {
        step_index: 1,
        kind: 'tool',
        tool: 'slack_send_message',
        input: { text: 'hello' },
        output: { ok: true, msg: 'sent' },
      },
      { step_index: 2, kind: 'model', text: 'all done' },
      { step_index: 3, kind: 'final', text: 'all done' },
    ]);

    // The first user message is the resolved input; the model saw the tool's schema under its
    // sanitized, provider-legal name (no dot — that would 400 the model call).
    expect(model.requests[0]!.messages[0]).toEqual({ role: 'user', content: 'find the thing' });
    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual(['slack_send_message']);
    expect(model.requests[0]!.tools[0]!.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('feeds a tool error back to the model — the agent recovers within the budget', async () => {
    const provider = recordingProvider([], (id) => {
      if (id === 'slack.send_message') throw new Error('slack 500');
      return { ran: id };
    });
    const { interpreter, plan } = runWith(
      chatAgentIr(),
      [
        modelTurn({ toolCalls: [{ id: 'c1', name: 'slack_send_message', input: {} }] }),
        modelTurn({ text: 'recovered without the tool' }),
      ],
      provider,
    );
    const result = await interpreter.run(plan, {
      externalUserId: 'u',
      initialScope: { trigger: { chatInput: 'x' } },
    });
    const agentOut = result.outputs.agent as AgentResult;
    expect(agentOut.text).toBe('recovered without the tool');
    // The tool step captured the normalized error (fed back, not thrown).
    const toolStep = agentOut.steps.find((s) => s.kind === 'tool')!;
    expect(toolStep.output).toEqual({ error: { message: 'slack 500' } });
  });

  it('at max_steps (no error lane) synthesizes a final answer and returns the partial (never a bare throw)', async () => {
    const calls: ActionCall[] = [];
    const provider = recordingProvider(calls);
    const { model, interpreter, plan } = runWith(
      chatAgentIr({ max_steps: 3 }),
      // An always-tool-calling turn (repeats forever) that also carries text + usage.
      [
        modelTurn({
          text: 'partial progress',
          toolCalls: [{ id: 'c', name: 'slack_send_message', input: {} }],
          usage: { totalTokens: 4 },
        }),
      ],
      provider,
      calls,
    );
    const result = await interpreter.run(plan, {
      externalUserId: 'u',
      initialScope: { trigger: { chatInput: 'x' } },
    });
    // The accumulated answer + transcript + usage SURVIVE — not destroyed by a throw.
    const agentOut = result.outputs.agent as AgentResult;
    expect(agentOut.truncated).toBe(true);
    expect(agentOut.text).toBe('partial progress'); // from the final tool-less synth pass
    expect(agentOut.usage.totalTokens).toBeGreaterThan(0); // synth usage aggregated in too (4×4)
    expect(agentOut.usage.totalTokens).toBe(16);
    expect(agentOut.steps.length).toBeGreaterThan(0);
    expect(agentOut.steps.at(-1)).toEqual({
      step_index: agentOut.steps.length - 1,
      kind: 'final',
      text: 'partial progress',
    });
    // Bounded: exactly max_steps tool-calling rounds + ONE tool-less synth call, no more tool runs.
    expect(model.callCount).toBe(4); // 3 loop rounds + 1 synth
    expect(calls.filter((c) => c.actionId === 'slack.send_message')).toHaveLength(3);
    // The synth call forced a natural-language close-out — it was made with NO tools.
    expect(model.requests.at(-1)!.tools).toEqual([]);
  });

  it('routes max_steps exhaustion to the error lane — CARRYING the partial (§7)', async () => {
    const doc = ir(
      [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 2 }),
        node('tool', 'slack.send_message'),
        node('handler', 'text.concat', { texts: ['handled'], separator: '' }),
      ],
      [edge('chat', 'agent'), edge('agent', 'tool', 'tool'), edge('agent', 'handler', 'error')],
    );
    const provider = recordingProvider([]);
    const { interpreter, plan } = runWith(
      doc,
      [
        modelTurn({
          text: 'still working',
          toolCalls: [{ id: 'c', name: 'slack_send_message', input: {} }],
          usage: { totalTokens: 3 },
        }),
      ],
      provider,
    );
    const result = await interpreter.run(plan, {
      externalUserId: 'u',
      initialScope: { trigger: { chatInput: 'x' } },
    });
    // The error lane ran (in place of the agent's main successors) — the run completes.
    // (The handler runs through the recording provider, so its output is the provider echo.)
    expect(result.outputs.handler).toEqual({ ran: 'text.concat' });
    // The partial agent result SURVIVED to scope (not discarded): synth text + transcript + usage,
    // flagged truncated + errored — so the error lane / downstream refs can still read it.
    const agentOut = result.outputs.agent as AgentResult & { __errored?: boolean };
    expect(agentOut.__errored).toBe(true);
    expect(agentOut.truncated).toBe(true);
    expect(agentOut.text).toBe('still working');
    expect(agentOut.usage.totalTokens).toBeGreaterThan(0);
    expect(agentOut.steps.length).toBeGreaterThan(0);
  });

  it('a sub-workflow tool is unavailable without a bound runner → the error is fed back (never crashes)', async () => {
    const doc = ir(
      [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 5 }),
        node('sub', 'orchestr:call_workflow', { workflow_id: 'wf-9', tool_name: 'sub' }),
      ],
      [edge('chat', 'agent'), edge('agent', 'sub', 'tool')],
    );
    const provider = recordingProvider([]);
    const { interpreter, plan } = runWith(
      doc,
      [modelTurn({ toolCalls: [{ id: 'c', name: 'sub', input: { q: 1 } }] }), modelTurn({ text: 'ok' })],
      provider,
    );
    const result = await interpreter.run(plan, {
      externalUserId: 'u',
      initialScope: { trigger: { chatInput: 'x' } },
    });
    const agentOut = result.outputs.agent as AgentResult;
    const toolStep = agentOut.steps.find((s) => s.kind === 'tool')!;
    expect(toolStep.output).toEqual({
      error: { message: 'sub-workflow tools are not available in this runtime' },
    });
    expect(agentOut.text).toBe('ok');
  });
});

describe('orchestr:agent — provider-legal tool names (fix: sanitize + dedupe)', () => {
  const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
  const runWith = (doc: WorkflowIR, turns: ModelTurn[], provider: ManagedIntegrationProvider) => {
    const model = new ScriptedAgentModel(turns);
    const interpreter = new DagInterpreter(provider, undefined, undefined, undefined, model);
    return { model, interpreter, plan: compileWorkflowIrDag(doc) };
  };

  it('sanitizes a dotted PUBLIC action name (gmail.send_email) to a legal identifier', () => {
    const doc = ir(
      [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 5 }),
        node('t', 'gmail.send_email', { to: 'a@b.c' }),
      ],
      [edge('chat', 'agent'), edge('agent', 't', 'tool')],
    );
    const agent = compileWorkflowIrDag(doc).nodes.find((n) => n.id === 'agent') as DagAgentNode;
    const tool = agent.tools[0] as { name: string; actionId: string };
    expect(tool.name).toBe('gmail_send_email');
    expect(tool.name).toMatch(NAME_RE);
    expect(tool.actionId).toBe('gmail.send_email'); // execution is keyed by the real id, not the name
  });

  it('sanitizes an INTERNAL @pkg/x:y action name to a legal identifier', () => {
    const doc = ir(
      [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 5 }),
        node('t', '@pkg/x:y'),
      ],
      [edge('chat', 'agent'), edge('agent', 't', 'tool')],
    );
    const agent = compileWorkflowIrDag(doc).nodes.find((n) => n.id === 'agent') as DagAgentNode;
    const tool = agent.tools[0] as { name: string; actionId: string };
    expect(tool.name).toMatch(NAME_RE);
    expect(tool.name).toBe('_pkg_x_y');
    expect(tool.actionId).toBe('@pkg/x:y');
  });

  it('a user-set tool_name alias is honored but still sanitized to a legal identifier', () => {
    const doc = ir(
      [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 5 }),
        node('t', 'gmail.send_email', { tool_name: 'send.the::email!' }),
      ],
      [edge('chat', 'agent'), edge('agent', 't', 'tool')],
    );
    const agent = compileWorkflowIrDag(doc).nodes.find((n) => n.id === 'agent') as DagAgentNode;
    expect(agent.tools[0]!.name).toBe('send_the_email_');
    expect(agent.tools[0]!.name).toMatch(NAME_RE);
  });

  it('dedupes two tools that sanitize to the SAME name (append _2), keeping distinct actionIds', () => {
    // `slack.send_message` and `slack.send.message` both sanitize to `slack_send_message`.
    const doc = ir(
      [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 5 }),
        node('a', 'slack.send_message', { channel: '#a' }),
        node('b', 'slack.send.message', { channel: '#b' }),
      ],
      [edge('chat', 'agent'), edge('agent', 'a', 'tool'), edge('agent', 'b', 'tool')],
    );
    const agent = compileWorkflowIrDag(doc).nodes.find((n) => n.id === 'agent') as DagAgentNode;
    const names = agent.tools.map((t) => t.name);
    expect(names).toEqual(['slack_send_message', 'slack_send_message_2']);
    expect(new Set(names).size).toBe(2); // the uniqueness guard: no collision survives
    names.forEach((n) => expect(n).toMatch(NAME_RE));
  });

  it('the loop resolves the model call back to the RIGHT actionId after sanitize + dedupe', async () => {
    const doc = ir(
      [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 5 }),
        node('a', 'slack.send_message', { channel: '#a' }),
        node('b', 'slack.send.message', { channel: '#b' }),
      ],
      [edge('chat', 'agent'), edge('agent', 'a', 'tool'), edge('agent', 'b', 'tool')],
    );
    const calls: ActionCall[] = [];
    const provider = recordingProvider(calls, () => ({ ok: true }));
    const { interpreter, plan } = runWith(
      doc,
      [
        // The model calls the DEDUPED name → must resolve to node `b`'s action, base props merged.
        modelTurn({ toolCalls: [{ id: 'c1', name: 'slack_send_message_2', input: { text: 'hi' } }] }),
        modelTurn({ text: 'done' }),
      ],
      provider,
    );
    await interpreter.run(plan, { externalUserId: 'u', initialScope: { trigger: { chatInput: 'x' } } });
    expect(calls).toEqual([{ actionId: 'slack.send.message', props: { channel: '#b', text: 'hi' } }]);
  });
});

describe('orchestr:agent — non-empty tool descriptions (fix)', () => {
  const runWith = (doc: WorkflowIR, turns: ModelTurn[], provider: ManagedIntegrationProvider) => {
    const model = new ScriptedAgentModel(turns);
    const interpreter = new DagInterpreter(provider, undefined, undefined, undefined, model);
    return { model, interpreter, plan: compileWorkflowIrDag(doc) };
  };

  it('a sub-workflow tool with no tool_description gets a synthesized fallback (never "")', async () => {
    const doc = ir(
      [
        node('chat', 'orchestr:chat'),
        node('agent', 'orchestr:agent', { max_steps: 5 }),
        node('sub', 'orchestr:call_workflow', { workflow_id: 'wf-1', tool_name: 'run_report' }),
      ],
      [edge('chat', 'agent'), edge('agent', 'sub', 'tool')],
    );
    const { model, interpreter, plan } = runWith(doc, [modelTurn({ text: 'ok' })], recordingProvider([]));
    await interpreter.run(plan, { externalUserId: 'u', initialScope: { trigger: { chatInput: 'x' } } });
    const desc = model.requests[0]!.tools[0]!.description;
    expect(desc).not.toBe('');
    expect(desc).toBe('Runs the run_report workflow');
  });

  it('an uncatalogued action tool with no tool_description falls back to its action id (never "")', async () => {
    // No AgentToolCatalog is bound in unit tests → the described?.description path is empty too.
    const { model, interpreter, plan } = runWith(
      chatAgentIr(),
      [modelTurn({ text: 'ok' })],
      recordingProvider([]),
    );
    await interpreter.run(plan, { externalUserId: 'u', initialScope: { trigger: { chatInput: 'x' } } });
    const desc = model.requests[0]!.tools[0]!.description;
    expect(desc).not.toBe('');
    expect(desc).toBe('slack.send_message');
  });
});
