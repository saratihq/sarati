import { compileWorkflowIrDag } from '../compiler/compile-ir-dag';
import { emptySettings, type IREdge, type IRNode, type WorkflowIR } from '../ir/models';
import type { ManagedIntegrationProvider } from '../providers/managed-integration-provider';
import { DagInterpreter } from './dag-interpreter';
import type { DagPlan } from './dag-plan';
import type { RunResult } from './run-plan';

/**
 * Compile-and-run coverage for the ONE engine (`compileWorkflowIrDag → DagInterpreter`),
 * asserting outputs against concrete expected values. The provider is a deterministic echo.
 */

/** Deterministic echo provider: `{ ran, props }` per action; `fail(actionId)` throws. */
function echoProvider(fail: (actionId: string) => boolean = () => false): ManagedIntegrationProvider {
  return {
    key: 'echo',
    runAction: (input) =>
      fail(input.actionId)
        ? Promise.reject(new Error(`boom:${input.actionId}`))
        : Promise.resolve({ output: { ran: input.actionId, props: input.props } }),
    enableTrigger: () => Promise.resolve(),
    pollTrigger: () => Promise.resolve([]),
    disableTrigger: () => Promise.resolve(),
  };
}

function node(id: string, node_type: string, parameters: Record<string, unknown> = {}): IRNode {
  return { id, name: id, node_type, type_version: 1, parameters, position: { x: 0, y: 0 }, metadata: {} };
}
/** A native public action (`<slug>.<action>`) — compiles directly. */
const act = (id: string, parameters: Record<string, unknown> = {}): IRNode =>
  node(id, `test.${id}`, parameters);
const ifNode = (id: string, condition: Record<string, unknown>): IRNode => node(id, 'orchestr:if', condition);
const loopNode = (id: string, parameters: Record<string, unknown>): IRNode =>
  node(id, 'orchestr:loop', parameters);
const switchNode = (id: string, cases: Array<Record<string, unknown>>): IRNode =>
  node(id, 'orchestr:switch', { cases });
function edge(source: string, target: string, sourcePort = 0, port_type = 'main'): IREdge {
  return {
    id: `${source}->${target}:${sourcePort}:${port_type}`,
    source_node_id: source,
    source_port: sourcePort,
    target_node_id: target,
    target_port: 0,
    port_type,
  };
}
const ir = (nodes: IRNode[], edges: IREdge[]): WorkflowIR => ({
  version: '1',
  name: 'compile-run',
  description: '',
  nodes,
  edges,
  settings: emptySettings(),
  metadata: {},
});

/** Compile the IR to a flat DagPlan and run it on the DagInterpreter. */
function run(
  workflow: WorkflowIR,
  initialScope: Record<string, unknown> = {},
  provider: ManagedIntegrationProvider = echoProvider(),
): Promise<RunResult> {
  const plan: DagPlan = compileWorkflowIrDag(workflow);
  return new DagInterpreter(provider).run(plan, { externalUserId: 'u', initialScope });
}

