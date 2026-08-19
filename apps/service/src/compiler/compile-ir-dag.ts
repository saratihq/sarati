import { DomainError } from '../common/domain-error';
import type { AgentProvider, DagAgentTool } from '../runtime/agent';
import { edgePortType, MAIN_PORT_TYPE, type IREdge, type IRNode, type WorkflowIR } from '../ir/models';
import type {
  DagAgentNode,
  DagCallWorkflowNode,
  DagForEachNode,
  DagNode,
  DagPlan,
  DagSwitchNode,
  DagWhileNode,
  Guard,
} from '../runtime/dag-plan';
import { isRecord } from '../common/json-util';
import { toDagCodeNode } from './code-node';
import {
  INTERNAL_ACTION_TYPE,
  PUBLIC_ACTION_TYPE,
  compileIfCondition,
  compileNativeCondition,
  isIfNode,
  isTriggerNode,
  makeTranslator,
  mapNode,
} from './compile-ir';

/**
 * The ONE compiler (slice 4) — lowers a `WorkflowIR` to a flat, deterministically
 * topo-sorted `DagPlan` where each node records its incoming `(source, port)` guards, so fan-in /
 * reconvergence / diamonds all work. Per-node payloads reuse `compile-ir.ts`'s helpers, so a node
 * compiles identically regardless of graph structure. Nested sub-graphs (error lanes, loop bodies,
 * agent tools) are peeled by `buildScopedDag` and compiled recursively. Unmapped types and cycles
 * are hard errors.
 */

// Structured loop node (slice 6 items-mode; while-mode). Its outgoing main edges
// split by `source_port`: BODY (0) feeds the per-round sub-graph, AFTER (1) is the continuation —
// mirroring IF's 0=then / 1=else convention, which the client builds to.
const ORCHESTR_LOOP = 'orchestr:loop';
const LOOP_BODY_PORT = 0;
const LOOP_AFTER_PORT = 1;
const DEFAULT_ITEM_VAR = 'item';

// IF generalized to N ways: an ordered `cases` array, first match wins. `source_port: i` is case
// `i`'s output and `source_port: cases.length` the default — flat, like IF (no nested scope).
const ORCHESTR_SWITCH = 'orchestr:switch';

// Durable tool-calling node. Its tools are the edges leaving it on `port_type: 'tool'`
// (invariant #14), peeled below out of the structural main flow onto the agent step's `tools[]`.
const ORCHESTR_AGENT = 'orchestr:agent';
export const AGENT_TOOL_PORT_TYPE = 'tool';
/** Error output: edges leaving a node on this lane. */
const ERROR_PORT_TYPE = 'error';
/** The lanes this compiler routes — an edge on any other lane reaches no step at all. */
export const ROUTED_PORT_TYPES: ReadonlySet<string> = new Set([
  MAIN_PORT_TYPE,
  ERROR_PORT_TYPE,
  AGENT_TOOL_PORT_TYPE,
]);
const ORCHESTR_CALL_WORKFLOW = 'orchestr:call_workflow';
const DEFAULT_AGENT_MAX_STEPS = 25;
// The hard loop cap must itself be capped — an unbounded `max_steps` is a fan-out vector, since
// each sub-workflow tool call spawns a nested run.
const MAX_AGENT_MAX_STEPS = 100;
const DEFAULT_AGENT_MODEL = { provider: 'claude' as AgentProvider, model: 'claude-opus-4-8' };
const AGENT_PROVIDERS: ReadonlySet<AgentProvider> = new Set(['openai', 'claude', 'gemini', 'mistral']);

/** The single loop-type predicate (mirrors `isIfNode`); the loop is a structured node with a nested body. */
function isLoopNode(node: IRNode): boolean {
  return node.node_type === ORCHESTR_LOOP;
}

/** The single agent-type predicate (mirrors `isIfNode`); its tools peel from `port_type:'tool'` edges. */
function isAgentNode(node: IRNode): boolean {
  return node.node_type === ORCHESTR_AGENT;
}

/** Which driver a loop uses: `items` (default) or `while`; an unknown mode fails loud. */
function loopModeOf(node: IRNode): 'items' | 'while' {
  const mode = node.parameters.mode;
  if (mode === undefined || mode === null || mode === 'items') return 'items';
  if (mode === 'while') return 'while';
  const shown = typeof mode === 'string' ? mode : typeof mode;
  throw new Error(`Loop "${node.name}" has an unknown mode "${shown}" — expected "items" or "while"`);
}

