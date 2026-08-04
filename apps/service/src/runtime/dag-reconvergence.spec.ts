import { compileWorkflowIrDag } from '../compiler/compile-ir-dag';
import { emptySettings, type IREdge, type IRNode, type WorkflowIR } from '../ir/models';
import type { ManagedIntegrationProvider } from '../providers/managed-integration-provider';
import { DagInterpreter } from './dag-interpreter';
import type { DagPlan } from './dag-plan';
import type { RunResult } from './run-plan';

/**
 * RECONVERGENCE / OR-JOIN (ADR 0023): plain fan-out reconvergence, an IF-lane join with an external
 * inflow, lanes rejoining then remerging, fan-out-of-3, and an OR-join over a live path plus a dead
 * IF port. Each compiles + runs and asserts which nodes ran, which were skipped, and what refs
 * resolved to. The OR-join semantic: a join fires when ANY live path reaches it, and a ref to a node
 * on a dead branch resolves to `undefined` — not an AND-join, not a crash.
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
/** A native public action (`<slug>.<action>`) — compiles directly on both paths. */
const act = (id: string, parameters: Record<string, unknown> = {}): IRNode =>
  node(id, `test.${id}`, parameters);
const ifNode = (id: string, condition: Record<string, unknown>): IRNode => node(id, 'orchestr:if', condition);
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
  name: 'reconvergence',
  description: '',
  nodes,
  edges,
  settings: emptySettings(),
  metadata: {},
});

/** Compile + run a workflow on the DAG path only; returns the full RunResult. */
async function runDag(
  workflow: WorkflowIR,
  initialScope: Record<string, unknown> = {},
  provider: ManagedIntegrationProvider = echoProvider(),
): Promise<RunResult> {
  const dagPlan: DagPlan = compileWorkflowIrDag(workflow);
  return new DagInterpreter(provider).run(dagPlan, { externalUserId: 'u', initialScope });
}

/** The `{ ran, props }` echo shape's props, for concrete per-node assertions. */
const propsOf = (out: unknown): Record<string, unknown> => (out as { props: Record<string, unknown> }).props;
/** How many times a node executed (its trace entries) — proves OR-join fires ONCE. */
const ranTimes = (result: RunResult, id: string): number =>
  result.trace.filter((t) => t.nodeId === id).length;

