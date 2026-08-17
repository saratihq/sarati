import type { AgentProvider, DagAgentTool } from './agent';
import type { Condition } from './conditions';
import type { ActionNode, CodeNode, DelayNode, WaitForEventNode } from './run-plan';

/**
 * DagPlan — the FLAT general-DAG executable shape, and the ONE plan the runtime executes (ADR 0023
 * slice 4), emitted by both `compileWorkflowIrDag` and `runPlanToDag`. Control flow is expressed by
 * GUARDS over a deterministically topo-sorted node list, so a node reachable from N inflows appears
 * ONCE with N guards. Data flows by reference (`{{node.id}}`), never along edges — a guard carries
 * no payload.
 */

/**
 * A control-flow dependency on `source`'s output `port`. OR-join scheduling: a node runs when all
 * its guard sources are done AND ≥1 guard's port is live. Whether a port is conditional is read
 * from the SOURCE node's kind — the guard itself just records `(source, port)` verbatim.
 */
export interface Guard {
  /** id of the upstream `DagNode` this dependency points at. */
  source: string;
  /**
   * the upstream's output port — main = 0; IF then = 0, else = 1; a SWITCH's
   * ports are 0..N-1 for its N cases (in order) and N for the default/fallback.
   */
  port: number;
}

/** Run a provider action — `ActionNode`'s payload, with the ADR 0020 error lane as a nested `DagPlan`. */
export type DagActionNode = Omit<ActionNode, 'onErrorBranch'> & {
  guards: Guard[];
  /** ADR 0020 error lane, compiled as a nested sub-plan (empty guards at its roots). */
  onErrorBranch?: DagPlan;
};

/**
 * Run a code snippet (ADR 0027) — an executable leaf like an action. `language` is dropped because
 * the snippet is already transpiled to JS by the time it reaches the runtime.
 */
export type DagCodeNode = Omit<CodeNode, 'onErrorBranch' | 'language'> & {
  guards: Guard[];
  /** ADR 0020 error lane, compiled as a nested sub-plan (empty guards at its roots). */
  onErrorBranch?: DagPlan;
};

/** A conditional router carrying NO nested branches — its lanes are the guards on downstream nodes. */
export interface DagIfNode {
  kind: 'if';
  id: string;
  condition: Condition;
  guards: Guard[];
}

/**
 * An N-way conditional router — IF generalized: case `i` routes on port `i`, and the implicit port
 * `cases.length` is the default. Pure control flow, so like IF it produces no scope output.
 */
export interface DagSwitchNode {
  kind: 'switch';
  id: string;
  /** One condition per output port, in port order; first to evaluate true wins. */
  cases: { condition: Condition }[];
  guards: Guard[];
}

/** Per-item iteration; `body` runs in a real child scope, so it stays a nested sub-plan (ADR 0023). */
export interface DagForEachNode {
  kind: 'forEach';
  id: string;
  items: string;
  itemVar: string;
  body: DagPlan;
  guards: Guard[];
}

/**
 * Do-while iteration (ADR 0029) — the `mode: 'while'` driver of the same loop node, sharing
 * forEach's body peel and child scope. Round 1 always runs; `maxIterations` is the required hard
 * infinite-loop guard and reaching it stops cleanly, never with an error.
 */
export interface DagWhileNode {
  kind: 'while';
  id: string;
  /** Tested AFTER each round (do-while) against that round's child scope; loop on WHILE-true. */
  condition: Condition;
  /** Hard cap on rounds (a positive integer) — the infinite-loop guard; reaching it stops cleanly. */
  maxIterations: number;
  body: DagPlan;
  guards: Guard[];
}

/** Concurrent branches, each a real child scope — nested sub-plans for the same reason as `forEach`. */
export interface DagParallelNode {
  kind: 'parallel';
  id: string;
  branches: DagPlan[];
  guards: Guard[];
}

/**
 * A durable tool-calling AGENT (ADR 0045) — a work-bearing leaf producing `scope[id]` (an
 * `AgentResult`); its internal model + tool calls are durable steps, never separate DAG nodes.
 * `tools` is filled by `buildScopedDag`'s deferred peel of the `port_type:'tool'` edges (invariant #14).
 */
export interface DagAgentNode {
  kind: 'agent';
  id: string;
  systemPrompt: string;
  model: { provider: AgentProvider; model: string };
  /** Hard cap on model-call rounds (a positive integer) — the safety net (§7). */
  maxSteps: number;
  /** Input expression resolved to the first user message; OMITTED → the whole `scope.trigger` as JSON. */
  input?: string;
  /** Treat `input` as a VERBATIM message, skipping resolution — set only by the test-agent path,
   *  never by the compiler (an authored workflow always resolves). */
  inputLiteral?: boolean;
  /** Connection reference for the model call's auth (opaque; the transport injects the key). */
  auth?: unknown;
  /** The bound tools — peeled from `port_type:'tool'` edges (invariant #14), attached after flatten. */
  tools: DagAgentTool[];
  /** ADR 0020 error lane — run when the loop exhausts `max_steps` (§7); a nested sub-plan. */
  onErrorBranch?: DagPlan;
  guards: Guard[];
}

/**
 * Call another workflow as an ordinary STEP (ADR 0062) — a work-bearing leaf producing `scope[id]`
 * (the child's terminal output), run through the same seam that backs an agent's sub-workflow tool.
 * Only who decides to call differs: here the author wired it, so nothing bounds how often.
 */
export interface DagCallWorkflowNode {
  kind: 'callWorkflow';
  id: string;
  /** The workflow this step runs. */
  workflowId: string;
  /** The child's firing event (`{{trigger.<field>}}` inside it), resolved against the run scope. */
  input: Record<string, unknown>;
  onError?: 'continue';
  /** ADR 0020 error lane, compiled as a nested sub-plan (empty guards at its roots). */
  onErrorBranch?: DagPlan;
  guards: Guard[];
}

/** Durable delay (reuses `DelayNode`), flattened with guards. */
export type DagDelayNode = DelayNode & { guards: Guard[] };

/** Human-in-the-loop wait (reuses `WaitForEventNode`), flattened with guards. */
export type DagWaitForEventNode = WaitForEventNode & { guards: Guard[] };

export type DagNode =
  | DagActionNode
  | DagCodeNode
  | DagIfNode
  | DagSwitchNode
  | DagForEachNode
  | DagWhileNode
  | DagParallelNode
  | DagAgentNode
  | DagCallWorkflowNode
  | DagDelayNode
  | DagWaitForEventNode;

/** A flat, deterministically topo-sorted DAG of nodes (Kahn, tie-broken by IR order). */
export interface DagPlan {
  id: string;
  nodes: DagNode[];
}