describe('compileWorkflowIrDag → DagInterpreter (the one engine)', () => {
  it('linear chain: a → b → c', async () => {
    const { outputs } = await run(
      ir(
        [act('a'), act('b', { up: '{{a.ran}}' }), act('c', { up: '{{b.ran}}' })],
        [edge('a', 'b'), edge('b', 'c')],
      ),
    );
    expect(outputs.c).toEqual({ ran: 'test.c', props: { up: 'test.b' } });
  });

  it('fan-out: a → x, a → y', async () => {
    const { outputs } = await run(
      ir(
        [act('a'), act('x', { up: '{{a.ran}}' }), act('y', { up: '{{a.ran}}' })],
        [edge('a', 'x'), edge('a', 'y')],
      ),
    );
    expect(outputs.x).toEqual({ ran: 'test.x', props: { up: 'test.a' } });
    expect(outputs.y).toEqual({ ran: 'test.y', props: { up: 'test.a' } });
  });

  it('linear fan-in: two roots reconverge on one node (no IF)', async () => {
    const { outputs } = await run(
      ir(
        [act('a'), act('b'), act('c', { l: '{{a.ran}}', r: '{{b.ran}}' })],
        [edge('a', 'c'), edge('b', 'c')],
      ),
    );
    expect(outputs.c).toEqual({ ran: 'test.c', props: { l: 'test.a', r: 'test.b' } });
  });

  it('fan-in of THREE: three roots reconverge on one node (no IF)', async () => {
    const { outputs } = await run(
      ir(
        [act('r1'), act('r2'), act('r3'), act('j', { a: '{{r1.ran}}', b: '{{r2.ran}}', c: '{{r3.ran}}' })],
        [edge('r1', 'j'), edge('r2', 'j'), edge('r3', 'j')],
      ),
    );
    expect(outputs.j).toEqual({ ran: 'test.j', props: { a: 'test.r1', b: 'test.r2', c: 'test.r3' } });
  });

  it('diamond fan-in: split → m1/m2 → join (no IF)', async () => {
    const { outputs } = await run(
      ir(
        [
          act('split'),
          act('m1', { up: '{{split.ran}}' }),
          act('m2', { up: '{{split.ran}}' }),
          act('join', { l: '{{m1.ran}}', r: '{{m2.ran}}' }),
        ],
        [edge('split', 'm1'), edge('split', 'm2'), edge('m1', 'join'), edge('m2', 'join')],
      ),
    );
    expect(outputs.join).toEqual({ ran: 'test.join', props: { l: 'test.m1', r: 'test.m2' } });
  });

  it('IF then-only: condition true runs `then`, false skips it', async () => {
    const workflow = (right: string): WorkflowIR =>
      ir(
        [act('a'), ifNode('check', { left: '{{a.ran}}', op: 'eq', right }), act('then', { up: '{{a.ran}}' })],
        [edge('a', 'check'), edge('check', 'then', 0)],
      );
    expect((await run(workflow('test.a'))).outputs.then).toBeDefined();
    expect((await run(workflow('nope'))).outputs.then).toBeUndefined();
  });

  it('IF then/else: each condition takes exactly one branch', async () => {
    const workflow = (right: string): WorkflowIR =>
      ir(
        [act('a'), ifNode('check', { left: '{{a.ran}}', op: 'eq', right }), act('then'), act('else')],
        [edge('a', 'check'), edge('check', 'then', 0), edge('check', 'else', 1)],
      );
    const truthy = await run(workflow('test.a'));
    expect(truthy.outputs.then).toBeDefined();
    expect(truthy.outputs.else).toBeUndefined();

    const falsy = await run(workflow('nope'));
    expect(falsy.outputs.else).toBeDefined();
    expect(falsy.outputs.then).toBeUndefined();
  });

  it('error output: the error lane runs, the main successor is skipped, run completes', async () => {
    const { outputs } = await run(
      ir(
        [act('boom'), act('after', { m: 'MAIN' }), act('handler', { m: '{{boom.error.message}}' })],
        [edge('boom', 'after', 0, 'main'), edge('boom', 'handler', 0, 'error')],
      ),
      {},
      echoProvider((id) => id === 'test.boom'),
    );
    expect((outputs.handler as { props: { m: string } }).props.m).toContain('boom:test.boom');
    expect(outputs.after).toBeUndefined(); // never both lanes
  });

  it('continue-on-fail: a tolerated throw is captured; the run goes on', async () => {
    const { outputs } = await run(
      ir(
        [act('boom', { onError: 'continue' }), act('after', { m: '{{boom.error.message}}' })],
        [edge('boom', 'after')],
      ),
      {},
      echoProvider((id) => id === 'test.boom'),
    );
    expect((outputs.boom as { __errored: boolean }).__errored).toBe(true);
    expect((outputs.after as { props: { m: string } }).props.m).toContain('boom:test.boom');
  });

  it('retry + continue: retries exhaust, then the failure is tolerated', async () => {
    const { outputs } = await run(
      ir(
        [
          act('boom', { onError: 'continue', retry: { maxAttempts: 2, backoffMs: 0 } }),
          act('after', { m: '{{boom.error.message}}' }),
        ],
        [edge('boom', 'after')],
      ),
      {},
      echoProvider((id) => id === 'test.boom'),
    );
    expect((outputs.boom as { __errored: boolean }).__errored).toBe(true);
  });

  // ─── forEach / parallel have no IR source, so they are covered as hand-built
  //     flat DagPlans run directly on the interpreter. ───

  it('forEach: the flat DagPlan runs the body once per element', async () => {
    const dagPlan: DagPlan = {
      id: 'fe',
      nodes: [
        { kind: 'action', id: 'seed', actionId: 'seed.get', props: { items: ['x', 'y'] }, guards: [] },
        {
          kind: 'forEach',
          id: 'each',
          items: '{{seed.props.items}}',
          itemVar: 'it',
          body: {
            id: 'fe#each',
            nodes: [{ kind: 'action', id: 'call', actionId: 'call.do', props: { v: '{{it}}' }, guards: [] }],
          },
          guards: [{ source: 'seed', port: 0 }],
        },
      ],
    };
    const { outputs } = await new DagInterpreter(echoProvider()).run(dagPlan, { externalUserId: 'u' });
    expect((outputs.each as Array<{ call: { props: { v: string } } }>).map((i) => i.call.props.v)).toEqual([
      'x',
      'y',
    ]);
  });

  it('parallel: the flat DagPlan runs branches and merges their outputs', async () => {
    const dagPlan: DagPlan = {
      id: 'par',
      nodes: [
        {
          kind: 'parallel',
          id: 'fork',
          branches: [
            {
              id: 'par#l',
              nodes: [{ kind: 'action', id: 'left', actionId: 'l.do', props: { s: 'L' }, guards: [] }],
            },
            {
              id: 'par#r',
              nodes: [{ kind: 'action', id: 'right', actionId: 'r.do', props: { s: 'R' }, guards: [] }],
            },
          ],
          guards: [],
        },
      ],
    };
    const { outputs } = await new DagInterpreter(echoProvider()).run(dagPlan, { externalUserId: 'u' });
    expect(outputs.left).toEqual({ ran: 'l.do', props: { s: 'L' } });
    expect(outputs.right).toEqual({ ran: 'r.do', props: { s: 'R' } });
  });
});

