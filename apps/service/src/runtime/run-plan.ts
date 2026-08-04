import type { Condition } from './conditions';

/**
 * RunPlan — the nested-TREE plan shape a client POSTs directly, deliberately separate from the
 * storage/diff `WorkflowIR`: that models the versioned graph, this models what to *execute*.
 * There is ONE engine, so a raw `RunPlan` is lowered to a `DagPlan` by `runPlanToDag` before it
 * runs. Nodes at one level run in order and may reference an earlier node's output via `{{nodeId.path}}`.
 */

/** Run a provider action — the executable leaf (a "step"). */
export interface ActionNode {
  kind: 'action';
  /** Unique id; other nodes reference this node's output as `{{<id>.path}}`. */
  id: string;
  /** The PUBLIC action type, `"<slug>.<action>"` (e.g. `"http.send_request"`). */
  actionId: string;
  /** Configured inputs; string values may embed `{{nodeId.path}}` refs to upstream outputs. */
  props: Record<string, unknown>;
  /** Connection credential when the action needs auth. */
  auth?: unknown;
  /** Per-node failure policy (ADR 0020); `"continue"` captures the error into scope and goes on.
   *  Absent ⇒ stop. Execution-time only; never in the doc. */
  onError?: 'continue';
  /** Per-node retry policy (ADR 0020) — retried INSIDE the one durable step, so a mid-retry throw
   *  is never memoised; exhausted retries fall through to `onError`. */
  retry?: { maxAttempts: number; backoffMs: number };
  /** ADR 0020 error lane, compiled from `port_type: 'error'` edges — WINS over `onError`, replaces
   *  the node's main successors, and ends the run after it. Never both lanes. */
  onErrorBranch?: RunNode[];
}

/**
 * Run a user-authored code snippet in a secure sandbox (ADR 0027): an async function body receiving
 * the run scope as `steps` (plus a `trigger` alias) whose return becomes the node's output.
 */
export interface CodeNode {
  kind: 'code';
  id: string;
  /** Source language of `code`; `ts` is transpiled to JS before it runs. */
  language: 'js' | 'ts';
  /** The snippet — an (async) function body that returns the node's output. */
  code: string;
  /** Per-node failure policy (ADR 0020); `"continue"` tolerates a throw. Absent ⇒ stop. */
  onError?: 'continue';
  /** Per-node retry policy (ADR 0020); the snippet re-runs up to `maxAttempts`. */
  retry?: { maxAttempts: number; backoffMs: number };
  /** ERROR OUTPUT (ADR 0020): the lane to run when the snippet fails; wins over `onError`. */
  onErrorBranch?: RunNode[];
}

/** Router / branch: run `then` when `condition` holds, else `else`. */
export interface IfNode {
  kind: 'if';
  id: string;
  condition: Condition;
  then: RunNode[];
  else?: RunNode[];
}

/** Iterate `items`, running `body` per element with `itemVar` (and `${itemVar}Index`) bound. */
export interface ForEachNode {
  kind: 'forEach';
  id: string;
  items: string;
  itemVar: string;
  body: RunNode[];
}

/** Fan-out: run every branch concurrently; their outputs merge back into scope. */
export interface ParallelNode {
  kind: 'parallel';
  id: string;
  branches: RunNode[][];
}

/** Durable delay: pause the run for `ms` (survives crash). Produces no output. */
export interface DelayNode {
  kind: 'delay';
  id: string;
  ms: number;
}

/** Human-in-the-loop: suspend durably until an event reaches `topic` or `timeoutMs` elapses
 *  (output = the delivered payload, `null` on timeout). */
export interface WaitForEventNode {
  kind: 'waitForEvent';
  id: string;
  topic: string;
  timeoutMs: number;
}

export type RunNode =
  ActionNode | CodeNode | IfNode | ForEachNode | ParallelNode | DelayNode | WaitForEventNode;

export interface RunPlan {
  id: string;
  nodes: RunNode[];
}

/** One executed action, in execution order (observability). `nodeId` includes the loop/branch path. */
export interface TraceEntry {
  nodeId: string;
  output: unknown;
  /** Non-fatal honesty notes from the action's rail — observational, the step still succeeded. */
  warnings?: string[];
}

export interface RunResult {
  planId: string;
  /** This run's handle — `GET /api/runs/:run_id` reads its status and per-step log. Absent on transient (unrecorded) runs. */
  run_id?: string;
  /** Final top-level scope: node id → output (a `forEach` node → array of per-iteration outputs). */
  outputs: Record<string, unknown>;
  /** Flat, ordered log of every action that ran. */
  trace: TraceEntry[];
}

/** A run that outlived its caller's bounded wait: it keeps going, and `GET /api/runs/:run_id` reports it. */
export interface RunHandle {
  run_id: string;
  status: 'running';
}

/** What a bounded run returns: the finished result, or a handle to poll (`status` is present only on the handle). */
export type RunOutcome = RunResult | RunHandle;

/** Status of a run — the shape polled via GET /api/runs/:runId. */
export interface RunStatus {
  runId: string;
  /** `waiting` = parked on a `waitForEvent` node (resume via POST /runs/:id/events);
   *  `cancelled` = terminated by the user (POST /runs/:id/cancel). */
  status: 'running' | 'waiting' | 'completed' | 'error' | 'cancelled' | 'not_found';
  /** Present when `completed`. */
  outputs?: Record<string, unknown>;
  /** Present when `error` — the terminal DBOS status or the run record's error. */
  error?: string;
  /** The per-step run-history log, when a record exists. */
  steps?: Array<Record<string, unknown>>;
  started_at?: string | null;
  finished_at?: string | null;
}
