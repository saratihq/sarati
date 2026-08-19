import { emptySettings, type IREdge, type IRNode, type WorkflowIR } from '../ir/models';
import type { DagAgentActionTool } from '../runtime/agent';
import type {
  DagActionNode,
  DagAgentNode,
  DagForEachNode,
  DagIfNode,
  DagPlan,
  DagSwitchNode,
  DagWhileNode,
} from '../runtime/dag-plan';
import { compileWorkflowIrDag } from './compile-ir-dag';

// A native public action compiles directly, keeping the fixtures about topology.
const ACTION = 'text.concat';

function act(id: string): IRNode {
  return {
    id,
    name: id,
    node_type: ACTION,
    type_version: 1,
    parameters: {},
    position: { x: 0, y: 0 },
    metadata: {},
  };
}
function ifNode(id: string, op = 'truthy', extra: Record<string, unknown> = {}): IRNode {
  return { ...act(id), node_type: 'orchestr:if', parameters: { left: `{{trigger.${id}}}`, op, ...extra } };
}
function edge(source: string, target: string, sourcePort = 0): IREdge {
  return {
    id: `${source}->${target}:${sourcePort}`,
    source_node_id: source,
    source_port: sourcePort,
    target_node_id: target,
    target_port: 0,
    port_type: 'main',
  };
}
function errEdge(source: string, target: string): IREdge {
  return { ...edge(source, target), id: `${source}=err=>${target}`, port_type: 'error' };
}
function loopNode(id: string, params: Record<string, unknown> = {}): IRNode {
  return { ...act(id), node_type: 'orchestr:loop', parameters: { items: '{{seed.rows}}', ...params } };
}
function switchNode(id: string, cases: Array<Record<string, unknown>>): IRNode {
  return { ...act(id), node_type: 'orchestr:switch', parameters: { cases } };
}
function ir(nodes: IRNode[], edges: IREdge[]): WorkflowIR {
  return { version: '1', name: 'wf', description: '', nodes, edges, settings: emptySettings(), metadata: {} };
}

/** Every guard's source must be present and appear at an earlier index (topo validity). */
function assertGuardsPrecede(plan: DagPlan): void {
  const index = new Map(plan.nodes.map((n, i) => [n.id, i]));
  for (const node of plan.nodes) {
    for (const g of node.guards) {
      expect(index.has(g.source)).toBe(true);
      expect(index.get(g.source)!).toBeLessThan(index.get(node.id)!);
    }
  }
}
const byId = (plan: DagPlan, id: string): DagActionNode =>
  plan.nodes.find((n) => n.id === id) as DagActionNode;