// ─── Loop-Over-Items: `orchestr:loop` lowers to a forEach node (body peeled from
//     port 0, continuation on port 1), run once per element. ───
describe('compileWorkflowIrDag → DagInterpreter: Loop-Over-Items (slice 6)', () => {
  it('runs the body once per element; {{item}}/{{itemIndex}} resolve; the loop output is the per-iteration array', async () => {
    const { outputs } = await run(
      ir(
        [
          loopNode('loop', { items: '{{rows}}' }),
          act('work', { v: '{{item}}', i: '{{itemIndex}}' }),
          act('after', { all: '{{loop}}' }),
        ],
        [edge('loop', 'work', 0), edge('loop', 'after', 1)],
      ),
      { rows: ['a', 'b', 'c'] },
    );
    const perIter = outputs.loop as Array<{ work: { props: { v: string; i: number } } }>;
    expect(perIter).toHaveLength(3);
    expect(perIter.map((o) => o.work.props.v)).toEqual(['a', 'b', 'c']);
    expect(perIter.map((o) => o.work.props.i)).toEqual([0, 1, 2]);
    // The continuation runs ONCE after the loop and reads the per-iteration array.
    expect((outputs.after as { props: { all: unknown } }).props.all).toEqual(outputs.loop);
  });

  it('empty collection: the body runs 0×, the continuation still runs once', async () => {
    const { outputs } = await run(
      ir(
        [
          loopNode('loop', { items: '{{rows}}' }),
          act('work', { v: '{{item}}' }),
          act('after', { all: '{{loop}}' }),
        ],
        [edge('loop', 'work', 0), edge('loop', 'after', 1)],
      ),
      { rows: [] },
    );
    expect(outputs.loop).toEqual([]);
    expect((outputs.after as { props: { all: unknown } }).props.all).toEqual([]);
  });

  it('the body may reference an upstream (outside-loop) node', async () => {
    const { outputs } = await run(
      ir(
        [
          act('seed'),
          loopNode('loop', { items: '{{rows}}' }),
          act('work', { u: '{{seed.ran}}', v: '{{item}}' }),
        ],
        [edge('seed', 'loop'), edge('loop', 'work', 0)],
      ),
      { rows: ['x', 'y'] },
    );
    const perIter = outputs.loop as Array<{ work: { props: { u: string; v: string } } }>;
    expect(perIter.map((o) => o.work.props.u)).toEqual(['test.seed', 'test.seed']);
    expect(perIter.map((o) => o.work.props.v)).toEqual(['x', 'y']);
  });

  it('nested loops: an inner loop inside the body runs per (outer element × inner element)', async () => {
    const { outputs } = await run(
      ir(
        [
          loopNode('outer', { items: '{{rows}}', item_var: 'row' }),
          loopNode('inner', { items: '{{row}}', item_var: 'cell' }),
          act('work', { c: '{{cell}}' }),
        ],
        [edge('outer', 'inner', 0), edge('inner', 'work', 0)],
      ),
      { rows: [['a'], ['b', 'c']] },
    );
    const outer = outputs.outer as Array<{ inner: Array<{ work: { props: { c: string } } }> }>;
    expect(outer.map((o) => o.inner.map((i) => i.work.props.c))).toEqual([['a'], ['b', 'c']]);
  });
});