describe('DAG reconvergence differential vs the tree compiler (ADR 0023 slice 3)', () => {
  it('plain fan-out reconverges (IF present elsewhere): DAG OR-joins the diamond once', async () => {
    // A → B, A → C, B → J, C → J is a plain (non-IF) diamond, with an unrelated IF
    // downstream (J → gate → K): J must run ONCE with both inflows live.
    const workflow = ir(
      [
        act('A'),
        act('B', { up: '{{A.ran}}' }),
        act('C', { up: '{{A.ran}}' }),
        act('J', { b: '{{B.ran}}', c: '{{C.ran}}' }),
        ifNode('gate', { left: '{{J.ran}}', op: 'truthy' }),
        act('K', { via: '{{J.ran}}' }),
      ],
      [
        edge('A', 'B'),
        edge('A', 'C'),
        edge('B', 'J'),
        edge('C', 'J'),
        edge('J', 'gate'),
        edge('gate', 'K', 0),
      ],
    );

    // DAG runs J once with both B and C resolved; the downstream IF's then-port fires K.
    const result = await runDag(workflow);
    expect(ranTimes(result, 'J')).toBe(1);
    expect(result.outputs.J).toEqual({ ran: 'test.J', props: { b: 'test.B', c: 'test.C' } });
    expect(result.outputs.K).toEqual({ ran: 'test.K', props: { via: 'test.J' } });
  });

  it('IF-lane join with an EXTERNAL inflow: DAG OR-joins T/E + D, dead-lane ref → undefined', async () => {
    // check(then→T, else→E), T→J, E→J, plus an independent D→J: J has an inflow from
    // OUTSIDE the IF's lanes, and must run once when any inflow is live. The structure is
    // flag-independent — the branch is decided at run time — so the IR is built once.
    const workflow = ir(
      [
        ifNode('check', { left: '{{flag}}', op: 'truthy' }),
        act('T', { m: 'T' }),
        act('E', { m: 'E' }),
        act('D', { m: 'D' }),
        act('J', { t: '{{T.ran}}', e: '{{E.ran}}', d: '{{D.ran}}' }),
      ],
      [edge('check', 'T', 0), edge('check', 'E', 1), edge('T', 'J'), edge('E', 'J'), edge('D', 'J')],
    );

    // condition TRUE → then-lane (T) live, else-lane (E) skipped, D independent.
    const on = await runDag(workflow, { flag: true });
    expect(on.outputs.T).toEqual({ ran: 'test.T', props: { m: 'T' } });
    expect(on.outputs.E).toBeUndefined(); // dead else-lane — never ran
    expect(on.outputs.D).toEqual({ ran: 'test.D', props: { m: 'D' } });
    expect(ranTimes(on, 'J')).toBe(1); // OR-join, once
    expect(propsOf(on.outputs.J).t).toBe('test.T'); // live lane resolved
    expect(propsOf(on.outputs.J).d).toBe('test.D'); // independent inflow resolved
    expect(propsOf(on.outputs.J).e).toBeUndefined(); // ref to the skipped else-lane → undefined

    // condition FALSE → symmetric: E live, T skipped.
    const off = await runDag(workflow, { flag: false });
    expect(off.outputs.E).toEqual({ ran: 'test.E', props: { m: 'E' } });
    expect(off.outputs.T).toBeUndefined();
    expect(propsOf(off.outputs.J).e).toBe('test.E');
    expect(propsOf(off.outputs.J).d).toBe('test.D');
    expect(propsOf(off.outputs.J).t).toBeUndefined();
  });

  it('IF lanes rejoin at DIFFERENT nodes then remerge: DAG runs both joins + remerge', async () => {
    // check(then→A, else→B); A→P, B→Q are DISTINCT joins, an independent W→P and W→Q
    // gives each its second inflow, and P→Z, Q→Z remerges. The IF's lanes therefore reach
    // two DIFFERENT joins and remerge only at Z; each join runs once via whichever inflow is live.
    const workflow = ir(
      [
        ifNode('check', { left: '{{flag}}', op: 'truthy' }),
        act('A', { m: 'A' }),
        act('B', { m: 'B' }),
        act('W', { m: 'W' }),
        act('P', { a: '{{A.ran}}' }),
        act('Q', { fromDeadLane: '{{B.ran}}' }),
        act('Z', { p: '{{P.ran}}', q: '{{Q.ran}}' }),
      ],
      [
        edge('check', 'A', 0),
        edge('check', 'B', 1),
        edge('A', 'P'),
        edge('B', 'Q'),
        edge('W', 'P'),
        edge('W', 'Q'),
        edge('P', 'Z'),
        edge('Q', 'Z'),
      ],
    );

    // condition TRUE → A live (then), B skipped (else). P runs via A; Q runs via
    // the independent W (OR-join — its dead B inflow contributes nothing); Z remerges.
    const result = await runDag(workflow, { flag: true });
    expect(result.outputs.A).toEqual({ ran: 'test.A', props: { m: 'A' } });
    expect(result.outputs.B).toBeUndefined(); // else-lane skipped
    expect(ranTimes(result, 'P')).toBe(1);
    expect(ranTimes(result, 'Q')).toBe(1);
    expect(result.outputs.P).toEqual({ ran: 'test.P', props: { a: 'test.A' } }); // via A
    expect(propsOf(result.outputs.Q).fromDeadLane).toBeUndefined(); // dead B-lane ref → undefined
    expect(result.outputs.Z).toEqual({ ran: 'test.Z', props: { p: 'test.P', q: 'test.Q' } }); // remerge
  });

  it('fan-out of THREE reconverges (IF present): DAG runs the join once', async () => {
    // A → x1, x2, x3 → J. Same rejection as the 2-wide diamond, wider fan.
    const workflow = ir(
      [
        act('A'),
        act('x1', { up: '{{A.ran}}' }),
        act('x2', { up: '{{A.ran}}' }),
        act('x3', { up: '{{A.ran}}' }),
        act('J', { a: '{{x1.ran}}', b: '{{x2.ran}}', c: '{{x3.ran}}' }),
        ifNode('gate', { left: '{{J.ran}}', op: 'truthy' }),
        act('K', { via: '{{J.ran}}' }),
      ],
      [
        edge('A', 'x1'),
        edge('A', 'x2'),
        edge('A', 'x3'),
        edge('x1', 'J'),
        edge('x2', 'J'),
        edge('x3', 'J'),
        edge('J', 'gate'),
        edge('gate', 'K', 0),
      ],
    );

    const result = await runDag(workflow);
    expect(ranTimes(result, 'J')).toBe(1);
    expect(result.outputs.J).toEqual({ ran: 'test.J', props: { a: 'test.x1', b: 'test.x2', c: 'test.x3' } });
    expect(result.outputs.K).toBeDefined();
  });

  it('OR-join with a dead-branch ref: the join fires via the live independent path; the dead ref → undefined (not AND-join, not a throw)', async () => {
    // check then→T→J, and an independent D→J (no else edge). Condition FALSE ⇒ the
    // then-port is dead ⇒ T is skipped, yet J still runs (OR-join via D), and J's
    // ref to the dead T resolves to undefined.
    const workflow = ir(
      [
        ifNode('check', { left: '{{flag}}', op: 'truthy' }),
        act('T', { m: 'T' }),
        act('D', { m: 'D' }),
        act('J', { t: '{{T.ran}}', d: '{{D.ran}}' }),
      ],
      [edge('check', 'T', 0), edge('T', 'J'), edge('D', 'J')],
    );

    // condition FALSE → then-port dead, T skipped, but D reaches J → J RUNS ONCE.
    const dead = await runDag(workflow, { flag: false });
    expect(dead.outputs.T).toBeUndefined(); // dead branch never ran
    expect(ranTimes(dead, 'J')).toBe(1); // fired ONCE via D (OR-join, not AND-join)
    expect(propsOf(dead.outputs.J).d).toBe('test.D'); // live path resolved
    expect(propsOf(dead.outputs.J).t).toBeUndefined(); // ref to the dead branch → undefined

    // condition TRUE → both T and D live; the join composes both.
    const both = await runDag(workflow, { flag: true });
    expect(propsOf(both.outputs.J).t).toBe('test.T');
    expect(propsOf(both.outputs.J).d).toBe('test.D');
  });
});
