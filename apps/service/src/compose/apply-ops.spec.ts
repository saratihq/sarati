import type { IREdge, WorkflowIR } from '../ir/models';

import {
  ApplyOpsError,
  applyOps,
  applyOpsDetailed,
  emptyIr,
  LAYOUT,
  parseOp,
  type ComposeOp,
} from './apply-ops';

const ALLOWED = new Set([
  'orchestr:trigger',
  'orchestr:if',
  'orchestr:wait_for_event',
  'slack.send_channel_message',
  'sheets.insert_row',
  'http.send_request',
]);

function ops(...list: ComposeOp[]): ComposeOp[] {
  return list;
}

describe('applyOps', () => {
  it('builds the acceptance-scenario graph from a blank draft (trigger → if → slack/sheets)', () => {
    const ir = applyOps(
      null,
      ops(
        { op: 'add_node', node: { id: 'trigger', name: 'Form submitted', node_type: 'orchestr:trigger' } },
        {
          op: 'add_node',
          node: {
            id: 'check_amount',
            name: 'Amount > 500?',
            node_type: 'orchestr:if',
            parameters: { left: '{{trigger.amount}}', op: 'gt', right: '500' },
          },
        },
        {
          op: 'add_node',
          node: {
            id: 'notify_slack',
            node_type: 'slack.send_channel_message',
            parameters: { channel: '#finance', text: 'Large expense: {{trigger.amount}}' },
          },
        },
        {
          op: 'add_node',
          node: { id: 'log_to_sheet', node_type: 'sheets.insert_row', parameters: { values: {} } },
        },
        { op: 'connect', source_node_id: 'trigger', target_node_id: 'check_amount' },
        { op: 'connect', source_node_id: 'check_amount', target_node_id: 'notify_slack', source_port: 0 },
        { op: 'connect', source_node_id: 'check_amount', target_node_id: 'log_to_sheet', source_port: 1 },
      ),
      ALLOWED,
    );

    expect(ir.nodes.map((n) => n.id)).toEqual(['trigger', 'check_amount', 'notify_slack', 'log_to_sheet']);
    expect(ir.edges).toHaveLength(3);
    const elseEdge = ir.edges.find((e) => e.source_port === 1);
    expect(elseEdge?.target_node_id).toBe('log_to_sheet');
    expect(elseEdge?.id).toBe('e-check_amount-p1-log_to_sheet');

    // Layout: computed in code, chain flows left→right, else lane drops a row.
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    expect(byId.get('trigger')!.position).toEqual({ x: LAYOUT.X0, y: LAYOUT.CENTER_Y });
    expect(byId.get('check_amount')!.position.x).toBe(LAYOUT.X0 + LAYOUT.X_PITCH);
    expect(byId.get('notify_slack')!.position.y).toBe(LAYOUT.CENTER_Y);
    expect(byId.get('log_to_sheet')!.position.y).toBe(LAYOUT.CENTER_Y + LAYOUT.Y_PITCH);
    expect(byId.get('notify_slack')!.position.x).toBe(byId.get('check_amount')!.position.x + LAYOUT.X_PITCH);
  });

  it('rejects a node_type outside the catalog allow-list (hallucination guard)', () => {
    expect(() =>
      applyOps(null, ops({ op: 'add_node', node: { id: 'x', node_type: 'slack.made_up_action' } }), ALLOWED),
    ).toThrow(/ops\[0\] add_node "x": unknown action type "slack\.made_up_action"/);
  });

  it('rejects the whole batch atomically on the first invalid op', () => {
    const input = emptyIr();
    expect(() =>
      applyOps(
        input,
        ops(
          { op: 'add_node', node: { id: 'a', node_type: 'http.send_request' } },
          { op: 'connect', source_node_id: 'a', target_node_id: 'ghost' },
        ),
        ALLOWED,
      ),
    ).toThrow(/ops\[1\] connect: no node with id "ghost"/);
    expect(input.nodes).toHaveLength(0); // input document untouched
  });

  it('update_node shallow-merges parameters and renames; unknown id names the survivors', () => {
    const base = applyOps(
      null,
      ops({
        op: 'add_node',
        node: { id: 'a', node_type: 'http.send_request', parameters: { url: 'x', method: 'GET' } },
      }),
      ALLOWED,
    );
    const next = applyOps(
      base,
      ops({ op: 'update_node', node_id: 'a', name: 'Call API', parameters: { url: 'y' } }),
      ALLOWED,
    );
    expect(next.nodes[0]!.name).toBe('Call API');
    expect(next.nodes[0]!.parameters).toEqual({ url: 'y', method: 'GET' });

    expect(() => applyOps(base, ops({ op: 'update_node', node_id: 'nope' }), ALLOWED)).toThrow(
      /existing node ids: a/,
    );
  });

  describe('trigger re-typing (— the canvas is the only place a trigger is set)', () => {
    const TRIGGERS = new Set([
      'orchestr:trigger',
      'orchestr:webhook',
      'orchestr:schedule',
      'gmail.new_email',
    ]);
    const withTrigger = () =>
      applyOps(
        null,
        ops({ op: 'add_node', node: { id: 'trigger', node_type: 'orchestr:trigger' } }),
        ALLOWED,
      );

    /**
     * An app trigger's type looks exactly like an action's, so the `metadata.trigger` marker is
     * the ONLY thing making the compiler + reconciler treat it as a trigger — without it the
     * trigger silently never registers.
     */
    it('stamps the trigger marker when add_node creates an APP trigger', () => {
      const ir = applyOps(
        null,
        ops({ op: 'add_node', node: { id: 'inbox', node_type: 'gmail.new_email' } }),
        new Set([...ALLOWED, 'gmail.new_email']),
        TRIGGERS,
      );
      expect(ir.nodes.find((n) => n.id === 'inbox')?.metadata).toEqual({ trigger: true });
    });

    it('does NOT stamp the marker on a plain action, nor on a native trigger kind', () => {
      const ir = applyOps(
        null,
        ops(
          { op: 'add_node', node: { id: 'post', node_type: 'slack.send_channel_message' } },
          { op: 'add_node', node: { id: 'trigger', node_type: 'orchestr:trigger' } },
        ),
        ALLOWED,
        TRIGGERS,
      );
      expect(ir.nodes.find((n) => n.id === 'post')?.metadata).toEqual({});
      expect(ir.nodes.find((n) => n.id === 'trigger')?.metadata).toEqual({});
    });

    it('re-types the trigger node to the native webhook kind (metadata marker stays clear)', () => {
      const next = applyOps(
        withTrigger(),
        ops({ op: 'update_node', node_id: 'trigger', node_type: 'orchestr:webhook' }),
        ALLOWED,
        TRIGGERS,
      );
      const trig = next.nodes.find((n) => n.id === 'trigger')!;
      expect(trig.node_type).toBe('orchestr:webhook');
      expect(trig.metadata?.trigger).toBeUndefined();
    });

    it('re-types to a schedule kind and takes the new params (old props do not ride along)', () => {
      const base = applyOps(
        null,
        ops({
          op: 'add_node',
          node: { id: 'trigger', node_type: 'orchestr:trigger', parameters: { stale: 1 } },
        }),
        ALLOWED,
      );
      const next = applyOps(
        base,
        ops({
          op: 'update_node',
          node_id: 'trigger',
          node_type: 'orchestr:schedule',
          parameters: { interval_minutes: 15 },
        }),
        ALLOWED,
        TRIGGERS,
      );
      const trig = next.nodes.find((n) => n.id === 'trigger')!;
      expect(trig.node_type).toBe('orchestr:schedule');
      expect(trig.parameters).toEqual({ interval_minutes: 15 });
    });

    it('re-types to an app trigger and sets the metadata.trigger marker', () => {
      const next = applyOps(
        withTrigger(),
        ops({ op: 'update_node', node_id: 'trigger', node_type: 'gmail.new_email' }),
        ALLOWED,
        TRIGGERS,
      );
      const trig = next.nodes.find((n) => n.id === 'trigger')!;
      expect(trig.node_type).toBe('gmail.new_email');
      expect(trig.metadata?.trigger).toBe(true);
    });

    it('rejects re-typing an ACTION node (only the trigger changes type)', () => {
      const base = applyOps(
        null,
        ops({ op: 'add_node', node: { id: 'slack', node_type: 'slack.send_channel_message' } }),
        ALLOWED,
      );
      expect(() =>
        applyOps(
          base,
          ops({ op: 'update_node', node_id: 'slack', node_type: 'orchestr:webhook' }),
          ALLOWED,
          TRIGGERS,
        ),
      ).toThrow(/only the trigger node can change its type/);
    });

    it('rejects an unknown trigger type with a catalog hint', () => {
      expect(() =>
        applyOps(
          withTrigger(),
          ops({ op: 'update_node', node_id: 'trigger', node_type: 'gmail.not_a_trigger' }),
          ALLOWED,
          TRIGGERS,
        ),
      ).toThrow(/is not a known trigger type/);
    });
  });

  describe('disconnect — edge identity is the endpoint TUPLE, never the id (invariant #13)', () => {
    const node = (id: string) => ({
      id,
      name: id,
      node_type: 'http.send_request',
      type_version: 1,
      parameters: {},
      position: { x: 0, y: 0 },
      metadata: {},
    });
    const edge = (over: Partial<IREdge>): IREdge => ({
      id: 'e-a-b',
      source_node_id: 'a',
      source_port: 0,
      target_node_id: 'b',
      target_port: 0,
      port_type: 'main',
      ...over,
    });
    /**
     * The exact hazard: a document written by the canvas gives a main and an error edge between the
     * SAME pair the SAME id, so removing by id would take both lanes out.
     */
    const sharedId = (): WorkflowIR => ({
      ...emptyIr('Shared ids'),
      nodes: [node('a'), node('b')],
      edges: [edge({}), edge({ port_type: 'error' })],
    });

    it('removes ONLY the named lane, leaving the same-id edge on the other lane', () => {
      const next = applyOps(
        sharedId(),
        ops({ op: 'disconnect', source_node_id: 'a', target_node_id: 'b' }),
        ALLOWED,
      );
      expect(next.edges).toHaveLength(1);
      expect(next.edges[0]).toMatchObject({ id: 'e-a-b', port_type: 'error' });
    });

    it('removes the ERROR lane when asked, leaving the main edge that shares its id', () => {
      const next = applyOps(
        sharedId(),
        ops({ op: 'disconnect', source_node_id: 'a', target_node_id: 'b', port_type: 'error' }),
        ALLOWED,
      );
      expect(next.edges.map((e) => e.port_type)).toEqual(['main']);
    });

    it("distinguishes an IF's then and else lanes by source_port", () => {
      const base: WorkflowIR = {
        ...emptyIr('Ports'),
        nodes: [node('a'), node('b')],
        edges: [edge({}), edge({ id: 'e-a-p1-b', source_port: 1 })],
      };
      const next = applyOps(
        base,
        ops({ op: 'disconnect', source_node_id: 'a', target_node_id: 'b', source_port: 1 }),
        ALLOWED,
      );
      expect(next.edges.map((e) => e.source_port)).toEqual([0]);
    });

    it('rewires without churning node identity: disconnect + connect keeps the node and its params', () => {
      const base = applyOps(
        null,
        ops(
          { op: 'add_node', node: { id: 'a', node_type: 'http.send_request' } },
          { op: 'add_node', node: { id: 'b', node_type: 'http.send_request', parameters: { url: 'keep' } } },
          { op: 'add_node', node: { id: 'c', node_type: 'http.send_request' } },
          { op: 'connect', source_node_id: 'a', target_node_id: 'b' },
        ),
        ALLOWED,
      );
      const next = applyOps(
        base,
        ops(
          { op: 'disconnect', source_node_id: 'a', target_node_id: 'b' },
          { op: 'connect', source_node_id: 'a', target_node_id: 'c' },
          { op: 'connect', source_node_id: 'c', target_node_id: 'b' },
        ),
        ALLOWED,
      );
      expect(next.nodes.find((n) => n.id === 'b')?.parameters).toEqual({ url: 'keep' });
      expect(next.edges.map((e) => `${e.source_node_id}->${e.target_node_id}`)).toEqual(['a->c', 'c->b']);
    });

    it('refuses a miss and lists the edges that DO exist, so the agent can name the right lane', () => {
      expect(() =>
        applyOps(
          sharedId(),
          ops({ op: 'disconnect', source_node_id: 'a', target_node_id: 'b', port_type: 'tool' }),
          ALLOWED,
        ),
      ).toThrow(
        /ops\[0\] disconnect: no edge matching tool "a"\[0\] → "b"\[0\].*Existing edges: main "a"\[0\] → "b"\[0\], error "a"\[0\] → "b"\[0\]/s,
      );
    });
  });

  describe('unset_parameters — the inverse of update_node.parameters', () => {
    const withParams = () =>
      applyOps(
        null,
        ops({
          op: 'add_node',
          node: { id: 'a', node_type: 'http.send_request', parameters: { url: 'x', method: 'GET' } },
        }),
        ALLOWED,
      );

    it('removes exactly the named keys and leaves the rest', () => {
      const next = applyOps(
        withParams(),
        ops({ op: 'unset_parameters', node_id: 'a', keys: ['url'] }),
        ALLOWED,
      );
      expect(next.nodes[0]!.parameters).toEqual({ method: 'GET' });
    });

    it('reports an already-absent key instead of failing the batch', () => {
      const { applied } = applyOpsDetailed(
        withParams(),
        ops({ op: 'unset_parameters', node_id: 'a', keys: ['url', 'nope'] }),
        ALLOWED,
      );
      expect(applied[0]).toBe('cleared parameters on "a": url; already unset: nope');
    });

    it('names the survivors when the node does not exist', () => {
      expect(() =>
        applyOps(withParams(), ops({ op: 'unset_parameters', node_id: 'ghost', keys: ['url'] }), ALLOWED),
      ).toThrow(/ops\[0\] unset_parameters: no node with id "ghost" — existing node ids: a/);
    });
  });

  describe('set_meta — names the DOCUMENT, not the workflow row', () => {
    it('sets name and description, and says the workflow itself is untouched', () => {
      const { ir, applied } = applyOpsDetailed(
        emptyIr('Old'),
        ops({ op: 'set_meta', name: '  Expense triage  ', description: 'Routes big expenses' }),
        ALLOWED,
      );
      expect(ir.name).toBe('Expense triage');
      expect(ir.description).toBe('Routes big expenses');
      expect(applied[0]).toMatch(/NOT the workflow itself/);
    });

    it('refuses a blank name rather than minting an unnamed document', () => {
      expect(() => applyOps(emptyIr(), ops({ op: 'set_meta', name: '   ' }), ALLOWED)).toThrow(
        /ops\[0\] set_meta: name must not be blank/,
      );
    });
  });

  it('applyOpsDetailed returns one line per op, in op order', () => {
    const { applied } = applyOpsDetailed(
      null,
      ops(
        { op: 'add_node', node: { id: 'a', node_type: 'http.send_request' } },
        { op: 'add_node', node: { id: 'b', node_type: 'http.send_request' } },
        { op: 'connect', source_node_id: 'a', target_node_id: 'b' },
        { op: 'remove_node', node_id: 'b' },
      ),
      ALLOWED,
    );
    expect(applied).toEqual([
      'added node "a" (http.send_request)',
      'added node "b" (http.send_request)',
      'connected main "a"[0] → "b"[0]',
      'removed node "b" and 1 edge(s) touching it',
    ]);
  });

  it('lays out a node that arrived without coordinates (a document lifted from a read projection)', () => {
    const partial = {
      ...emptyIr('Lifted'),
      nodes: [
        {
          id: 'trigger',
          name: 'Trigger',
          node_type: 'orchestr:trigger',
          type_version: 1,
          parameters: {},
          metadata: {},
        },
      ],
      edges: [],
    } as unknown as WorkflowIR;
    const next = applyOps(
      partial,
      ops(
        { op: 'add_node', node: { id: 'step', node_type: 'http.send_request' } },
        { op: 'connect', source_node_id: 'trigger', target_node_id: 'step' },
      ),
      ALLOWED,
    );
    const byId = new Map(next.nodes.map((n) => [n.id, n]));
    expect(byId.get('trigger')!.position).toEqual({ x: LAYOUT.X0, y: LAYOUT.CENTER_Y });
    expect(byId.get('step')!.position).toEqual({ x: LAYOUT.X0 + LAYOUT.X_PITCH, y: LAYOUT.CENTER_Y });
  });

  it('remove_node drops the node and every touching edge', () => {
    const base = applyOps(
      null,
      ops(
        { op: 'add_node', node: { id: 'a', node_type: 'http.send_request' } },
        { op: 'add_node', node: { id: 'b', node_type: 'http.send_request' } },
        { op: 'connect', source_node_id: 'a', target_node_id: 'b' },
      ),
      ALLOWED,
    );
    const next = applyOps(base, ops({ op: 'remove_node', node_id: 'b' }), ALLOWED);
    expect(next.nodes.map((n) => n.id)).toEqual(['a']);
    expect(next.edges).toHaveLength(0);
  });

  describe('tool edges (invariant #14) — the agent tools handle', () => {
    // An allow-list with an agent, a control node, and action targets to bind.
    const AGENT_ALLOWED = new Set([
      'orchestr:trigger',
      'orchestr:agent',
      'orchestr:loop',
      'slack.send_channel_message',
      'http.send_request',
    ]);

    const withAgentAnd = (...adds: ComposeOp[]) =>
      applyOps(
        null,
        ops(
          { op: 'add_node', node: { id: 'agent', node_type: 'orchestr:agent' } },
          { op: 'add_node', node: { id: 'notify', node_type: 'slack.send_channel_message' } },
          ...adds,
        ),
        AGENT_ALLOWED,
      );

    it('binds an action to the agent as a tool via a port_type:"tool" edge (distinct id + lane)', () => {
      const ir = withAgentAnd({
        op: 'connect',
        source_node_id: 'agent',
        target_node_id: 'notify',
        port_type: 'tool',
      });
      expect(ir.edges).toHaveLength(1);
      const edge = ir.edges[0]!;
      expect(edge.port_type).toBe('tool');
      expect(edge.source_port).toBe(0);
      expect(edge.id).toBe('e-agent-tool-notify'); // lane-tagged id — never collides with a main edge
    });

    it('a tool edge and a main edge between the same pair coexist (distinct lanes)', () => {
      const ir = withAgentAnd(
        { op: 'connect', source_node_id: 'agent', target_node_id: 'notify', port_type: 'tool' },
        { op: 'connect', source_node_id: 'agent', target_node_id: 'notify' },
      );
      expect(ir.edges.map((e) => e.port_type).sort()).toEqual(['main', 'tool']);
    });

    it('the tool edge is idempotent per (source, target, lane)', () => {
      const ir = withAgentAnd(
        { op: 'connect', source_node_id: 'agent', target_node_id: 'notify', port_type: 'tool' },
        { op: 'connect', source_node_id: 'agent', target_node_id: 'notify', port_type: 'tool' },
      );
      expect(ir.edges).toHaveLength(1);
    });

    it('binds an orchestr:call_workflow (sub-workflow) to the agent as a tool (feature A)', () => {
      // A sub-workflow is a first-class agent tool, so isToolEligibleTarget
      // must accept call_workflow.
      const ir = applyOps(
        null,
        ops(
          { op: 'add_node', node: { id: 'agent', node_type: 'orchestr:agent' } },
          {
            op: 'add_node',
            node: { id: 'sub', node_type: 'orchestr:call_workflow', parameters: { workflow_id: 'wf-abc' } },
          },
          { op: 'connect', source_node_id: 'agent', target_node_id: 'sub', port_type: 'tool' },
        ),
        new Set([...AGENT_ALLOWED, 'orchestr:call_workflow']),
      );
      const edge = ir.edges.find((e) => e.port_type === 'tool')!;
      expect(edge.target_node_id).toBe('sub');
      expect(edge.id).toBe('e-agent-tool-sub');
    });

    it('REJECTS a tool edge onto a trigger (not an action the agent can call)', () => {
      expect(() =>
        applyOps(
          null,
          ops(
            { op: 'add_node', node: { id: 'trigger', node_type: 'orchestr:trigger' } },
            { op: 'add_node', node: { id: 'agent', node_type: 'orchestr:agent' } },
            { op: 'connect', source_node_id: 'agent', target_node_id: 'trigger', port_type: 'tool' },
          ),
          AGENT_ALLOWED,
        ),
      ).toThrow(/tool edge's target must be an action.*isn't tool-eligible/);
    });

    it('REJECTS a tool edge onto a control/logic node (loop)', () => {
      expect(() =>
        applyOps(
          null,
          ops(
            { op: 'add_node', node: { id: 'agent', node_type: 'orchestr:agent' } },
            { op: 'add_node', node: { id: 'lp', node_type: 'orchestr:loop' } },
            { op: 'connect', source_node_id: 'agent', target_node_id: 'lp', port_type: 'tool' },
          ),
          AGENT_ALLOWED,
        ),
      ).toThrow(/tool edge's target must be an action/);
    });

    it("REJECTS a tool edge onto another agent (an agent can't be another agent's tool)", () => {
      expect(() =>
        applyOps(
          null,
          ops(
            { op: 'add_node', node: { id: 'agent', node_type: 'orchestr:agent' } },
            { op: 'add_node', node: { id: 'agent2', node_type: 'orchestr:agent' } },
            { op: 'connect', source_node_id: 'agent', target_node_id: 'agent2', port_type: 'tool' },
          ),
          AGENT_ALLOWED,
        ),
      ).toThrow(/tool edge's target must be an action/);
    });

    // Tool-eligibility keys off the EXACT orchestr:* control type, never a substring: an app
    // action merely CONTAINING "if"/"set"/"merge"/"code" is still an action the agent can call.
    const bindsAsTool = (targetType: string) =>
      applyOps(
        null,
        ops(
          { op: 'add_node', node: { id: 'agent', node_type: 'orchestr:agent' } },
          { op: 'add_node', node: { id: 'tgt', node_type: targetType } },
          { op: 'connect', source_node_id: 'agent', target_node_id: 'tgt', port_type: 'tool' },
        ),
        new Set(['orchestr:agent', targetType]),
      ).edges.find((e) => e.port_type === 'tool');

    it.each([
      'shopify.create_product', // contains "if" (shopIFy) — was wrongly "logic"
      'spotify.start_playback', // contains "if" (spotIFy) — was wrongly "logic"
      'slack.set_topic', // contains "set" — was wrongly "transform"
      'github.merge_pull_request', // contains "merge" — was wrongly "logic"
    ])('binds app action %s as a tool (exact-match category, not substring)', (type) => {
      const edge = bindsAsTool(type);
      expect(edge?.target_node_id).toBe('tgt');
      expect(edge?.id).toBe('e-agent-tool-tgt');
    });

    it.each(['orchestr:if', 'orchestr:switch', 'orchestr:loop', 'orchestr:code'])(
      'still REJECTS the genuine control type %s as a tool target',
      (type) => {
        expect(() =>
          applyOps(
            null,
            ops(
              { op: 'add_node', node: { id: 'agent', node_type: 'orchestr:agent' } },
              { op: 'add_node', node: { id: 'ctl', node_type: type } },
              { op: 'connect', source_node_id: 'agent', target_node_id: 'ctl', port_type: 'tool' },
            ),
            new Set(['orchestr:agent', type]),
          ),
        ).toThrow(/tool edge's target must be an action/);
      },
    );

    it('REJECTS a non-zero source_port on a tool edge (a single handle)', () => {
      expect(() =>
        withAgentAnd({
          op: 'connect',
          source_node_id: 'agent',
          target_node_id: 'notify',
          port_type: 'tool',
          source_port: 1,
        }),
      ).toThrow(/a tool edge leaves a single handle/);
    });

    it('an error edge carries the error lane in its id', () => {
      const ir = withAgentAnd({
        op: 'connect',
        source_node_id: 'notify',
        target_node_id: 'agent',
        port_type: 'error',
      });
      const edge = ir.edges.find((e) => e.port_type === 'error')!;
      expect(edge.id).toBe('e-notify-err-agent');
      expect(edge.source_port).toBe(0);
    });
  });

  it('connect is idempotent and validates the port range', () => {
    const base = applyOps(
      null,
      ops(
        { op: 'add_node', node: { id: 'a', node_type: 'http.send_request' } },
        { op: 'add_node', node: { id: 'b', node_type: 'http.send_request' } },
        { op: 'connect', source_node_id: 'a', target_node_id: 'b' },
        { op: 'connect', source_node_id: 'a', target_node_id: 'b' },
      ),
      ALLOWED,
    );
    expect(base.edges).toHaveLength(1);
    expect(() =>
      applyOps(
        base,
        ops({ op: 'connect', source_node_id: 'a', target_node_id: 'b', source_port: 3 }),
        ALLOWED,
      ),
    ).toThrow(/source_port must be 0 .* or 1/);
  });

  it('refuses duplicate node ids and a second trigger', () => {
    const base = applyOps(
      null,
      ops({ op: 'add_node', node: { id: 'trigger', node_type: 'orchestr:trigger' } }),
      ALLOWED,
    );
    expect(() =>
      applyOps(
        base,
        ops({ op: 'add_node', node: { id: 'trigger', node_type: 'http.send_request' } }),
        ALLOWED,
      ),
    ).toThrow(/already exists/);
    expect(() =>
      applyOps(base, ops({ op: 'add_node', node: { id: 't2', node_type: 'orchestr:trigger' } }), ALLOWED),
    ).toThrow(/already has a trigger node/);
  });

  it('pre-existing nodes keep their positions; new nodes land downstream of their anchor', () => {
    const existing: WorkflowIR = {
      ...emptyIr('Existing'),
      nodes: [
        {
          id: 'trigger',
          name: 'Trigger',
          node_type: 'orchestr:trigger',
          type_version: 1,
          parameters: {},
          position: { x: 42, y: 777 }, // user-dragged — must survive
          metadata: {},
        },
      ],
    };
    const next = applyOps(
      existing,
      ops(
        { op: 'add_node', node: { id: 'step', node_type: 'http.send_request' } },
        { op: 'connect', source_node_id: 'trigger', target_node_id: 'step' },
      ),
      ALLOWED,
    );
    const byId = new Map(next.nodes.map((n) => [n.id, n]));
    expect(byId.get('trigger')!.position).toEqual({ x: 42, y: 777 });
    expect(byId.get('step')!.position).toEqual({ x: 42 + LAYOUT.X_PITCH, y: 777 });
  });

  it('collision on a layout slot bumps the new node down a lane', () => {
    const base = applyOps(
      null,
      ops(
        { op: 'add_node', node: { id: 'a', node_type: 'http.send_request' } },
        { op: 'add_node', node: { id: 'b', node_type: 'http.send_request' } },
        { op: 'connect', source_node_id: 'a', target_node_id: 'b' },
      ),
      ALLOWED,
    );
    const next = applyOps(
      base,
      ops(
        { op: 'add_node', node: { id: 'c', node_type: 'http.send_request' } },
        { op: 'connect', source_node_id: 'a', target_node_id: 'c' },
      ),
      ALLOWED,
    );
    const byId = new Map(next.nodes.map((n) => [n.id, n]));
    expect(byId.get('c')!.position.x).toBe(byId.get('b')!.position.x);
    expect(byId.get('c')!.position.y).toBe(byId.get('b')!.position.y + LAYOUT.Y_PITCH);
  });
});

describe('parseOp', () => {
  it('parses every op kind', () => {
    expect(parseOp({ op: 'add_node', node: { id: 'a', node_type: 'x.y' } }, 0)).toEqual({
      op: 'add_node',
      node: { id: 'a', node_type: 'x.y' },
    });
    expect(parseOp({ op: 'connect', source_node_id: 'a', target_node_id: 'b', source_port: 1 }, 0)).toEqual({
      op: 'connect',
      source_node_id: 'a',
      target_node_id: 'b',
      source_port: 1,
    });
    expect(
      parseOp({ op: 'connect', source_node_id: 'a', target_node_id: 'b', port_type: 'tool' }, 0),
    ).toEqual({ op: 'connect', source_node_id: 'a', target_node_id: 'b', port_type: 'tool' });
    expect(parseOp({ op: 'remove_node', node_id: 'a' }, 0)).toEqual({ op: 'remove_node', node_id: 'a' });
  });

  it('parses the rewire/clear/rename ops', () => {
    expect(
      parseOp(
        { op: 'disconnect', source_node_id: 'a', target_node_id: 'b', port_type: 'error', target_port: 1 },
        0,
      ),
    ).toEqual({
      op: 'disconnect',
      source_node_id: 'a',
      target_node_id: 'b',
      port_type: 'error',
      target_port: 1,
    });
    expect(parseOp({ op: 'unset_parameters', node_id: 'a', keys: ['url'] }, 0)).toEqual({
      op: 'unset_parameters',
      node_id: 'a',
      keys: ['url'],
    });
    expect(parseOp({ op: 'set_meta', name: 'Flow' }, 0)).toEqual({ op: 'set_meta', name: 'Flow' });
  });

  it('rejects an unknown port_type on either edge op', () => {
    expect(() =>
      parseOp({ op: 'connect', source_node_id: 'a', target_node_id: 'b', port_type: 'sideways' }, 3),
    ).toThrow(/ops\[3\] connect: port_type must be one of "main", "tool", or "error"/);
    expect(() =>
      parseOp({ op: 'disconnect', source_node_id: 'a', target_node_id: 'b', port_type: 'sideways' }, 3),
    ).toThrow(/ops\[3\] disconnect: port_type must be one of "main", "tool", or "error"/);
  });

  it('rejects malformed rewire/clear/rename ops by field', () => {
    expect(() => parseOp({ op: 'disconnect', target_node_id: 'b' }, 1)).toThrow(
      /ops\[1\] disconnect: source_node_id/,
    );
    expect(() => parseOp({ op: 'unset_parameters', node_id: 'a', keys: [] }, 2)).toThrow(
      /ops\[2\] unset_parameters: keys must be a non-empty array/,
    );
    expect(() => parseOp({ op: 'unset_parameters', node_id: 'a', keys: ['ok', 7] }, 2)).toThrow(
      /ops\[2\] unset_parameters: every entry in keys/,
    );
    expect(() => parseOp({ op: 'set_meta' }, 4)).toThrow(/ops\[4\] set_meta: pass name and\/or description/);
  });

  it('rejects malformed ops with op-indexed, field-naming messages', () => {
    expect(() => parseOp({ op: 'add_node' }, 2)).toThrow(/ops\[2\] add_node: missing "node" object/);
    expect(() => parseOp({ op: 'teleport' }, 0)).toThrow(/unknown op "teleport"/);
    expect(() => parseOp({ op: 'connect', source_node_id: 'a' }, 1)).toThrow(
      /ops\[1\] connect: target_node_id/,
    );
    expect(() => parseOp('nope', 0)).toThrow(ApplyOpsError);
  });
});
