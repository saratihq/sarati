import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ConfigService } from '@nestjs/config';

import type { EnvConfig } from '../config/env.config';
import { emptySettings, type IREdge, type IRNode, type WorkflowIR } from '../ir/models';
import type { ManagedIntegrationProvider } from '../providers/managed-integration-provider';
import { SdkActionsProvider } from '../providers/sdk-actions.provider';
import { DagInterpreter } from '../runtime/dag-interpreter';
import type { DagActionNode, DagIfNode } from '../runtime/dag-plan';

// A config stub for the SDK provider — http.send_request is auth `none`.
const sdkConfig = {
  get: () => ({ composioApiKey: '', composioBaseUrl: '' }) as Partial<EnvConfig>,
} as unknown as ConfigService<{ env: EnvConfig }, true>;

/** A full ManagedIntegrationProvider backed by the SDK actions (no triggers here). */
function sdkProvider(): ManagedIntegrationProvider {
  const actions = new SdkActionsProvider(sdkConfig);
  return {
    key: 'sdk',
    runAction: (input) => actions.runAction(input),
    enableTrigger: () => Promise.resolve(),
    pollTrigger: () => Promise.resolve([]),
    disableTrigger: () => Promise.resolve(),
  };
}
// Imported ONLY here (moat-exempt) to prove the compiler's trigger-kind literal still equals
// the trigger layer's own constant — see the sync-guard test below.
import { ORCHESTR_SCHEDULE } from '../triggers/schedule';
import { compileWorkflowIrDag } from './compile-ir-dag';
import { isTriggerNode } from './compile-ir';

// The generic native action carrier used across these tests (mapNode's direct-action path).
const HTTP = 'http.send_request';

