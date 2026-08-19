/**
 * The seam that runs one workflow inside another — shared by BOTH callers: an AI agent
 * picking a sub-workflow tool and an authored `orchestr:call_workflow` step. A port
 * rather than a direct import, because the runner sits above the interpreter and importing it would
 * be a module cycle. Unbound → the call fails with an honest error.
 */

/** A resolved sub-workflow invocation — the target and the input it runs on. */
export interface SubWorkflowCall {
  /** The `orchestr:call_workflow` node's referenced workflow id. */
  workflowId: string;
  /** The arguments the caller produced; they become the child's firing event. */
  input: unknown;
}

export interface SubWorkflowRunner {
  run(call: SubWorkflowCall, ctx: SubWorkflowContext): Promise<unknown>;
}

/** The run identity a sub-workflow call inherits (tenant + env scoping). */
export interface SubWorkflowContext {
  externalUserId: string;
  environment: string | null;
  environmentId: string | null;
  orgId: string | null;
  /** Parent run id — with `callKey`, the deterministic seed for the sub-run's id, so a crash-replay
   *  re-issues the SAME step idempotency keys (the SDK rail dedupes on them; Composio does not). */
  parentRunId: string;
  /** Run-stable per-call key (the parent's durable step key). */
  callKey: string;
  /** The PARENT's call depth; the runner enters at `depth + 1` and rejects beyond the fixed cap. */
  depth: number;
  /**
   * The tree-wide invocation counter, inherited by the nested run so every agent under it shares one
   * budget. Charged by the AGENT path only, where the number of calls is the model's choice — an
   * authored step's fan-out is the loop the author wrote.
   */
  budget: { remaining: number };
  /** Parent-run dry-run flag — a preview parent runs the sub-workflow dry too. */
  dryRun: boolean;
}
