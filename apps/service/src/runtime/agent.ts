/**
 * The `orchestr:agent` runtime contract (ADR 0045 §1/§2) — the durable tool-calling loop's seams
 * and shapes, in ONE place so the compiler, the interpreter, and the model/tool providers agree.
 * Nothing here talks to a provider directly: everything goes through an injected port, keeping the
 * loop ours and every credential on the existing opaque-auth seam.
 */

/** The provider families the agent's model call supports (ADR 0044 set). */
export type AgentProvider = 'openai' | 'claude' | 'gemini' | 'mistral';

/** A permissive JSON-schema shape — the tool `parameters` the model call is handed. */
export type JsonSchema = Record<string, unknown>;

/** One message in the running conversation buffer; `system` is passed alongside, never buffered. */
export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool';
  /** Free-form text content (the user prompt, the model's prose, or a tool result rendered for the model). */
  content: string;
  /** Present on an `assistant` turn that requested tools — the calls it made (echoed back for context). */
  toolCalls?: ToolCall[];
  /** Present on a `tool` turn — which `ToolCall.id` this result answers. */
  toolCallId?: string;
}

/** A tool the model may call, as the model call receives it (name + description + JSON-schema params). */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** A tool invocation the model requested — normalized across providers. */
export interface ToolCall {
  /** Provider-assigned call id — threads the result back to this call in the next turn. */
  id: string;
  /** The tool name (`<slug>.<action>` / the node's alias) — resolved against the agent's bound tools. */
  name: string;
  /** The arguments the model produced for the tool (validated against the tool's schema by the provider). */
  input: unknown;
}

/** Aggregate token usage — summed across the loop's model calls. */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** One normalized model turn; an empty `toolCalls` is the natural final answer. */
export interface ModelTurn {
  text?: string;
  toolCalls: ToolCall[];
  usage?: Usage;
}

/** What the loop hands the model call each round (system + running buffer + the bound tools' schemas). */
export interface ModelCallRequest {
  provider: AgentProvider;
  model: string;
  system: string;
  messages: AgentMessage[];
  tools: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
}

/**
 * The auth context the model call resolves its credential from (ADR 0045 §5): the opaque connection
 * reference, the run's tenant (the lookup is user-scoped), and the run's env scope (ADR 0014). In an
 * env-scoped run the env slot WINS; `connection` is only the Default/manual override. The loop never
 * reads the raw key — only the SDK transport does (ADR 0042).
 */
export interface AgentModelAuth {
  /** The model's connection reference (opaque; `{ connectionId }` or an inline credential) — the Default/manual override. */
  connection: unknown;
  /** The run's tenant — scopes the connection credential lookup. */
  externalUserId: string;
  /** Env NAME (history) + the legacy pre-006 cluster key with `orgId`; null on a Default run. */
  environment?: string | null;
  /** ADR-0014 env slot key — resolves `(environmentId, <provider>)` to the env's model connection; null on a Default run. */
  environmentId?: string | null;
  /** The run's org — the legacy `(org, env, app)` cluster key with `environment`; null on a Default run. */
  orgId?: string | null;
}

/**
 * The tool-aware model-call seam (ADR 0045 §5) — a loop-internal engine primitive, NOT a catalog
 * action; the per-provider bodies live in the SDK's `callAgentModel`.
 */
export interface AgentModelPort {
  call(req: ModelCallRequest, auth: AgentModelAuth): Promise<ModelTurn>;
}

/** DI token for the tool-aware model call. Optional — unbound → the agent step fails loudly. */
export const AGENT_MODEL_CALL = Symbol('AGENT_MODEL_CALL');

/**
 * Optional seam describing an ACTION tool for the model call (ADR 0045 §4), derived from the
 * action's existing prop schema. Behind a seam so the pure runtime never imports the SDK catalog.
 */
export interface AgentToolCatalog {
  describeAction(actionId: string): { description: string; parameters: JsonSchema } | undefined;
}

/** DI token for the action-tool describer. Optional. */
export const AGENT_TOOL_CATALOG = Symbol('AGENT_TOOL_CATALOG');

/** A resolved sub-workflow tool invocation — the input the model produced for it. */
export interface SubWorkflowToolCall {
  /** The bound `orchestr:call_workflow` node's referenced workflow id. */
  workflowId: string;
  /** The arguments the model produced (seeded as the sub-run's initial scope). */
  input: unknown;
}

/**
 * Optional seam resolving a SUB-WORKFLOW tool through the engine's durable front door (ADR 0045 §3).
 * A port, not a direct import, because the runner sits above the interpreter — importing it would be
 * a module cycle. Unbound → the tool call returns a normalized error the agent can route around.
 */
