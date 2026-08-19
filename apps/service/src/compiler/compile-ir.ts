import type { IRNode } from '../ir/models';
import type { Condition, CompareOp } from '../runtime/conditions';
import type { CodeNode, RunNode } from '../runtime/run-plan';

/**
 * Shared helpers for lowering a `WorkflowIR` to an executable plan, reused by the ONE compiler
 * (`compileWorkflowIrDag`) so a node compiles to the same payload regardless of graph structure.
 * Triggers compile AWAY: the runtime supplies the firing payload as `trigger` in the initial scope.
 */

// The built-in engine's control nodes: a branch whose parameters ARE the runtime condition,
// a durable wait-for-event, and a sandboxed code snippet.
const ORCHESTR_IF = 'orchestr:if';
const ORCHESTR_WAIT = 'orchestr:wait_for_event';
const ORCHESTR_CODE = 'orchestr:code';
const DEFAULT_WAIT_TIMEOUT_MS = 3_600_000; // 1h — approvals shouldn't park forever

/** The ONE IF-type predicate — never re-declare the type literal elsewhere. */
export function isIfNode(node: IRNode): boolean {
  return node.node_type === ORCHESTR_IF;
}

/**
 * The SINGLE definition of "which nodes are triggers" (vault) — the compiler and the trigger
 * reconciler both import THIS predicate; it is never re-declared. A node is a trigger if it is a
 * native canvas trigger kind, has a `*trigger`-suffixed type, or carries `metadata.trigger === true`.
 * That last marker is load-bearing: a catalog trigger is lexically identical to an action
 * (`gmail.new_email` vs `gmail.send_email`), and the moat rules forbid importing the trigger
 * catalog here, so the discriminator must be structural.
 */
export function isTriggerNode(
  node: Pick<IRNode, 'node_type'> & { metadata?: Record<string, unknown> },
): boolean {
  const type = node.node_type;
  if (type === ORCHESTR_WEBHOOK || type === ORCHESTR_SCHEDULE || type === ORCHESTR_CHAT) return true;
  if (/trigger$/i.test(type)) return true;
  return node.metadata?.trigger === true;
}

// The native canvas trigger kinds, spelled as literals rather than imported from
// src/triggers, which the moat rules forbid. The trigger layer's constants carry the SAME values
// and a compiler test guards that they stay in lockstep.
const ORCHESTR_WEBHOOK = 'orchestr:webhook';
const ORCHESTR_SCHEDULE = 'orchestr:schedule';
const ORCHESTR_CHAT = 'orchestr:chat';

/** Node types that map 1:1 to an action: the public `<app>.<action>` namespace. */
export const PUBLIC_ACTION_TYPE = /^[a-z][a-z0-9_-]*\.[\w.-]+$/;
/** The internal `@scope/pkg:action` action form (back-compat). */
export const INTERNAL_ACTION_TYPE = /^@[\w.-]+\/[\w.-]+:[\w.-]+$/;

// Retry caps — `parameters.retry` comes from the version doc, so clamp it here: a typo
// or hostile config must not loop forever or sleep for hours inside a step.
const RETRY_MAX_ATTEMPTS_CAP = 10;
const RETRY_BACKOFF_CAP_MS = 60_000;

/** Parse + clamp `parameters.retry` into an ActionNode retry policy; absent or ≤1 attempt ⇒ none. */
function retryPolicyOf(
  raw: unknown,
): { retry: { maxAttempts: number; backoffMs: number } } | Record<string, never> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as { maxAttempts?: unknown; backoffMs?: unknown };
  const attempts =
    typeof r.maxAttempts === 'number' && Number.isFinite(r.maxAttempts) ? Math.floor(r.maxAttempts) : 1;
  if (attempts <= 1) return {}; // 1 attempt = the ordinary single call — no retry
  const backoff = typeof r.backoffMs === 'number' && Number.isFinite(r.backoffMs) ? r.backoffMs : 0;
  return {
    retry: {
      maxAttempts: Math.min(attempts, RETRY_MAX_ATTEMPTS_CAP),
      backoffMs: Math.max(0, Math.min(backoff, RETRY_BACKOFF_CAP_MS)),
    },
  };
}