/** The single switch-type predicate (mirrors `isIfNode`); a flat N-way router, no nested scope. */
function isSwitchNode(node: IRNode): boolean {
  return node.node_type === ORCHESTR_SWITCH;
}

/**
 * Compile a `WorkflowIR` to a flat `DagPlan`.
 * @param enclosingWorkflowId Id of the workflow being compiled — a `orchestr:call_workflow` tool
 *   pointing at it is a hard error; undefined skips the check.
 */
export function compileWorkflowIrDag(ir: WorkflowIR, enclosingWorkflowId?: string): DagPlan {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const nameToId = new Map(ir.nodes.map((n) => [n.name, n.id]));
  const triggerIds = new Set(ir.nodes.filter(isTriggerNode).map((n) => n.id));
  // Original IR order — the load-bearing tie-break for the Kahn topo sort below.
  const irIndex = new Map(ir.nodes.map((n, i) => [n.id, i] as const));

  const mainEdges = ir.edges.filter(
    (e) => edgePortType(e) === MAIN_PORT_TYPE && byId.has(e.source_node_id) && byId.has(e.target_node_id),
  );

  // First main upstream per node — the `$json` referent, skipping IF/SWITCH (pure routers,
  // no data output) so `$json` inside a branch resolves to the nearest real data producer.
  const upstreamOf = new Map<string, string>();
  for (const e of mainEdges) {
    if (!upstreamOf.has(e.target_node_id)) upstreamOf.set(e.target_node_id, e.source_node_id);
  }
  const jsonReferent = (nodeId: string): string | undefined => {
    let current = upstreamOf.get(nodeId);
    for (let hops = 0; current !== undefined && hops < ir.nodes.length; hops++) {
      const upstreamNode = byId.get(current);
      if (!upstreamNode || (!isIfNode(upstreamNode) && !isSwitchNode(upstreamNode))) return current;
      current = upstreamOf.get(current);
    }
    return current;
  };

  const skipped = (id: string): boolean => triggerIds.has(id);
  const real = ir.nodes.filter((n) => !skipped(n.id));
  const realEdges = mainEdges.filter((e) => !skipped(e.source_node_id) && !skipped(e.target_node_id));
  const errorEdges = ir.edges.filter(
    (e) =>
      edgePortType(e) === ERROR_PORT_TYPE &&
      byId.has(e.source_node_id) &&
      byId.has(e.target_node_id) &&
      !skipped(e.source_node_id) &&
      !skipped(e.target_node_id),
  );
  // Agent tool edges (invariant #14): `port_type: 'tool'` binds the target as a tool.
  const toolEdges = ir.edges.filter(
    (e) =>
      edgePortType(e) === AGENT_TOOL_PORT_TYPE &&
      byId.has(e.source_node_id) &&
      byId.has(e.target_node_id) &&
      !skipped(e.source_node_id) &&
      !skipped(e.target_node_id) &&
      isAgentNode(byId.get(e.source_node_id)!),
  );
  const translatorFor = (nodeId: string): ((value: unknown) => unknown) =>
    makeTranslator(nameToId, triggerIds, jsonReferent(nodeId));

  return buildScopedDag(
    ir.name || 'workflow',
    real,
    realEdges,
    errorEdges,
    toolEdges,
    byId,
    irIndex,
    translatorFor,
    enclosingWorkflowId,
  );
}

/** Adjacency map source → targets, over the given edge set. */
function successorsOf(edges: IREdge[]): Map<string, string[]> {
  const succ = new Map<string, string[]>();
  for (const e of edges)
    succ.set(e.source_node_id, [...(succ.get(e.source_node_id) ?? []), e.target_node_id]);
  return succ;
}

