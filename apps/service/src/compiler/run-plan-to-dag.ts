import type {
  DagActionNode,
  DagCodeNode,
  DagForEachNode,
  DagIfNode,
  DagNode,
  DagParallelNode,
  DagPlan,
  Guard,
} from '../runtime/dag-plan';
import type { RunNode, RunPlan } from '../runtime/run-plan';
import { toDagCodeNode } from './code-node';

/**
 * Lower a nested-tree `RunPlan` (the raw, client-supplied shape) to a flat `DagPlan`, so there is
 * ONE runtime engine. The lowering re-expresses the tree's sequential semantics as guards: siblings
 * chain on the previous sibling's exit; `then`/`else` children gate on the IF's ports, and the node
 * after an IF OR-joins both lanes' exits (an EMPTY branch's exit is the IF's own port, so the
 * continuation still fires); child-scope bodies stay nested sub-plans with ungated roots.
 *
 * The emitted array is in topological order — which `DagInterpreter.schedule` relies on — because a
 * node is only appended after the siblings/branches it depends on.
 */
export function runPlanToDag(plan: RunPlan): DagPlan {
  return { id: plan.id, nodes: lowerList(plan.nodes, []).nodes };
}

/** A lowered fragment: its flat nodes, plus the guards representing "this fragment finished". */
interface Lowered {
  nodes: DagNode[];
  /** OR-join exits — a downstream node runs once when ANY of these is live. */
  exits: Guard[];
}

/**
 * Lower a sibling list under `entry` guards. The list's exits are the last sibling's, or `entry`
 * unchanged when empty — the pass-through that makes an empty branch still fire the node after it.
 */
function lowerList(nodes: RunNode[], entry: Guard[]): Lowered {
  const out: DagNode[] = [];
  let prevExits = entry;
  for (const node of nodes) {
    const lowered = lowerNode(node, prevExits);
    out.push(...lowered.nodes);
    prevExits = lowered.exits;
  }
  return { nodes: out, exits: prevExits };
}

/** Lower ONE tree node (recursing into its children) under its incoming `guards`. */
function lowerNode(node: RunNode, guards: Guard[]): Lowered {
  const exit: Guard[] = [{ source: node.id, port: 0 }];
  switch (node.kind) {
    case 'action': {
      const { onErrorBranch, ...rest } = node;
      const dagNode: DagActionNode = {
        ...rest,
        guards,
        ...(onErrorBranch && onErrorBranch.length > 0
          ? { onErrorBranch: { id: `${node.id}#error`, nodes: lowerList(onErrorBranch, []).nodes } }
          : {}),
      };
      return { nodes: [dagNode], exits: exit };
    }
    case 'code': {
      // Transpile ts→js and carry guards/onError/retry; the error lane lowers
      // to a nested sub-plan exactly like an action's.
      const { onErrorBranch } = node;
      const dagNode: DagCodeNode = {
        ...toDagCodeNode(node, guards),
        ...(onErrorBranch && onErrorBranch.length > 0
          ? { onErrorBranch: { id: `${node.id}#error`, nodes: lowerList(onErrorBranch, []).nodes } }
          : {}),
      };
      return { nodes: [dagNode], exits: exit };
    }
    case 'if': {
      const ifNode: DagIfNode = { kind: 'if', id: node.id, condition: node.condition, guards };
      const thenLane = lowerList(node.then, [{ source: node.id, port: 0 }]);
      const elseLane = lowerList(node.else ?? [], [{ source: node.id, port: 1 }]);
      return {
        nodes: [ifNode, ...thenLane.nodes, ...elseLane.nodes],
        // OR-join: the node after the IF runs when EITHER lane's exit is live.
        exits: [...thenLane.exits, ...elseLane.exits],
      };
    }
    case 'forEach': {
      const dagNode: DagForEachNode = {
        kind: 'forEach',
        id: node.id,
        items: node.items,
        itemVar: node.itemVar,
        body: { id: `${node.id}#body`, nodes: lowerList(node.body, []).nodes },
        guards,
      };
      return { nodes: [dagNode], exits: exit };
    }
    case 'parallel': {
      const dagNode: DagParallelNode = {
        kind: 'parallel',
        id: node.id,
        branches: node.branches.map((branch, i) => ({
          id: `${node.id}#branch${i}`,
          nodes: lowerList(branch, []).nodes,
        })),
        guards,
      };
      return { nodes: [dagNode], exits: exit };
    }
    case 'delay':
      return { nodes: [{ kind: 'delay', id: node.id, ms: node.ms, guards }], exits: exit };
    case 'waitForEvent':
      return {
        nodes: [{ kind: 'waitForEvent', id: node.id, topic: node.topic, timeoutMs: node.timeoutMs, guards }],
        exits: exit,
      };
  }
}