describe('compileWorkflowIrDag (flat-DAG compiler, slice 1)', () => {
  it('flattens a linear chain into guarded nodes in dependency order', () => {
    const plan = compileWorkflowIrDag(ir([act('c'), act('a'), act('b')], [edge('a', 'b'), edge('b', 'c')]));
    expect(plan.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(byId(plan, 'a').guards).toEqual([]);
    expect(byId(plan, 'b').guards).toEqual([{ source: 'a', port: 0 }]);
    expect(byId(plan, 'c').guards).toEqual([{ source: 'b', port: 0 }]);
    assertGuardsPrecede(plan);
  });

  it('encodes IF then/else as guards on port 0 / port 1', () => {
    const plan = compileWorkflowIrDag(
      ir(
        [ifNode('check', 'lt', { left: '{{trigger.amount}}', right: 100 }), act('auto'), act('manual')],
        [edge('check', 'auto'), edge('check', 'manual', 1)],
      ),
    );
    const check = byId(plan, 'check') as unknown as DagIfNode;
    expect(check.kind).toBe('if');
    expect(check.condition).toEqual({ left: '{{trigger.amount}}', op: 'lt', right: 100 });
    // then → port 0 (live only if the condition held); else → port 1.
    expect(byId(plan, 'auto').guards).toEqual([{ source: 'check', port: 0 }]);
    expect(byId(plan, 'manual').guards).toEqual([{ source: 'check', port: 1 }]);
    assertGuardsPrecede(plan);
  });

  it('fans out: one source becomes a guard on each of its targets', () => {
    const plan = compileWorkflowIrDag(ir([act('a'), act('x'), act('y')], [edge('a', 'x'), edge('a', 'y')]));
    expect(byId(plan, 'x').guards).toEqual([{ source: 'a', port: 0 }]);
    expect(byId(plan, 'y').guards).toEqual([{ source: 'a', port: 0 }]);
    assertGuardsPrecede(plan);
  });

  it('fans in a diamond: the join appears ONCE with a guard per inflow', () => {
    // split → m1, split → m2, m1 → join, m2 → join
    const plan = compileWorkflowIrDag(
      ir(
        [act('split'), act('m1'), act('m2'), act('join')],
        [edge('split', 'm1'), edge('split', 'm2'), edge('m1', 'join'), edge('m2', 'join')],
      ),
    );
    expect(plan.nodes.filter((n) => n.id === 'join')).toHaveLength(1);
    expect(byId(plan, 'join').guards).toEqual([
      { source: 'm1', port: 0 },
      { source: 'm2', port: 0 },
    ]);
    assertGuardsPrecede(plan);
  });

  it('fans in a plain reconvergence alongside an IF: the join appears ONCE with both inflows', () => {
    // a → x, a → y (plain fan-out), x → j, y → j (reconverge), j → check(if): the join
    // must appear ONCE, carrying both inflows.
    const workflow = ir(
      [act('a'), act('x'), act('y'), act('j'), ifNode('check')],
      [edge('a', 'x'), edge('a', 'y'), edge('x', 'j'), edge('y', 'j'), edge('j', 'check')],
    );
    const plan = compileWorkflowIrDag(workflow);
    expect(plan.nodes.filter((n) => n.id === 'j')).toHaveLength(1);
    expect(byId(plan, 'j').guards).toEqual([
      { source: 'x', port: 0 },
      { source: 'y', port: 0 },
    ]);
    expect(byId(plan, 'check').guards).toEqual([{ source: 'j', port: 0 }]);
    assertGuardsPrecede(plan);
  });

  it('peels an error output into a nested sub-DagPlan (the recursion)', () => {
    // main → after (main flow) ; main → handler (error output)
    const plan = compileWorkflowIrDag(
      ir([act('main'), act('after'), act('handler')], [edge('main', 'after'), errEdge('main', 'handler')]),
    );
    // The error lane is peeled OUT of the main flow…
    expect(plan.nodes.map((n) => n.id)).toEqual(['main', 'after']);
    expect(byId(plan, 'after').guards).toEqual([{ source: 'main', port: 0 }]);
    // …and attached as a nested sub-plan (recursively compiled, its own roots ungated).
    const lane = byId(plan, 'main').onErrorBranch;
    expect(lane?.id).toBe('wf#main:error');
    expect(lane?.nodes.map((n) => n.id)).toEqual(['handler']);
    expect(lane?.nodes[0]?.guards).toEqual([]);
  });

  it('is deterministic: the same IR yields the same node order and guards', () => {
    const build = (): DagPlan =>
      compileWorkflowIrDag(
        ir(
          [act('split'), act('m1'), act('m2'), act('join')],
          [edge('split', 'm1'), edge('split', 'm2'), edge('m1', 'join'), edge('m2', 'join')],
        ),
      );
    expect(build()).toEqual(build());
    // Tie-break is IR node order: ready peers emit in the order they appear in `nodes`.
    expect(build().nodes.map((n) => n.id)).toEqual(['split', 'm1', 'm2', 'join']);
  });

  it('still rejects a genuine cycle (a loop is a structured node, not a back-edge)', () => {
    expect(() => compileWorkflowIrDag(ir([act('a'), act('b')], [edge('a', 'b'), edge('b', 'a')]))).toThrow(
      /cycle/i,
    );
  });
});

describe('compileWorkflowIrDag — Loop-Over-Items (slice 6)', () => {
  const forEachById = (plan: DagPlan, id: string): DagForEachNode =>
    plan.nodes.find((n) => n.id === id) as unknown as DagForEachNode;

  it('lowers orchestr:loop to a forEach node, peels the body (port 0), keeps the after step (port 1)', () => {
    // seed → loop ; loop --body(0)--> work ; loop --after(1)--> done
    const plan = compileWorkflowIrDag(
      ir(
        [
          act('seed'),
          loopNode('loop', { items: '{{seed.rows}}', item_var: 'row' }),
          act('work'),
          act('done'),
        ],
        [edge('seed', 'loop'), edge('loop', 'work', 0), edge('loop', 'done', 1)],
      ),
    );
    // The loop node is a forEach in the MAIN flow; the body node is peeled OUT.
    expect(plan.nodes.map((n) => n.id)).toEqual(['seed', 'loop', 'done']);
    const loop = forEachById(plan, 'loop');
    expect(loop.kind).toBe('forEach');
    expect(loop.items).toBe('{{seed.rows}}');
    expect(loop.itemVar).toBe('row');
    expect(loop.guards).toEqual([{ source: 'seed', port: 0 }]);
    // Body is a nested sub-plan; its root (work) is ungated (the loop→body edge is peeled).
    expect(loop.body.nodes.map((n) => n.id)).toEqual(['work']);
    expect(loop.body.nodes[0]?.guards).toEqual([]);
    // The after step stays in the main flow, guarded on the loop's own output (port 1).
    expect(byId(plan, 'done').guards).toEqual([{ source: 'loop', port: 1 }]);
    assertGuardsPrecede(plan);
  });

  it('defaults item_var to "item" and carries a multi-node body sub-graph', () => {
    // loop --body--> b1 → b2 (a two-step body chain)
    const plan = compileWorkflowIrDag(
      ir(
        [loopNode('loop', { items: '{{seed.rows}}' }), act('b1'), act('b2')],
        [edge('loop', 'b1', 0), edge('b1', 'b2')],
      ),
    );
    const loop = forEachById(plan, 'loop');
    expect(loop.itemVar).toBe('item');
    expect(loop.body.nodes.map((n) => n.id)).toEqual(['b1', 'b2']);
    expect(loop.body.nodes.find((n) => n.id === 'b2')?.guards).toEqual([{ source: 'b1', port: 0 }]);
  });

  it('nests a loop inside a loop body (recursive peeling)', () => {
    // outer --body--> inner ; inner --body--> leaf
    const plan = compileWorkflowIrDag(
      ir(
        [
          loopNode('outer', { items: '{{seed.rows}}' }),
          loopNode('inner', { items: '{{item.cols}}' }),
          act('leaf'),
        ],
        [edge('outer', 'inner', 0), edge('inner', 'leaf', 0)],
      ),
    );
    const outer = forEachById(plan, 'outer');
    expect(outer.body.nodes.map((n) => n.id)).toEqual(['inner']);
    const inner = outer.body.nodes.find((n) => n.id === 'inner') as unknown as DagForEachNode;
    expect(inner.kind).toBe('forEach');
    expect(inner.items).toBe('{{item.cols}}');
    expect(inner.body.nodes.map((n) => n.id)).toEqual(['leaf']);
  });

  it('peels an error output INSIDE a forEach body (recursive peel; shared with while)', () => {
    // loop --body(0)--> boom ; boom --error--> recover : the error lane lives inside the body,
    // and the body node set must follow the error edge to pull `recover` into boom's error lane.
    const plan = compileWorkflowIrDag(
      ir(
        [loopNode('loop', { items: '{{seed.rows}}' }), act('boom'), act('recover')],
        [edge('loop', 'boom', 0), errEdge('boom', 'recover')],
      ),
    );
    // recover must NOT leak into the top-level plan.
    expect(plan.nodes.map((n) => n.id)).toEqual(['loop']);
    const loop = forEachById(plan, 'loop');
    expect(loop.body.nodes.map((n) => n.id)).toEqual(['boom']); // recover peeled into boom's error lane
    const boom = loop.body.nodes.find((n) => n.id === 'boom') as DagActionNode;
    expect(boom.onErrorBranch?.nodes.map((n) => n.id)).toEqual(['recover']);
  });

  it('rejects a loop whose body reconverges into the main flow', () => {
    // loop --body--> work → done, and loop --after--> done : `done` is in BOTH the
    // main flow (via after) and reachable from the body → the body merges back in.
    expect(() =>
      compileWorkflowIrDag(
        ir(
          [loopNode('loop'), act('work'), act('done')],
          [edge('loop', 'work', 0), edge('work', 'done'), edge('loop', 'done', 1)],
        ),
      ),
    ).toThrow(/main flow/i);
  });

  it('rejects a loop with no "items" expression', () => {
    expect(() =>
      compileWorkflowIrDag(ir([loopNode('loop', { items: '' }), act('work')], [edge('loop', 'work', 0)])),
    ).toThrow(/items/i);
  });

  it('lowers an explicit mode:"items" loop to a forEach (the default is unchanged)', () => {
    const plan = compileWorkflowIrDag(
      ir(
        [loopNode('loop', { items: '{{seed.rows}}', mode: 'items' }), act('work')],
        [edge('loop', 'work', 0)],
      ),
    );
    expect((plan.nodes.find((n) => n.id === 'loop') as unknown as DagForEachNode).kind).toBe('forEach');
  });

  it('rejects an unknown loop mode', () => {
    expect(() =>
      compileWorkflowIrDag(
        ir([loopNode('loop', { mode: 'sideways' }), act('work')], [edge('loop', 'work', 0)]),
      ),
    ).toThrow(/unknown mode "sideways"/i);
  });
});

describe('compileWorkflowIrDag — Loop while-mode', () => {
  const whileById = (plan: DagPlan, id: string): DagWhileNode =>
    plan.nodes.find((n) => n.id === id) as unknown as DagWhileNode;
  // A while loop shares the loop node; supply the while params (items is ignored in while mode).
  const whileLoop = (id: string, params: Record<string, unknown> = {}): IRNode =>
    loopNode(id, {
      mode: 'while',
      condition: { left: '{{loopRound}}', op: 'lt', right: 3 },
      max_iterations: 5,
      ...params,
    });

  it('lowers a while loop to a DagWhileNode: condition + maxIterations + a peeled body, after on port 1', () => {
    // seed → loop ; loop --body(0)--> work ; loop --after(1)--> done
    const plan = compileWorkflowIrDag(
      ir(
        [act('seed'), whileLoop('loop'), act('work'), act('done')],
        [edge('seed', 'loop'), edge('loop', 'work', 0), edge('loop', 'done', 1)],
      ),
    );
    // The loop is a `while` step in the MAIN flow; the body is peeled OUT (port 0).
    expect(plan.nodes.map((n) => n.id)).toEqual(['seed', 'loop', 'done']);
    const loop = whileById(plan, 'loop');
    expect(loop.kind).toBe('while');
    expect(loop.condition).toEqual({ left: '{{loopRound}}', op: 'lt', right: 3 });
    expect(loop.maxIterations).toBe(5);
    expect(loop.guards).toEqual([{ source: 'seed', port: 0 }]);
    // Body is a nested sub-plan; its root (work) is ungated — IDENTICAL peel to forEach.
    expect(loop.body.nodes.map((n) => n.id)).toEqual(['work']);
    expect(loop.body.nodes[0]?.guards).toEqual([]);
    // The after step stays in the main flow, guarded on the loop's own output (port 1).
    expect(byId(plan, 'done').guards).toEqual([{ source: 'loop', port: 1 }]);
    assertGuardsPrecede(plan);
  });

  it('translates a condition that references a prior step (like IF/Switch)', () => {
    // seed → loop(while) ; the condition's left is a {{seed.field}} ref, translated like an IF operand.
    const plan = compileWorkflowIrDag(
      ir(
        [
          act('seed'),
          whileLoop('loop', { condition: { left: '{{seed.status}}', op: 'ne', right: 'done' } }),
          act('work'),
        ],
        [edge('seed', 'loop'), edge('loop', 'work', 0)],
      ),
    );
    expect(whileById(plan, 'loop').condition).toEqual({ left: '{{seed.status}}', op: 'ne', right: 'done' });
  });

  it('nests a while loop inside a loop body (recursive peel through the outer loop)', () => {
    // outer(items) --body--> inner(while) ; inner --body--> leaf
    const plan = compileWorkflowIrDag(
      ir(
        [loopNode('outer', { items: '{{seed.rows}}' }), whileLoop('inner'), act('leaf')],
        [edge('outer', 'inner', 0), edge('inner', 'leaf', 0)],
      ),
    );
    const outer = plan.nodes.find((n) => n.id === 'outer') as unknown as DagForEachNode;
    expect(outer.body.nodes.map((n) => n.id)).toEqual(['inner']);
    const inner = outer.body.nodes.find((n) => n.id === 'inner') as unknown as DagWhileNode;
    expect(inner.kind).toBe('while');
    expect(inner.body.nodes.map((n) => n.id)).toEqual(['leaf']);
  });

  it('peels an error output INSIDE a while body (recursive peel through the while)', () => {
    // loop --body(0)--> boom ; boom --error--> recover (the error lane lives inside the body)
    const plan = compileWorkflowIrDag(
      ir(
        [whileLoop('loop'), act('boom'), act('recover')],
        [edge('loop', 'boom', 0), errEdge('boom', 'recover')],
      ),
    );
    const loop = whileById(plan, 'loop');
    expect(loop.body.nodes.map((n) => n.id)).toEqual(['boom']); // recover peeled OUT of the body
    const boom = loop.body.nodes.find((n) => n.id === 'boom') as DagActionNode;
    expect(boom.onErrorBranch?.nodes.map((n) => n.id)).toEqual(['recover']);
  });

  it('rejects a while loop with a missing max_iterations cap', () => {
    expect(() =>
      compileWorkflowIrDag(
        ir([whileLoop('loop', { max_iterations: undefined }), act('work')], [edge('loop', 'work', 0)]),
      ),
    ).toThrow(/max_iterations/i);
  });

  it('rejects a while loop with a non-positive max_iterations cap', () => {
    expect(() =>
      compileWorkflowIrDag(
        ir([whileLoop('loop', { max_iterations: 0 }), act('work')], [edge('loop', 'work', 0)]),
      ),
    ).toThrow(/max_iterations/i);
  });

  it('rejects a while loop with a non-integer max_iterations cap', () => {
    expect(() =>
      compileWorkflowIrDag(
        ir([whileLoop('loop', { max_iterations: 2.5 }), act('work')], [edge('loop', 'work', 0)]),
      ),
    ).toThrow(/max_iterations/i);
  });

  it('rejects a while loop with no condition', () => {
    expect(() =>
      compileWorkflowIrDag(
        ir([whileLoop('loop', { condition: undefined }), act('work')], [edge('loop', 'work', 0)]),
      ),
    ).toThrow(/condition/i);
  });

  it('rejects a while loop with an unsupported condition op (reuses the native condition compiler)', () => {
    expect(() =>
      compileWorkflowIrDag(
        ir(
          [whileLoop('loop', { condition: { left: '{{loopRound}}', op: 'wat' } }), act('work')],
          [edge('loop', 'work', 0)],
        ),
      ),
    ).toThrow(/unsupported op "wat"/);
  });
});

describe('compileWorkflowIrDag — Switch (orchestr:switch, IF generalized)', () => {
  const switchById = (plan: DagPlan, id: string): DagSwitchNode =>
    plan.nodes.find((n) => n.id === id) as unknown as DagSwitchNode;

  it('lowers orchestr:switch to a flat switch node; case edges → guards on ports 0..N-1, default → port N', () => {
    // route: case 0 → a, case 1 → b, case 2 → c, default(3) → d. All flat (no peeling).
    const plan = compileWorkflowIrDag(
      ir(
        [
          switchNode('route', [
            { left: '{{trigger.kind}}', op: 'eq', right: 'x' },
            { left: '{{trigger.kind}}', op: 'eq', right: 'y' },
            { left: '{{trigger.kind}}', op: 'eq', right: 'z' },
          ]),
          act('a'),
          act('b'),
          act('c'),
          act('d'),
        ],
        [
          edge('route', 'a', 0),
          edge('route', 'b', 1),
          edge('route', 'c', 2),
          edge('route', 'd', 3), // default = cases.length
        ],
      ),
    );
    const routeNode = switchById(plan, 'route');
    expect(routeNode.kind).toBe('switch');
    // One condition per case, IN ORDER — the first-match order is the array order.
    expect(routeNode.cases).toEqual([
      { condition: { left: '{{trigger.kind}}', op: 'eq', right: 'x' } },
      { condition: { left: '{{trigger.kind}}', op: 'eq', right: 'y' } },
      { condition: { left: '{{trigger.kind}}', op: 'eq', right: 'z' } },
    ]);
    // A switch is FLAT: its case/default lanes are plain downstream nodes guarded on its ports.
    expect(byId(plan, 'a').guards).toEqual([{ source: 'route', port: 0 }]);
    expect(byId(plan, 'b').guards).toEqual([{ source: 'route', port: 1 }]);
    expect(byId(plan, 'c').guards).toEqual([{ source: 'route', port: 2 }]);
    expect(byId(plan, 'd').guards).toEqual([{ source: 'route', port: 3 }]);
    // No body/scope peeling — the switch and all its lanes stay in the top-level plan.
    expect(plan.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c', 'd', 'route']);
    assertGuardsPrecede(plan);
  });

  it('translates a case condition that references a prior step (like IF)', () => {
    // seed → route ; the case's left is a {{seed.field}} ref, translated like an IF operand.
    const plan = compileWorkflowIrDag(
      ir(
        [act('seed'), switchNode('route', [{ left: '{{seed.status}}', op: 'eq', right: 'ok' }]), act('a')],
        [edge('seed', 'route'), edge('route', 'a', 0)],
      ),
    );
    expect(switchById(plan, 'route').cases[0]!.condition).toEqual({
      left: '{{seed.status}}',
      op: 'eq',
      right: 'ok',
    });
  });

  it('two case ports reconverge on ONE join node: the join appears once with both port guards', () => {
    // route case0 → j, route case1 → j — a node reachable from two case ports.
    const plan = compileWorkflowIrDag(
      ir(
        [
          switchNode('route', [
            { left: '{{trigger.k}}', op: 'eq', right: 'x' },
            { left: '{{trigger.k}}', op: 'eq', right: 'y' },
          ]),
          act('j'),
        ],
        [edge('route', 'j', 0), edge('route', 'j', 1)],
      ),
    );
    expect(plan.nodes.filter((n) => n.id === 'j')).toHaveLength(1);
    expect(byId(plan, 'j').guards).toEqual([
      { source: 'route', port: 0 },
      { source: 'route', port: 1 },
    ]);
    assertGuardsPrecede(plan);
  });

  it('nests a switch inside a loop body (flat node, recursive peeling of the surrounding loop)', () => {
    // loop --body(0)--> route ; route case0 → work (all inside the loop body sub-plan)
    const plan = compileWorkflowIrDag(
      ir(
        [
          loopNode('loop', { items: '{{seed.rows}}' }),
          switchNode('route', [{ left: '{{item}}', op: 'eq', right: 'go' }]),
          act('work'),
        ],
        [edge('loop', 'route', 0), edge('route', 'work', 0)],
      ),
    );
    const loop = plan.nodes.find((n) => n.id === 'loop') as unknown as DagForEachNode;
    expect(loop.body.nodes.map((n) => n.id)).toEqual(['route', 'work']);
    const routeNode = loop.body.nodes.find((n) => n.id === 'route') as unknown as DagSwitchNode;
    expect(routeNode.kind).toBe('switch');
    expect(loop.body.nodes.find((n) => n.id === 'work')?.guards).toEqual([{ source: 'route', port: 0 }]);
  });

  it('nests a switch inside an IF branch (both flat routers in one plan)', () => {
    // check then(0) → route ; route case0 → a, default(1) → b
    const plan = compileWorkflowIrDag(
      ir(
        [ifNode('check'), switchNode('route', [{ left: '{{trigger.k}}', op: 'truthy' }]), act('a'), act('b')],
        [edge('check', 'route', 0), edge('route', 'a', 0), edge('route', 'b', 1)],
      ),
    );
    expect(byId(plan, 'route').guards).toEqual([{ source: 'check', port: 0 }]);
    expect((plan.nodes.find((n) => n.id === 'route') as unknown as DagSwitchNode).kind).toBe('switch');
    expect(byId(plan, 'a').guards).toEqual([{ source: 'route', port: 0 }]);
    expect(byId(plan, 'b').guards).toEqual([{ source: 'route', port: 1 }]);
    assertGuardsPrecede(plan);
  });

  it('rejects a switch with an empty or missing cases array', () => {
    expect(() =>
      compileWorkflowIrDag(ir([switchNode('route', []), act('a')], [edge('route', 'a', 0)])),
    ).toThrow(/cases/i);
  });

  it('rejects a case with an unsupported op (reuses the native condition compiler)', () => {
    expect(() =>
      compileWorkflowIrDag(
        ir([switchNode('route', [{ left: 'x', op: 'wat' }]), act('a')], [edge('route', 'a', 0)]),
      ),
    ).toThrow(/unsupported op "wat"/);
  });

  it('rejects a case that is not an object condition', () => {
    expect(() =>
      compileWorkflowIrDag(
        ir(
          [switchNode('route', ['not-an-object' as unknown as Record<string, unknown>]), act('a')],
          [edge('route', 'a', 0)],
        ),
      ),
    ).toThrow(/case 0/i);
  });
});

describe('compileWorkflowIrDag — the lane of an edge that omits port_type', () => {
  // A hand-written document (and every client edge builder) may omit `port_type`; the stored-edge
  // rule says absent = main. The compiler must read it the same way or it drops the edge in silence.
  const laneless = (source: string, target: string, sourcePort = 0): IREdge => {
    const bare: Record<string, unknown> = { ...edge(source, target, sourcePort) };
    delete bare.port_type;
    return bare as unknown as IREdge;
  };

  it('reads an edge with no port_type as the main lane instead of dropping it', () => {
    const plan = compileWorkflowIrDag(ir([act('a'), act('b')], [laneless('a', 'b')]));
    expect(plan.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(byId(plan, 'b').guards).toEqual([{ source: 'a', port: 0 }]);
  });

  it('routes a laneless IF edge onto its then/else port, like an explicit main edge', () => {
    const plan = compileWorkflowIrDag(
      ir([ifNode('gate'), act('yes'), act('no')], [laneless('gate', 'yes', 0), laneless('gate', 'no', 1)]),
    );
    expect(byId(plan, 'yes').guards).toEqual([{ source: 'gate', port: 0 }]);
    expect(byId(plan, 'no').guards).toEqual([{ source: 'gate', port: 1 }]);
  });
});

describe('compileWorkflowIrDag — agent param round-trip (client↔service contract)', () => {
  // The client commits EXACTLY this shape (snake_case keys, `model` as an object), so pin
  // that those params survive compilation and the casing can't silently drift.
  it('carries system_prompt, model {provider, model}, max_steps and binds the tool', () => {
    const agent: IRNode = {
      ...act('assistant'),
      node_type: 'orchestr:agent',
      parameters: {
        system_prompt: 'be helpful',
        model: { provider: 'claude', model: 'claude-opus-4-8' },
        max_steps: 7,
      },
    };
    // One tool binding: `port_type:'tool'` from the agent to an action node (invariant #14).
    const toolEdge: IREdge = {
      ...edge('assistant', 'concat'),
      id: 'assistant=tool=>concat',
      port_type: 'tool',
    };

    const plan = compileWorkflowIrDag(ir([agent, act('concat')], [toolEdge]));

    const compiled = plan.nodes.find((n) => n.id === 'assistant') as unknown as DagAgentNode;
    expect(compiled.kind).toBe('agent');
    // Params survive — the client's snake_case + model object lower to the DagAgentNode fields.
    expect(compiled.systemPrompt).toBe('be helpful');
    expect(compiled.model).toEqual({ provider: 'claude', model: 'claude-opus-4-8' });
    expect(compiled.maxSteps).toBe(7);

    // The tool node is peeled out of the main flow and bound onto the agent.
    expect(plan.nodes.some((n) => n.id === 'concat')).toBe(false);
    expect(compiled.tools).toHaveLength(1);
    const tool = compiled.tools[0] as DagAgentActionTool;
    expect(tool.kind).toBe('action');
    expect(tool.actionId).toBe(ACTION);
  });
});