/** The ONE IR-node → RunNode payload mapping (retry caps, onError, connectionId) — never duplicate it. */
export function mapNode(node: IRNode, translate: (value: unknown) => unknown): RunNode {
  if (node.node_type === ORCHESTR_WAIT) {
    const topic =
      typeof node.parameters.topic === 'string' && node.parameters.topic ? node.parameters.topic : node.id;
    const rawTimeout = Number(node.parameters.timeout_ms);
    return {
      kind: 'waitForEvent',
      id: node.id,
      topic,
      timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_WAIT_TIMEOUT_MS,
    };
  }
  if (node.node_type === ORCHESTR_CODE) return buildCodeNode(node);
  if (PUBLIC_ACTION_TYPE.test(node.node_type) || INTERNAL_ACTION_TYPE.test(node.node_type)) {
    // Parameters ARE the props; `connectionId` becomes the checkpoint-safe auth reference, and the
    // Policy fields are destructured OUT so they never leak to the provider.
    const { connectionId, onError, retry, ...props } = node.parameters;
    return {
      kind: 'action',
      id: node.id,
      actionId: node.node_type,
      props: translate(props) as Record<string, unknown>,
      ...(typeof connectionId === 'string' && connectionId ? { auth: { connectionId } } : {}),
      ...(onError === 'continue' ? { onError: 'continue' as const } : {}),
      ...retryPolicyOf(retry),
    };
  }
  throw new Error(`Step "${node.name}" isn't runnable on this engine yet (${node.node_type})`);
}

/**
 * Lower an `orchestr:code` IR node to a `CodeNode`. `code` is RAW source, never
 * `translate`d — a snippet reads run data through its injected `steps`/`trigger`, not `{{ref}}`s.
 */
function buildCodeNode(node: IRNode): CodeNode {
  const rawCode = node.parameters.code;
  if (typeof rawCode !== 'string' || rawCode.trim() === '') {
    throw new Error(`Code node "${node.name}" needs a non-empty "code" snippet`);
  }
  const { onError, retry } = node.parameters;
  return {
    kind: 'code',
    id: node.id,
    language: node.parameters.language === 'ts' ? 'ts' : 'js',
    code: rawCode,
    ...(onError === 'continue' ? { onError: 'continue' as const } : {}),
    ...retryPolicyOf(retry),
  };
}

// ─── Condition lowering ───

const RUNTIME_OPS: ReadonlySet<CompareOp> = new Set([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'truthy',
  'falsy',
]);

/**
 * The ONE lowering of the native `{left, op, right}` shape into a runtime `Condition` — IF and
 * every switch case go through it, so a branch and a case are compiled identically. `label` names
 * the owning node in errors.
 */
export function compileNativeCondition(
  params: { left?: unknown; op?: unknown; right?: unknown },
  translate: (value: unknown) => unknown,
  label: string,
): Condition {
  const op = params.op;
  if (typeof op !== 'string' || !RUNTIME_OPS.has(op as CompareOp)) {
    throw new Error(`${label}: unsupported op "${String(op)}"`);
  }
  const condition: Condition = { left: translate(params.left ?? ''), op: op as CompareOp };
  if (op !== 'truthy' && op !== 'falsy') condition.right = translate(params.right ?? '');
  return condition;
}

/** Lower an IF node's condition — its parameters ARE the runtime `{left, op, right}` shape. */
export function compileIfCondition(node: IRNode, translate: (value: unknown) => unknown): Condition {
  return compileNativeCondition(node.parameters, translate, `IF node "${node.name}"`);
}

// ─── Expression translation ───

/**
 * Normalise param-value expressions: native `{{ref}}`s pass through untouched, the `$node`/`$json`
 * forms rewrite to `{{<id>.body.…}}` (or `{{trigger.…}}`), and a leading `=` is stripped. An
 * unknown node name is left untouched.
 */
export function makeTranslator(
  nameToId: Map<string, string>,
  triggerIds: Set<string>,
  upstreamId: string | undefined,
): (value: unknown) => unknown {
  const NODE_REF = /\{\{\s*\$node\["([^"]+)"\]\.json\.([\w.]+)\s*\}\}/g;
  const JSON_REF = /\{\{\s*\$json\.([\w.]+)\s*\}\}/g;

  const refFor = (id: string, path: string): string =>
    triggerIds.has(id) ? `{{trigger.${path}}}` : `{{${id}.body.${path}}}`;

  function translateString(raw: string): string {
    const expr = raw.startsWith('=') ? raw.slice(1) : raw;
    return expr
      .replace(NODE_REF, (match, name: string, path: string) => {
        const id = nameToId.get(name);
        return id ? refFor(id, path) : match;
      })
      .replace(JSON_REF, (match, path: string) => (upstreamId ? refFor(upstreamId, path) : match));
  }

  function translate(value: unknown): unknown {
    if (typeof value === 'string') return translateString(value);
    if (Array.isArray(value)) return value.map(translate);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) out[key] = translate(val);
      return out;
    }
    return value;
  }

  return translate;
}