// ─── Loop while-mode: the SAME loop node with mode:'while' runs DO-WHILE —
//     body ≥1×, then while the condition holds, bounded by max_iterations. ───
describe('compileWorkflowIrDag → DagInterpreter: Loop while-mode', () => {
  const whileLoop = (id: string, params: Record<string, unknown>): IRNode =>
    node(id, 'orchestr:loop', { mode: 'while', ...params });

  it('do-while: a condition that flips false after N rounds runs the body N× with evolving state', async () => {
    // Continue while loopRound < 2 → rounds 0,1,2 run (false after round 2): 3 rounds. Each
    // round reads the PRIOR round's output via {{loopPrev}} — proving state threads round→round.
    const { outputs } = await run(
      ir(
        [
          whileLoop('loop', {
            condition: { left: '{{loopRound}}', op: 'lt', right: 2 },
            max_iterations: 10,
          }),
          act('poll', { n: '{{loopRound}}', prev: '{{loopPrev.poll.props.n}}' }),
          act('after', { all: '{{loop}}' }),
        ],
        [edge('loop', 'poll', 0), edge('loop', 'after', 1)],
      ),
    );
    const rounds = outputs.loop as Array<{ poll: { props: { n: number; prev: number | undefined } } }>;
    expect(rounds).toHaveLength(3);
    expect(rounds.map((r) => r.poll.props.n)).toEqual([0, 1, 2]);
    // Evolving state: round N's body sees round N-1's output (round 0 has no prior → undefined).
    expect(rounds.map((r) => r.poll.props.prev)).toEqual([undefined, 0, 1]);
    // {{loop}} = the array of per-round outputs; the continuation runs ONCE after the loop.
    expect((outputs.after as { props: { all: unknown } }).props.all).toEqual(outputs.loop);
  });

  it('do-while boundary: an immediately-false condition still runs the body exactly ONCE', async () => {
    const { outputs } = await run(
      ir(
        [
          whileLoop('loop', {
            condition: { left: '{{loopRound}}', op: 'lt', right: 0 }, // 0 < 0 → false at once
            max_iterations: 5,
          }),
          act('work', { n: '{{loopRound}}' }),
        ],
        [edge('loop', 'work', 0)],
      ),
    );
    const rounds = outputs.loop as Array<{ work: { props: { n: number } } }>;
    expect(rounds).toHaveLength(1); // body ran once despite the condition being false up front
    expect(rounds[0]!.work.props.n).toBe(0);
  });

  it('the cap is a hard stop: a never-false condition stops at exactly max_iterations (no error)', async () => {
    const { outputs } = await run(
      ir(
        [
          whileLoop('loop', {
            condition: { left: '{{loopRound}}', op: 'gte', right: 0 }, // always true
            max_iterations: 4,
          }),
          act('work', { n: '{{loopRound}}' }),
        ],
        [edge('loop', 'work', 0)],
      ),
    );
    const rounds = outputs.loop as Array<{ work: { props: { n: number } } }>;
    expect(rounds).toHaveLength(4); // stopped cleanly at the cap
    expect(rounds.map((r) => r.work.props.n)).toEqual([0, 1, 2, 3]);
  });

  it('nests a while loop inside a forEach body (2 rounds per element)', async () => {
    const { outputs } = await run(
      ir(
        [
          loopNode('outer', { items: '{{rows}}', item_var: 'row' }),
          whileLoop('inner', {
            condition: { left: '{{loopRound}}', op: 'lt', right: 1 }, // 2 rounds each
            max_iterations: 3,
          }),
          act('work', { r: '{{row}}', n: '{{loopRound}}' }),
        ],
        [edge('outer', 'inner', 0), edge('inner', 'work', 0)],
      ),
      { rows: ['a', 'b'] },
    );
    const outer = outputs.outer as Array<{ inner: Array<{ work: { props: { r: string; n: number } } }> }>;
    expect(outer.map((o) => o.inner.map((i) => `${i.work.props.r}${i.work.props.n}`))).toEqual([
      ['a0', 'a1'],
      ['b0', 'b1'],
    ]);
  });

  it('a while loop inside an IF branch only runs when the branch is live', async () => {
    const workflow = (): WorkflowIR =>
      ir(
        [
          ifNode('gate', { left: '{{flag}}', op: 'truthy' }),
          whileLoop('loop', {
            condition: { left: '{{loopRound}}', op: 'lt', right: 1 }, // 2 rounds
            max_iterations: 3,
          }),
          act('work', { n: '{{loopRound}}' }),
        ],
        [edge('gate', 'loop', 0), edge('loop', 'work', 0)],
      );
    const on = await run(workflow(), { flag: true });
    expect(on.outputs.loop).toHaveLength(2);
    const off = await run(workflow(), { flag: false });
    expect(off.outputs.loop).toBeUndefined(); // whole while lane skipped (gate port 0 dead)
  });

  it('an error output inside a while body fires the error lane (recursive peel runs)', async () => {
    // loop --body--> boom (throws) ; boom --error--> recover. The error lane runs inside the
    // round; halt ends the run cleanly (the run resolves, recover is traced).
    const res = await run(
      ir(
        [
          whileLoop('loop', {
            condition: { left: '{{loopRound}}', op: 'lt', right: 5 },
            max_iterations: 5,
          }),
          act('boom', { n: '{{loopRound}}' }),
          act('recover', { m: '{{boom.error.message}}' }),
        ],
        [edge('loop', 'boom', 0), edge('boom', 'recover', 0, 'error')],
      ),
      {},
      echoProvider((id) => id === 'test.boom'),
    );
    const recovered = res.trace.find((t) => t.nodeId.includes('recover'));
    expect(recovered).toBeDefined();
    expect((recovered!.output as { props: { m: string } }).props.m).toContain('boom:test.boom');
  });
});