/** Breadth-first reachable set from `starts` over an adjacency map (starts included). */
function reachable(starts: string[], succ: Map<string, string[]>): Set<string> {
  const seen = new Set<string>(starts);
  const queue = [...starts];
  while (queue.length > 0) {
    for (const next of succ.get(queue.shift()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * Compile ONE scope (the top-level flow, or a peeled sub-graph) into a `DagPlan`, recursing into
 * each nested sub-graph so lanes and bodies may nest arbitrarily. A sub-graph is what its entry
 * reaches MINUS anything already in the parent flow — it never steals a shared node, and
 * reconverging back into the main flow is a hard error.
 */
function buildScopedDag(
  id: string,
  nodes: IRNode[],
  mainEdges: IREdge[],
  errorEdges: IREdge[],
  toolEdges: IREdge[],
  byId: Map<string, IRNode>,
  irIndex: Map<string, number>,
  translatorFor: (nodeId: string) => (value: unknown) => unknown,
  enclosingWorkflowId: string | undefined,
): DagPlan {
  const present = new Set(nodes.map((n) => n.id));
  const scopeMain = mainEdges.filter((e) => present.has(e.source_node_id) && present.has(e.target_node_id));
  const scopeErr = errorEdges.filter((e) => present.has(e.source_node_id) && present.has(e.target_node_id));
  // Tool edges in THIS scope (invariant #14) — peeled below, so the target leaves the
  // structural flow entirely (never a standalone step, never reconverges).
  const scopeTool = toolEdges.filter((e) => present.has(e.source_node_id) && present.has(e.target_node_id));
  const toolTargets = new Set(scopeTool.map((e) => e.target_node_id));

  // ── Loop body edges (a loop node's `source_port: 0` outgoing main edges) ────────
  const loopIds = new Set(nodes.filter(isLoopNode).map((n) => n.id));
  const bodyEdges = scopeMain.filter(
    (e) => loopIds.has(e.source_node_id) && e.source_port === LOOP_BODY_PORT,
  );
  const bodyStartsByLoop = new Map<string, string[]>();
  const allBodyStarts = new Set<string>();
  for (const e of bodyEdges) {
    bodyStartsByLoop.set(e.source_node_id, [
      ...(bodyStartsByLoop.get(e.source_node_id) ?? []),
      e.target_node_id,
    ]);
    allBodyStarts.add(e.target_node_id);
  }
  const bodyEdgeIds = new Set(bodyEdges.map((e) => e.id));

  // ── The parent (structural) flow: everything reachable WITHOUT descending a loop
  //    body port or an error edge. ─────────────────────────────────────────────────
  const structuralMain = scopeMain.filter((e) => !bodyEdgeIds.has(e.id));
  const structuralSucc = successorsOf(structuralMain);
  // Sub-graph gathering follows main + error + tool edges, so a nested lane/agent inside a
  // body is pulled into that body and peeled by the recursion rather than orphaned.
  // `structuralSucc` stays main-only — the parent flow never descends an error edge.
  const fullSucc = successorsOf([...scopeMain, ...scopeErr, ...scopeTool]);
  const errorTargets = [...new Set(scopeErr.map((e) => e.target_node_id))];
  const hasStructPred = new Set(structuralMain.map((e) => e.target_node_id));
  // A body-start / error target / tool target belongs to its sub-graph, never a structural root.
  const mainRoots = nodes
    .map((n) => n.id)
    .filter(
      (nid) =>
        !hasStructPred.has(nid) &&
        !errorTargets.includes(nid) &&
        !allBodyStarts.has(nid) &&
        !toolTargets.has(nid),
    );
  const mainReachable = reachable(mainRoots, structuralSucc);

  // ── Peel loop bodies. Only STRUCTURAL loops of THIS scope peel here; a nested loop
  //    lands in its parent's body and is peeled when we recurse into it. ───────────
  const bodyIdsByLoop = new Map<string, Set<string>>();
  const allBodyLaneIds = new Set<string>();
  for (const [loopId, starts] of bodyStartsByLoop) {
    if (!mainReachable.has(loopId)) continue; // nested loop — peeled within its parent body
    for (const s of starts) {
      if (mainReachable.has(s)) {
        throw new Error(
          `Loop body must lead to dedicated steps, not one already in the main flow ("${byId.get(s)?.name ?? s}")`,
        );
      }
    }
    const bodyIds = new Set(
      [...reachable(starts, fullSucc)].filter((bid) => !mainReachable.has(bid) && bid !== loopId),
    );
    for (const bid of bodyIds) {
      if (allBodyLaneIds.has(bid)) {
        throw new Error(
          `Loop bodies overlap at "${byId.get(bid)?.name ?? bid}" — a step can belong to only one loop`,
        );
      }
      allBodyLaneIds.add(bid);
    }
    bodyIdsByLoop.set(loopId, bodyIds);
  }
  // A body must not merge back into the main flow: after-loop steps connect FROM the
  // loop's AFTER port, never from inside the body.
  for (const e of scopeMain) {
    if (allBodyLaneIds.has(e.source_node_id) && mainReachable.has(e.target_node_id)) {
      throw new Error(
        `Loop body must not merge back into the main flow ("${byId.get(e.target_node_id)?.name ?? e.target_node_id}") — connect after-loop steps to the loop's port ${LOOP_AFTER_PORT}`,
      );
    }
  }

  // ── Peel error lanes (only edges whose SOURCE is a structural node of THIS scope —
  //    an error edge from inside a body is compiled with that body). ───────────────
  const structErrorEdges = scopeErr.filter((e) => !allBodyLaneIds.has(e.source_node_id));
  const structErrorTargets = [...new Set(structErrorEdges.map((e) => e.target_node_id))];
  for (const t of structErrorTargets) {
    if (mainReachable.has(t)) {
      throw new Error(
        `Error output must lead to a dedicated handler step, not one already in the main flow ("${byId.get(t)?.name ?? t}")`,
      );
    }
  }
  const errorLaneIds = new Set(
    [...reachable(structErrorTargets, fullSucc)].filter(
      (eid) => !mainReachable.has(eid) && !allBodyLaneIds.has(eid),
    ),
  );

  // ── Peel agent tools (invariant #14). Only STRUCTURAL agents of THIS scope bind here;
  //    a tool target must be dedicated, like a loop body / error lane. ──────────────
  const toolTargetsByAgent = new Map<string, string[]>();
  const allToolLaneIds = new Set<string>();
  for (const e of scopeTool) {
    if (!mainReachable.has(e.source_node_id)) continue; // nested agent — peeled in its own scope
    const target = e.target_node_id;
    if (mainReachable.has(target) || allBodyLaneIds.has(target) || errorLaneIds.has(target)) {
      throw new Error(
        `Agent tool "${byId.get(target)?.name ?? target}" must be a dedicated node, not one already in the main flow or another branch`,
      );
    }
    toolTargetsByAgent.set(e.source_node_id, [...(toolTargetsByAgent.get(e.source_node_id) ?? []), target]);
    allToolLaneIds.add(target);
  }
  // A bound tool is a LEAF (invariant #14). The tool peel binds only the leaf, so an outgoing
  // main/error edge would orphan its target into an unconditional DAG root that fires detached
  // from the agent — reject it here rather than silently sweep it in.
  for (const e of [...scopeMain, ...scopeErr]) {
    if (allToolLaneIds.has(e.source_node_id)) {
      const toolName = byId.get(e.source_node_id)?.name ?? e.source_node_id;
      throw new DomainError(
        `Agent tool "${toolName}" cannot have an outgoing ${edgePortType(e)} edge — a tool is a leaf whose output returns to the agent, not a step in the flow. Remove the edge.`,
      );
    }
  }

  // ── Flatten the structural flow (loops become forEach placeholders) ────────────
  const structuralIds = new Set(
    nodes
      .map((n) => n.id)
      .filter((nid) => !allBodyLaneIds.has(nid) && !errorLaneIds.has(nid) && !allToolLaneIds.has(nid)),
  );
  const structuralNodes = nodes.filter((n) => structuralIds.has(n.id));
  const structuralEdges = structuralMain.filter(
    (e) => structuralIds.has(e.source_node_id) && structuralIds.has(e.target_node_id),
  );
  const dag = flattenDag(
    id,
    structuralNodes,
    structuralEdges,
    byId,
    irIndex,
    translatorFor,
    enclosingWorkflowId,
  );
  const nodeById = new Map(dag.nodes.map((n) => [n.id, n]));

  // ── Attach each loop's body sub-plan (recursively compiled; its roots ungated) ───
  for (const [loopId, bodyIds] of bodyIdsByLoop) {
    const loopNode = nodeById.get(loopId);
    if (!loopNode || (loopNode.kind !== 'forEach' && loopNode.kind !== 'while')) {
      throw new Error(`Loop node "${byId.get(loopId)?.name ?? loopId}" did not lower to a loop step`);
    }
    const bodyNodes = nodes.filter((n) => bodyIds.has(n.id));
    loopNode.body = buildScopedDag(
      `${id}#${loopId}:body`,
      bodyNodes,
      scopeMain,
      scopeErr,
      scopeTool,
      byId,
      irIndex,
      translatorFor,
      enclosingWorkflowId,
    );
  }

  // ── Attach each agent's bound tools (invariant #14) — the deferred tool-edge peel ──
  for (const [agentId, targets] of toolTargetsByAgent) {
    const agentNode = nodeById.get(agentId);
    if (!agentNode || agentNode.kind !== 'agent') {
      throw new Error(`Agent node "${byId.get(agentId)?.name ?? agentId}" did not lower to an agent step`);
    }
    agentNode.tools = targets.map((t) => buildAgentTool(byId.get(t)!, translatorFor(t), enclosingWorkflowId));
    // Names are already provider-legal; make the bound SET unique so no two tools collide.
    dedupeToolNames(agentNode.tools);
  }

  // ── Attach each source's error lane (recursively compiled; its roots ungated) ───
  for (const srcId of new Set(structErrorEdges.map((e) => e.source_node_id))) {
    const laneStarts = structErrorEdges
      .filter((e) => e.source_node_id === srcId)
      .map((e) => e.target_node_id);
    const laneIds = new Set([...reachable(laneStarts, fullSucc)].filter((lid) => errorLaneIds.has(lid)));
    const laneNodes = nodes.filter((n) => laneIds.has(n.id));
    const lane = buildScopedDag(
      `${id}#${srcId}:error`,
      laneNodes,
      scopeMain,
      scopeErr,
      scopeTool,
      byId,
      irIndex,
      translatorFor,
      enclosingWorkflowId,
    );

    const target = nodeById.get(srcId);
    if (
      !target ||
      (target.kind !== 'action' &&
        target.kind !== 'code' &&
        target.kind !== 'agent' &&
        target.kind !== 'callWorkflow')
    ) {
      throw new Error(
        `Error output leaves "${byId.get(srcId)?.name ?? srcId}", which isn't a step in the main flow`,
      );
    }
    target.onErrorBranch = lane;
  }

  return dag;
}

/**
 * Flatten a node/edge set into a `DagPlan`: attach each node's incoming `(source, port)` guards and
 * emit in deterministic Kahn topological order (tie-broken by IR index). Rejects cycles.
 */
function flattenDag(
  id: string,
  nodes: IRNode[],
  edges: IREdge[],
  byId: Map<string, IRNode>,
  irIndex: Map<string, number>,
  translatorFor: (nodeId: string) => (value: unknown) => unknown,
  enclosingWorkflowId: string | undefined,
): DagPlan {
  const present = new Set(nodes.map((n) => n.id));
  const guardsByTarget = new Map<string, Guard[]>();
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const adjacency = new Map<string, string[]>(nodes.map((n) => [n.id, []]));

  for (const e of edges) {
    if (!present.has(e.source_node_id) || !present.has(e.target_node_id)) continue;
    const guard: Guard = { source: e.source_node_id, port: e.source_port };
    const existing = guardsByTarget.get(e.target_node_id);
    if (existing) existing.push(guard);
    else guardsByTarget.set(e.target_node_id, [guard]);
    adjacency.get(e.source_node_id)!.push(e.target_node_id);
    indegree.set(e.target_node_id, (indegree.get(e.target_node_id) ?? 0) + 1);
  }

  // Always pop the ready node with the smallest IR index: the same IR must always yield
  // the same order (determinism is load-bearing).
  const ready = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: IRNode[] = [];
  while (ready.length > 0) {
    let pick = 0;
    for (let i = 1; i < ready.length; i++) {
      if ((irIndex.get(ready[i]!) ?? 0) < (irIndex.get(ready[pick]!) ?? 0)) pick = i;
    }
    const nodeId = ready.splice(pick, 1)[0]!;
    const node = byId.get(nodeId);
    if (node) order.push(node);
    for (const target of adjacency.get(nodeId) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  if (order.length !== nodes.length) {
    throw new Error('WorkflowIR has a cycle — cannot compile to a DAG RunPlan');
  }

  const dagNodes = order.map((node) =>
    buildDagNode(node, translatorFor(node.id), guardsByTarget.get(node.id) ?? [], enclosingWorkflowId),
  );
  return { id, nodes: dagNodes };
}

/** One IR node → one flat `DagNode`, reusing compile-ir.ts's per-node mapping. */
function buildDagNode(
  node: IRNode,
  translate: (value: unknown) => unknown,
  guards: Guard[],
  enclosingWorkflowId: string | undefined,
): DagNode {
  if (node.node_type === ORCHESTR_CALL_WORKFLOW) {
    return buildCallWorkflowNode(node, translate, guards, enclosingWorkflowId);
  }
  if (isLoopNode(node)) {
    return loopModeOf(node) === 'while'
      ? buildWhileNode(node, translate, guards)
      : buildForEachNode(node, translate, guards);
  }
  if (isAgentNode(node)) return buildAgentNode(node, translate, guards);
  if (isSwitchNode(node)) return buildSwitchNode(node, translate, guards);
  if (isIfNode(node)) {
    return { kind: 'if', id: node.id, condition: compileIfCondition(node, translate), guards };
  }
  // mapNode only ever emits action / code / delay / waitForEvent from IR (IF + switch +
  // loop are handled above; parallel has no IR source yet).
  const run = mapNode(node, translate);
  switch (run.kind) {
    case 'delay':
      return { ...run, guards };
    case 'waitForEvent':
      return { ...run, guards };
    case 'code':
      // Transpile (ts→js) + attach guards; the error lane is attached below.
      return toDagCodeNode(run, guards);
    case 'action':
      // `ActionNode` declares `onErrorBranch?: RunNode[]` (never set by mapNode — the lane is
      // attached later as a nested DagPlan), so reset that field to land on `DagActionNode`.
      return { ...run, onErrorBranch: undefined, guards };
    default:
      throw new Error(`Step "${node.name}" compiled to an unexpected control node — cannot flatten`);
  }
}

/**
 * Loop-Over-Items (slice 6) → a `DagForEachNode`; the body references `{{item}}` /
 * `{{itemIndex}}`. `body` is an empty placeholder — `buildScopedDag` peels and attaches the real one.
 */
function buildForEachNode(
  node: IRNode,
  translate: (value: unknown) => unknown,
  guards: Guard[],
): DagForEachNode {
  const rawItems = node.parameters.items;
  if (typeof rawItems !== 'string' || rawItems.trim() === '') {
    throw new Error(
      `Loop "${node.name}" needs an "items" expression resolving to an array (e.g. {{step.rows}})`,
    );
  }
  const items = translate(rawItems);
  if (typeof items !== 'string') {
    throw new Error(`Loop "${node.name}": "items" must be a single expression, not a structured value`);
  }
  const rawItemVar = node.parameters.item_var;
  const itemVar =
    typeof rawItemVar === 'string' && rawItemVar.trim() !== '' ? rawItemVar.trim() : DEFAULT_ITEM_VAR;
  return { kind: 'forEach', id: node.id, items, itemVar, body: { id: `${node.id}:body`, nodes: [] }, guards };
}

/**
 * Loop while-mode → a `DagWhileNode`; the condition is the same `{left, op, right}` shape
 * IF/Switch carry. `max_iterations` is REQUIRED and positive — the hard infinite-loop guard.
 */
function buildWhileNode(node: IRNode, translate: (value: unknown) => unknown, guards: Guard[]): DagWhileNode {
  const rawCondition = node.parameters.condition;
  if (rawCondition === null || typeof rawCondition !== 'object' || Array.isArray(rawCondition)) {
    throw new Error(
      `While loop "${node.name}" needs a "condition" object {left, op, right} (the same shape as an IF)`,
    );
  }
  const condition = compileNativeCondition(rawCondition, translate, `While loop "${node.name}" condition`);
  const rawMax = node.parameters.max_iterations;
  if (typeof rawMax !== 'number' || !Number.isInteger(rawMax) || rawMax <= 0) {
    throw new Error(
      `While loop "${node.name}" needs "max_iterations" — a positive integer cap (the required infinite-loop guard)`,
    );
  }
  return {
    kind: 'while',
    id: node.id,
    condition,
    maxIterations: rawMax,
    body: { id: `${node.id}:body`, nodes: [] },
    guards,
  };
}

/**
 * Switch → a `DagSwitchNode`: an ordered array of the same `{left, op, right}` conditions IF carries.
 * Case `i` routes on `source_port: i`, the default on `source_port: cases.length`. Flat, like IF.
 */
function buildSwitchNode(
  node: IRNode,
  translate: (value: unknown) => unknown,
  guards: Guard[],
): DagSwitchNode {
  const rawCases = node.parameters.cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new Error(
      `Switch "${node.name}" needs a non-empty "cases" array — each a condition {left, op, right}; case i routes on source_port i, the default on source_port cases.length`,
    );
  }
  const cases = rawCases.map((rawCase, i) => {
    if (rawCase === null || typeof rawCase !== 'object' || Array.isArray(rawCase)) {
      throw new Error(`Switch "${node.name}" case ${i} must be an object condition {left, op, right}`);
    }
    return {
      condition: compileNativeCondition(
        rawCase as Record<string, unknown>,
        translate,
        `Switch "${node.name}" case ${i}`,
      ),
    };
  });
  return { kind: 'switch', id: node.id, cases, guards };
}

/**
 * Agent → a `DagAgentNode`: system prompt, model, the bounded `max_steps` cap, and the
 * input expression. `tools` is an empty placeholder — `buildScopedDag` peels and attaches the real
 * descriptors from the `port_type:'tool'` edges (invariant #14).
 */
function buildAgentNode(node: IRNode, translate: (value: unknown) => unknown, guards: Guard[]): DagAgentNode {
  const p = node.parameters;
  const systemPrompt = typeof p.system_prompt === 'string' ? p.system_prompt : '';

  const rawModel = p.model;
  let model = DEFAULT_AGENT_MODEL;
  if (rawModel !== undefined && rawModel !== null) {
    if (typeof rawModel !== 'object' || Array.isArray(rawModel)) {
      throw new Error(`Agent "${node.name}" "model" must be an object { provider, model }`);
    }
    const m = rawModel as { provider?: unknown; model?: unknown };
    if (!AGENT_PROVIDERS.has(m.provider as AgentProvider)) {
      throw new Error(
        `Agent "${node.name}" has an unknown model provider "${String(m.provider)}" — expected openai/claude/gemini/mistral`,
      );
    }
    if (typeof m.model !== 'string' || m.model.trim() === '') {
      throw new Error(`Agent "${node.name}" "model.model" must be a non-empty model id`);
    }
    model = { provider: m.provider as AgentProvider, model: m.model };
  }

  // Bounded on BOTH sides: an unbounded cap is itself a fan-out vector.
  const rawMax = p.max_steps;
  let maxSteps = DEFAULT_AGENT_MAX_STEPS;
  if (rawMax !== undefined && rawMax !== null) {
    if (typeof rawMax !== 'number' || !Number.isInteger(rawMax) || rawMax <= 0) {
      throw new Error(`Agent "${node.name}" "max_steps" must be a positive integer (the hard loop cap)`);
    }
    if (rawMax > MAX_AGENT_MAX_STEPS) {
      throw new Error(
        `Agent "${node.name}" "max_steps" (${rawMax}) exceeds the ceiling of ${MAX_AGENT_MAX_STEPS} — lower it`,
      );
    }
    maxSteps = rawMax;
  }

  const rawInput = p.input;
  const input =
    typeof rawInput === 'string' && rawInput.trim() !== '' ? (translate(rawInput) as string) : undefined;
  const connectionId = p.connectionId;

  return {
    kind: 'agent',
    id: node.id,
    systemPrompt,
    model,
    maxSteps,
    ...(input !== undefined ? { input } : {}),
    ...(typeof connectionId === 'string' && connectionId ? { auth: { connectionId } } : {}),
    tools: [], // filled by buildScopedDag from the port_type:'tool' edges (invariant #14)
    guards,
  };
}

// Params that configure a tool NODE itself, never passed as base props to the tool call.
const TOOL_RESERVED_PARAMS = new Set(['tool_name', 'tool_description', 'connectionId', 'onError', 'retry']);

// A model-facing tool name must be a provider-legal identifier; 64 is the strictest cap
// (OpenAI/Mistral `^[a-zA-Z0-9_-]{1,64}$`), so one sanitized name round-trips all four providers.
// Execution is keyed by `actionId`, never this name, so remapping is safe.
const MODEL_TOOL_NAME_MAX = 64;
function sanitizeToolName(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_-]/g, '_') // illegal chars → `_`
    .replace(/_+/g, '_') // collapse repeats
    .slice(0, MODEL_TOOL_NAME_MAX); // truncate to the strictest provider cap
  return cleaned || 'tool'; // never empty (e.g. a name of only illegal chars)
}

// Two tools sanitizing to the same identifier would mis-resolve in the loop's by-name find and be
// rejected by every provider — the compile-time uniqueness guard invariant #14 relies on. Mutates in place.
function dedupeToolNames(tools: DagAgentTool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    let name = tool.name;
    for (let n = 2; seen.has(name); n++) {
      const suffix = `_${n}`;
      name = tool.name.slice(0, MODEL_TOOL_NAME_MAX - suffix.length) + suffix;
    }
    seen.add(name);
    tool.name = name;
  }
}

/**
 * The workflow an `orchestr:call_workflow` node targets — the ONE definition site of both target
 * guards, so the agent-tool path and the authored-step path can never disagree. Calling
 * ITSELF is an immediate infinite loop; the run-time depth guard is the backstop that also bounds
 * an indirect cycle (A→B→A).
 */
function calledWorkflowId(node: IRNode, enclosingWorkflowId: string | undefined): string {
  const raw = node.parameters.workflow_id;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new DomainError(`Call workflow "${node.name}" needs a workflow to call — pick one.`);
  }
  const workflowId = raw.trim();
  if (enclosingWorkflowId !== undefined && workflowId === enclosingWorkflowId) {
    throw new DomainError(
      `Call workflow "${node.name}" can't call its own workflow — that is an infinite loop. Point it at a different workflow.`,
    );
  }
  return workflowId;
}

/**
 * Lower a main-path `orchestr:call_workflow` to a runnable step. Its `input` parameters
 * become the child's firing event, so `{{trigger.<field>}}` inside the child reads them.
 */
function buildCallWorkflowNode(
  node: IRNode,
  translate: (value: unknown) => unknown,
  guards: Guard[],
  enclosingWorkflowId: string | undefined,
): DagCallWorkflowNode {
  const rawInput = node.parameters.input;
  const input = isRecord(rawInput) ? (translate(rawInput) as Record<string, unknown>) : {};
  return {
    kind: 'callWorkflow',
    id: node.id,
    workflowId: calledWorkflowId(node, enclosingWorkflowId),
    input,
    ...(node.parameters.onError === 'continue' ? { onError: 'continue' as const } : {}),
    guards,
  };
}

/**
 * Lower ONE bound tool node to a `DagAgentTool` descriptor (/§4): `orchestr:call_workflow`
 * becomes a sub-workflow tool, anything else an action tool whose params become the call's base props.
 */
function buildAgentTool(
  node: IRNode,
  translate: (value: unknown) => unknown,
  enclosingWorkflowId: string | undefined,
): DagAgentTool {
  const alias = typeof node.parameters.tool_name === 'string' ? node.parameters.tool_name.trim() : '';
  const description =
    typeof node.parameters.tool_description === 'string' ? node.parameters.tool_description : undefined;

  if (node.node_type === ORCHESTR_CALL_WORKFLOW) {
    const workflowId = calledWorkflowId(node, enclosingWorkflowId);
    return {
      kind: 'workflow',
      name: sanitizeToolName(alias || node.name || workflowId),
      workflowId,
      ...(description !== undefined ? { description } : {}),
    };
  }

  if (!PUBLIC_ACTION_TYPE.test(node.node_type) && !INTERNAL_ACTION_TYPE.test(node.node_type)) {
    throw new Error(`Agent tool "${node.name}" isn't a runnable action or sub-workflow (${node.node_type})`);
  }
  const baseProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.parameters)) {
    if (!TOOL_RESERVED_PARAMS.has(key)) baseProps[key] = value;
  }
  const connectionId = node.parameters.connectionId;
  return {
    kind: 'action',
    name: sanitizeToolName(alias || node.node_type),
    actionId: node.node_type,
    props: translate(baseProps) as Record<string, unknown>,
    ...(typeof connectionId === 'string' && connectionId ? { auth: { connectionId } } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}