export interface AgentSubWorkflowRunner {
  run(call: SubWorkflowToolCall, ctx: AgentSubWorkflowContext): Promise<unknown>;
}

/** The run identity a sub-workflow tool call inherits (tenant + env scoping). */
export interface AgentSubWorkflowContext {
  externalUserId: string;
  environment: string | null;
  environmentId: string | null;
  orgId: string | null;
  /** Parent run id — with `callKey`, the deterministic seed for the sub-run's id, so a crash-replay
   *  re-issues the SAME step idempotency keys (the SDK rail dedupes on them; Composio does not). */
  parentRunId: string;
  /** Run-stable per-tool-call key (the parent's durable tool step key). */
  callKey: string;
  /** The PARENT's call depth; the runner enters at `depth + 1` and rejects beyond the fixed cap. */
  depth: number;
  /** Shared mutable tree-wide invocation counter — bounds total fan-out breadth, which depth can't. */
  budget: { remaining: number };
  /** Parent-run dry-run flag (ADR 0041) — a preview parent runs the sub-workflow dry too. */
  dryRun: boolean;
}

// ─── Compiled tool descriptors (the compiler attaches these to a DagAgentNode) ───

/** An ACTION tool: an SDK/Composio action bound by a `port_type:'tool'` edge. */
export interface DagAgentActionTool {
  kind: 'action';
  /** Tool name the model calls — the node's alias, else `<slug>.<action>` (the actionId). */
  name: string;
  /** The action to run (`<slug>.<action>`). */
  actionId: string;
  /** Base props configured on the tool node; the model's call input overlays these. */
  props: Record<string, unknown>;
  /** Connection reference for the action's auth (opaque; the transport injects the key). */
  auth?: unknown;
  /** Author-supplied override description; else derived from the action catalog at run time. */
  description?: string;
}

/** A SUB-WORKFLOW tool (ADR 0045 §3): a bound `orchestr:call_workflow` node run nested by the runner. */
export interface DagAgentWorkflowTool {
  kind: 'workflow';
  name: string;
  /** The sub-workflow this tool runs. */
  workflowId: string;
  description?: string;
  /** The tool's declared input schema (from the sub-workflow's input contract); open by default in v1. */
  parameters?: JsonSchema;
}

export type DagAgentTool = DagAgentActionTool | DagAgentWorkflowTool;

/** A recorded step of one agent run (ADR 0045 §9) — one shape for both the trace and the SSE event. */
export interface AgentStep {
  /** 0-based position within THIS loop invocation — resets per invocation, so it is NOT the stream
   *  dedup key (the SSE channel dedups on its own session-unique `id`). */
  step_index: number;
  kind: 'model' | 'tool' | 'final';
  /** Present when `kind === 'tool'` — the resolved tool name. */
  tool?: string;
  /** Present when `kind === 'tool'` — the tool call input. */
  input?: unknown;
  /** Present when `kind === 'tool'` — the tool result (or normalized error). */
  output?: unknown;
  /** Present when `kind === 'model' | 'final'` — the model's text. */
  text?: string;
}

/** The agent node's output (ADR 0045 §8): deterministic reply + trace + aggregate usage. */
export interface AgentResult {
  text: string;
  steps: AgentStep[];
  usage: Usage;
  /** Set when `max_steps` was hit without a natural final answer — `text` is then a synthesized
   *  close-out from a final tool-less model pass (ADR 0045 §7), not a completion. */
  truncated?: boolean;
}

/**
 * The live step-stream seam (ADR 0045 §9) — best-effort and fire-and-forget: `publish` never blocks
 * the loop and a failure never affects the durable run (the trace `steps[]` is the source of truth).
 * Keyed by the SCOPED `workflow:env:session` channel key, never a bare session id, so a subscriber
 * and the run feeding it rendezvous only within the same tenant's `(workflow, env)`.
 */
export interface AgentStepSink {
  publish(channelKey: string, step: AgentStep): void;
}

/** DI token for the live step-stream sink. Optional — unbound → the loop publishes nothing. */
export const AGENT_STEP_SINK = Symbol('AGENT_STEP_SINK');

/**
 * Thrown when the loop hits `max_steps` without a natural final answer AND the node has an error
 * lane (ADR 0045 §7) — the hand-off path only; it carries the partial result so nothing is lost.
 */
export class AgentStepsExhausted extends Error {
  constructor(
    readonly maxSteps: number,
    /** The partial (truncated) agent output accumulated up to the cap — never discarded. */
    readonly result: AgentResult,
  ) {
    super(`Agent did not reach a final answer within max_steps (${maxSteps})`);
    this.name = 'AgentStepsExhausted';
  }
}