// ─── Switch: a flat node whose case/default lanes are downstream nodes guarded on
//     ports 0..N-1 / N, routed first-match-wins, else the default. ───
describe('compileWorkflowIrDag → DagInterpreter: Switch (orchestr:switch)', () => {
  // route: case0 eq 'a' → na, case1 eq 'b' → nb, case2 eq 'c' → nc, default(3) → nd.
  const routeIr = (): WorkflowIR =>
    ir(
      [
        switchNode('route', [
          { left: '{{kind}}', op: 'eq', right: 'a' },
          { left: '{{kind}}', op: 'eq', right: 'b' },
          { left: '{{kind}}', op: 'eq', right: 'c' },
        ]),
        act('na'),
        act('nb'),
        act('nc'),
        act('nd'),
      ],
      [edge('route', 'na', 0), edge('route', 'nb', 1), edge('route', 'nc', 2), edge('route', 'nd', 3)],
    );

  it('3-case switch: only the matching case runs; the other cases AND the default are skipped', async () => {
    const { outputs } = await run(routeIr(), { kind: 'b' });
    expect(outputs.nb).toBeDefined(); // case 1 matched
    expect(outputs.na).toBeUndefined();
    expect(outputs.nc).toBeUndefined();
    expect(outputs.nd).toBeUndefined(); // default NOT taken
  });

  it('no case matches: the DEFAULT (port cases.length) runs, every case is skipped', async () => {
    const { outputs } = await run(routeIr(), { kind: 'zzz' });
    expect(outputs.nd).toBeDefined(); // default (port 3) taken
    expect(outputs.na).toBeUndefined();
    expect(outputs.nb).toBeUndefined();
    expect(outputs.nc).toBeUndefined();
  });

  it('first-match-wins: when two cases could match, the earlier one wins (order matters)', async () => {
    // Both cases hold for n=5, but case 0 (>0) precedes case 1 (>3): case 0 must win.
    const workflow = ir(
      [
        switchNode('route', [
          { left: '{{n}}', op: 'gt', right: 0 },
          { left: '{{n}}', op: 'gt', right: 3 },
        ]),
        act('first'),
        act('second'),
        act('none'),
      ],
      [edge('route', 'first', 0), edge('route', 'second', 1), edge('route', 'none', 2)],
    );
    const { outputs } = await run(workflow, { n: 5 });
    expect(outputs.first).toBeDefined(); // earliest matching case
    expect(outputs.second).toBeUndefined();
    expect(outputs.none).toBeUndefined();
  });

  it('reconvergence after switch: a node reachable from two case ports runs ONCE (OR-join)', async () => {
    // route case0 → j AND route case1 → j; default(2) → dflt. Whichever case is live,
    // j fires exactly once (the other port + the default are dead).
    const workflow = ir(
      [
        switchNode('route', [
          { left: '{{k}}', op: 'eq', right: 'x' },
          { left: '{{k}}', op: 'eq', right: 'y' },
        ]),
        act('j', { hit: 'J' }),
        act('dflt', { hit: 'D' }),
      ],
      [edge('route', 'j', 0), edge('route', 'j', 1), edge('route', 'dflt', 2)],
    );
    const res = await run(workflow, { k: 'y' }); // case 1 selected
    expect(res.trace.filter((t) => t.nodeId === 'j').length).toBe(1); // OR-join: exactly once
    expect(res.outputs.j).toEqual({ ran: 'test.j', props: { hit: 'J' } });
    expect(res.outputs.dflt).toBeUndefined(); // default port dead
  });

  it('a case condition references prior-step data ({{step.field}})', async () => {
    const workflow = ir(
      [
        act('seed'),
        switchNode('route', [{ left: '{{seed.ran}}', op: 'eq', right: 'test.seed' }]),
        act('matched'),
        act('fallback'),
      ],
      [edge('seed', 'route'), edge('route', 'matched', 0), edge('route', 'fallback', 1)],
    );
    const { outputs } = await run(workflow); // seed.ran === 'test.seed' → case 0 holds
    expect(outputs.matched).toBeDefined();
    expect(outputs.fallback).toBeUndefined(); // default port dead
  });

  it('nested: a switch inside a loop body routes each element independently', async () => {
    const { outputs } = await run(
      ir(
        [
          loopNode('loop', { items: '{{rows}}' }),
          switchNode('route', [{ left: '{{item}}', op: 'eq', right: 'hit' }]),
          act('onHit', { v: '{{item}}' }),
          act('onMiss', { v: '{{item}}' }),
        ],
        [edge('loop', 'route', 0), edge('route', 'onHit', 0), edge('route', 'onMiss', 1)],
      ),
      { rows: ['hit', 'miss', 'hit'] },
    );
    const perIter = outputs.loop as Array<Record<string, unknown>>;
    expect(perIter).toHaveLength(3);
    expect(perIter[0]!.onHit).toBeDefined(); // 'hit' → case 0
    expect(perIter[0]!.onMiss).toBeUndefined();
    expect(perIter[1]!.onMiss).toBeDefined(); // 'miss' → default
    expect(perIter[1]!.onHit).toBeUndefined();
    expect(perIter[2]!.onHit).toBeDefined(); // 'hit' again → case 0
  });

  it('nested: a switch inside an IF branch only routes when the branch is live', async () => {
    const workflow = ir(
      [
        ifNode('gate', { left: '{{flag}}', op: 'truthy' }),
        switchNode('route', [{ left: '{{k}}', op: 'eq', right: 'x' }]),
        act('hit'),
        act('miss'),
      ],
      [edge('gate', 'route', 0), edge('route', 'hit', 0), edge('route', 'miss', 1)],
    );
    // gate TRUE → switch runs; k='x' → case 0 → hit; the default (miss) is dead.
    const on = await run(workflow, { flag: true, k: 'x' });
    expect(on.outputs.hit).toBeDefined();
    expect(on.outputs.miss).toBeUndefined();
    // gate FALSE → the whole switch sub-lane is skipped (switch never ran → all ports dead).
    const off = await run(workflow, { flag: false, k: 'x' });
    expect(off.outputs.route).toBeUndefined();
    expect(off.outputs.hit).toBeUndefined();
    expect(off.outputs.miss).toBeUndefined();
  });
});