function irNode(id: string, nodeType: string, parameters: Record<string, unknown>): IRNode {
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
function edge(source: string, target: string): IREdge {
  return {
    id: `${source}->${target}`,
    source_node_id: source,
    source_port: 0,
    target_node_id: target,
    target_port: 0,
    port_type: 'main',
  };
}
function ir(nodes: IRNode[], edges: IREdge[]): WorkflowIR {
  return { version: '1', name: 'wf', description: '', nodes, edges, settings: emptySettings(), metadata: {} };
}
const action = (plan: ReturnType<typeof compileWorkflowIrDag>, id: string): DagActionNode =>
  plan.nodes.find((n) => n.id === id) as DagActionNode;
const ifOf = (plan: ReturnType<typeof compileWorkflowIrDag>, id: string): DagIfNode =>
  plan.nodes.find((n) => n.id === id) as unknown as DagIfNode;

/**
 * Exercises the shared helpers `compileWorkflowIrDag` reuses — `mapNode`, `makeTranslator`,
 * `isTriggerNode`, `compileIfCondition` — through the compiler, on the native node types.
 */
describe('compileWorkflowIrDag — node mapping + translation (via the shared helpers)', () => {
  it('orders nodes by their edge dependencies (topological)', () => {
    const plan = compileWorkflowIrDag(
      ir(
        [
          irNode('c', HTTP, { url: 'http://x/' }),
          irNode('a', HTTP, { url: 'http://x/' }),
          irNode('b', HTTP, { url: 'http://x/' }),
        ],
        [edge('a', 'b'), edge('b', 'c')],
      ),
    );
    expect(plan.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('throws on a cycle', () => {
    expect(() =>
      compileWorkflowIrDag(
        ir(
          [irNode('a', HTTP, { url: 'x' }), irNode('b', HTTP, { url: 'x' })],
          [edge('a', 'b'), edge('b', 'a')],
        ),
      ),
    ).toThrow(/cycle/i);
  });

  it('throws on an unrunnable node type (neither an action nor a control node)', () => {
    expect(() => compileWorkflowIrDag(ir([irNode('x', 'orchestr:frobnicate', {})], []))).toThrow(
      /Step "x" isn't runnable on this engine yet.*orchestr:frobnicate/,
    );
  });

  it('translates legacy $node cross-node expressions to native refs (and strips the = prefix)', () => {
    const plan = compileWorkflowIrDag(
      ir(
        [
          irNode('a', HTTP, { url: 'http://x/' }),
          irNode('b', HTTP, { url: '=http://x/{{ $node["a"].json.token }}' }),
        ],
        [edge('a', 'b')],
      ),
    );
    expect(action(plan, 'b').props.url).toBe('http://x/{{a.body.token}}');
  });

  it('a native <app>.<action> node compiles to a direct action (parameters ARE props; no connection ⇒ no auth)', () => {
    const plan = compileWorkflowIrDag(ir([irNode('h', HTTP, { method: 'GET', url: 'http://x/' })], []));
    const h = action(plan, 'h');
    expect(h.actionId).toBe('http.send_request');
    expect(h.props.method).toBe('GET');
    expect(h.props.url).toBe('http://x/');
    expect(h.auth).toBeUndefined();
  });

  it('wires an attached connectionId parameter into the action auth reference (and strips it from props)', () => {
    const plan = compileWorkflowIrDag(
      ir([irNode('g', 'gmail.send_email', { to: 'a@b.co', connectionId: 'conn-9' })], []),
    );
    const g = action(plan, 'g');
    expect(g.auth).toEqual({ connectionId: 'conn-9' });
    expect(g.props.connectionId).toBeUndefined();
    expect(g.props.to).toBe('a@b.co');
  });

  describe('round trip: IR → compile → run', () => {
    let server: Server;
    let baseUrl: string;
    const interpreter = new DagInterpreter(sdkProvider());

    beforeAll(async () => {
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          url.pathname === '/source'
            ? JSON.stringify({ id: 42 })
            : JSON.stringify({ echoed: url.searchParams.get('v') }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    });

    it('compiles a 2-node IR (with a cross-node ref) into a plan that runs', async () => {
      const workflow = ir(
        [
          // Deliberately out of order — the compiler must run `fetch` first.
          irNode('use', HTTP, { method: 'GET', url: `${baseUrl}/echo?v={{ $node["fetch"].json.id }}` }),
          irNode('fetch', HTTP, { method: 'GET', url: `${baseUrl}/source` }),
        ],
        [edge('fetch', 'use')],
      );
      const plan = compileWorkflowIrDag(workflow);
      expect(plan.nodes.map((n) => n.id)).toEqual(['fetch', 'use']);

      const result = await interpreter.run(plan, { externalUserId: 'u' });
      expect((result.outputs.fetch as { body: unknown }).body).toEqual({ id: 42 });
      expect((result.outputs.use as { body: { echoed: string } }).body.echoed).toBe('42');
    });
  });

  describe('trigger nodes compile away', () => {
    it('drops trigger nodes; refs to them become {{trigger.*}}', () => {
      const workflow = ir(
        [
          irNode('trig', 'orchestr:webhook', { path: 'wf-x' }),
          irNode('step', HTTP, { method: 'GET', url: 'http://x/?v={{ $node["trig"].json.email }}' }),
        ],
        [edge('trig', 'step')],
      );
      const plan = compileWorkflowIrDag(workflow);
      expect(plan.nodes.map((n) => n.id)).toEqual(['step']);
      expect(action(plan, 'step').props.url).toBe('http://x/?v={{trigger.email}}');
    });

    it('$json right after the trigger reads the trigger payload', () => {
      const workflow = ir(
        [
          irNode('trig', 'orchestr:trigger', {}),
          irNode('step', HTTP, { method: 'GET', url: '=http://x/?v={{ $json.email }}' }),
        ],
        [edge('trig', 'step')],
      );
      expect(action(compileWorkflowIrDag(workflow), 'step').props.url).toBe('http://x/?v={{trigger.email}}');
    });
  });

  describe('$json implicit input', () => {
    it('resolves to the immediate upstream output (.body convention)', () => {
      const workflow = ir(
        [
          irNode('fetch', HTTP, { method: 'GET', url: 'http://x/src' }),
          irNode('use', HTTP, { method: 'GET', url: '=http://x/?v={{ $json.id }}' }),
        ],
        [edge('fetch', 'use')],
      );
      expect(action(compileWorkflowIrDag(workflow), 'use').props.url).toBe('http://x/?v={{fetch.body.id}}');
    });
  });

  describe('IF branches (flat DAG guards)', () => {
    it('compiles orchestr:if: then → guard port 0, else → guard port 1 ($json resolves through the router)', () => {
      const workflow = ir(
        [
          irNode('trig', 'orchestr:webhook', {}),
          irNode('check', 'orchestr:if', { left: '{{ $json.status }}', op: 'eq', right: 'active' }),
          irNode('yes', HTTP, { method: 'GET', url: '=http://x/yes?s={{ $json.status }}' }),
          irNode('no', HTTP, { method: 'GET', url: 'http://x/no' }),
        ],
        [
          edge('trig', 'check'),
          edge('check', 'yes'), // port 0 = true branch
          { ...edge('check', 'no'), source_port: 1 }, // port 1 = false branch
        ],
      );
      const plan = compileWorkflowIrDag(workflow);
      const check = ifOf(plan, 'check');
      expect(check.kind).toBe('if');
      // $json inside the IF condition reads the trigger payload (its upstream).
      expect(check.condition).toEqual({ left: '{{trigger.status}}', op: 'eq', right: 'active' });
      // then/else are expressed as guards on the downstream nodes, not nested arrays.
      expect(action(plan, 'yes').guards).toEqual([{ source: 'check', port: 0 }]);
      expect(action(plan, 'no').guards).toEqual([{ source: 'check', port: 1 }]);
      // $json INSIDE a branch skips through the IF (a data pass-through) to the
      // nearest data-producing upstream — here the trigger.
      expect(action(plan, 'yes').props.url).toBe('http://x/yes?s={{trigger.status}}');
    });

    it('maps truthy-style operations without a right operand', () => {
      const workflow = ir(
        [
          irNode('check', 'orchestr:if', { left: '{{ $json.flag }}', op: 'truthy' }),
          irNode('yes', HTTP, { method: 'GET', url: 'http://x/yes' }),
        ],
        [edge('check', 'yes')],
      );
      // No upstream data producer, so $json is left untouched (nothing to resolve to).
      expect(ifOf(compileWorkflowIrDag(workflow), 'check').condition).toEqual({
        left: '{{ $json.flag }}',
        op: 'truthy',
      });
    });

    it('reconverging branches: the join carries one guard per lane, running after EITHER', () => {
      const workflow = ir(
        [
          irNode('check', 'orchestr:if', { left: 'x', op: 'truthy' }),
          irNode('yes', HTTP, { method: 'GET', url: 'http://x/yes' }),
          irNode('no', HTTP, { method: 'GET', url: 'http://x/no' }),
          irNode('join', HTTP, { method: 'GET', url: 'http://x/join' }),
          irNode('after', HTTP, { method: 'GET', url: 'http://x/after' }),
        ],
        [
          edge('check', 'yes'),
          { ...edge('check', 'no'), source_port: 1 },
          edge('yes', 'join'),
          edge('no', 'join'),
          edge('join', 'after'),
        ],
      );
      const plan = compileWorkflowIrDag(workflow);
      // The join appears ONCE, gated on BOTH lanes (OR-join); `after` follows it.
      expect(plan.nodes.filter((n) => n.id === 'join')).toHaveLength(1);
      expect(action(plan, 'join').guards).toEqual([
        { source: 'yes', port: 0 },
        { source: 'no', port: 0 },
      ]);
      expect(action(plan, 'after').guards).toEqual([{ source: 'join', port: 0 }]);
    });

    it('a join fed directly by an EMPTY lane (else falls through) carries the IF port as a guard', () => {
      const workflow = ir(
        [
          irNode('check', 'orchestr:if', { left: '{{trigger.amount}}', op: 'lt', right: 100 }),
          irNode('yes', HTTP, { method: 'GET', url: 'http://x/yes' }),
          irNode('join', HTTP, { method: 'GET', url: 'http://x/join' }),
        ],
        [
          edge('check', 'yes'),
          { ...edge('check', 'join'), source_port: 1 }, // empty else: port 1 straight to the join
          edge('yes', 'join'),
        ],
      );
      const plan = compileWorkflowIrDag(workflow);
      // join runs after the then-lane (yes) OR the empty else-lane (check port 1).
      expect(action(plan, 'join').guards).toEqual([
        { source: 'check', port: 1 },
        { source: 'yes', port: 0 },
      ]);
    });

    it("compiles the built-in engine's orchestr:if (parameters ARE the condition)", () => {
      const workflow = ir(
        [
          irNode('check', 'orchestr:if', { left: '{{trigger.amount}}', op: 'lt', right: 100 }),
          irNode('auto', 'text.concat', { texts: ['auto-approved'], separator: '' }),
          irNode('manual', 'text.concat', { texts: ['needs approval'], separator: '' }),
        ],
        [edge('check', 'auto'), { ...edge('check', 'manual'), source_port: 1 }],
      );
      const plan = compileWorkflowIrDag(workflow);
      const check = ifOf(plan, 'check');
      expect(check.kind).toBe('if');
      expect(check.condition).toEqual({ left: '{{trigger.amount}}', op: 'lt', right: 100 });
      expect(action(plan, 'auto').guards).toEqual([{ source: 'check', port: 0 }]);
      expect(action(plan, 'manual').guards).toEqual([{ source: 'check', port: 1 }]);
    });

    it('compiles orchestr:wait_for_event to a waitForEvent node (HITL approval)', () => {
      const workflow = ir(
        [
          irNode('approval', 'orchestr:wait_for_event', { topic: 'manager_approval', timeout_ms: 120000 }),
          irNode('after', 'text.concat', { texts: ['{{approval.decision}}'], separator: '' }),
        ],
        [edge('approval', 'after')],
      );
      const plan = compileWorkflowIrDag(workflow);
      expect(plan.nodes[0]).toEqual({
        kind: 'waitForEvent',
        id: 'approval',
        topic: 'manager_approval',
        timeoutMs: 120000,
        guards: [],
      });
    });

    it('rejects an orchestr:if with an unknown op', () => {
      const workflow = ir(
        [
          irNode('check', 'orchestr:if', { left: 'x', op: 'wat' }),
          irNode('a', 'text.concat', { texts: ['a'], separator: '' }),
        ],
        [edge('check', 'a')],
      );
      expect(() => compileWorkflowIrDag(workflow)).toThrow(/unsupported op "wat"/);
    });
  });
});

describe('isTriggerNode — the single trigger predicate (ADR 0018 broadening)', () => {
  const withMeta = (nodeType: string, metadata: Record<string, unknown>): IRNode => ({
    ...irNode('n', nodeType, {}),
    metadata,
  });

  it('matches the native canvas trigger kinds', () => {
    expect(isTriggerNode(irNode('t', 'orchestr:webhook', {}))).toBe(true);
    expect(isTriggerNode(irNode('t', 'orchestr:schedule', {}))).toBe(true);
    // orchestr:chat (ADR 0045 addendum) — the synchronous chat-intake start node.
    expect(isTriggerNode(irNode('t', 'orchestr:chat', {}))).toBe(true);
  });

  it('matches any `*trigger`-suffixed type (native start kinds + catalog polling triggers)', () => {
    expect(isTriggerNode(irNode('t', 'orchestr:trigger', {}))).toBe(true);
    expect(isTriggerNode(irNode('t', 'orchestr:webhook_trigger', {}))).toBe(true);
    expect(isTriggerNode(irNode('t', 'sheets.new_row_trigger', {}))).toBe(true);
  });

  it('matches a catalog `<app>.<trigger>` node ONLY when explicitly marked', () => {
    // Lexically identical to a `<app>.<action>` step — the marker is the discriminator.
    expect(isTriggerNode(irNode('t', 'github.new_push', {}))).toBe(false);
    expect(isTriggerNode(withMeta('github.new_push', { trigger: true }))).toBe(true);
  });

  it('never mistakes an ordinary action step for a trigger', () => {
    // `text.concat` / `gmail.send_email` are actions — the compiler must NOT strip them.
    expect(isTriggerNode(irNode('s', 'text.concat', {}))).toBe(false);
    expect(isTriggerNode(irNode('s', 'gmail.send_email', {}))).toBe(false);
    expect(isTriggerNode(irNode('s', 'http.send_request', {}))).toBe(false);
    // A falsy/absent marker is not a trigger.
    expect(isTriggerNode(withMeta('gmail.send_email', { trigger: false }))).toBe(false);
  });

  it('stays in sync with the trigger layer constant (the compiler spells it as a literal)', () => {
    // The predicate hard-codes the literal because the moat forbids importing the trigger
    // layer; this asserts the two can never drift apart.
    expect(isTriggerNode(irNode('t', ORCHESTR_SCHEDULE, {}))).toBe(true);
  });

  it('strips a native canvas webhook trigger node from the compiled plan', () => {
    const plan = compileWorkflowIrDag(
      ir(
        [
          { ...irNode('trig', 'orchestr:webhook', { path: 'orders' }), metadata: {} },
          irNode('step', 'text.concat', { texts: ['ok'], separator: '' }),
        ],
        [edge('trig', 'step')],
      ),
    );
    expect(plan.nodes.map((n) => n.id)).toEqual(['step']); // the trigger compiled away
  });

  it('peels an orchestr:chat trigger: it compiles away, its main-edge target becomes a plan root', () => {
    const plan = compileWorkflowIrDag(
      ir(
        [
          irNode('chat', 'orchestr:chat', { greeting: 'Hi' }),
          irNode('reply', HTTP, { method: 'GET', url: 'http://x/?q={{ $json.chatInput }}' }),
        ],
        [edge('chat', 'reply')],
      ),
    );
    // The chat trigger is stripped; its target is a root (no guards) and refs to
    // the trigger — including `$json` right after it — resolve to `{{trigger.*}}`.
    expect(plan.nodes.map((n) => n.id)).toEqual(['reply']);
    expect(action(plan, 'reply').guards).toEqual([]);
    expect(action(plan, 'reply').props.url).toBe('http://x/?q={{trigger.chatInput}}');
  });
});
