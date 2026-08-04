import type { NodeParamSchema } from "@/api/client";

export function getNodeColor(_nodeType: string): string {
  // Brand identity comes from the node's icon, not a per-type color table.
  return "var(--orchestr-ink-muted)";
}

// ─── Condition operators ───
/** Plain-language operator labels — display only; the stored VALUE stays the raw op code. */
const OP_LABELS: Record<string, string> = {
  eq: "is equal to",
  ne: "is not equal to",
  gt: "is greater than",
  gte: "is greater than or equal to",
  lt: "is less than",
  lte: "is less than or equal to",
  contains: "contains",
  truthy: "is true",
  falsy: "is false",
};
export function opLabel(op: string): string {
  return OP_LABELS[op] ?? op;
}

/** The ONE predicate for which operators are unary (the engine drops their right operand). */
export function opDropsRight(op: string): boolean {
  return op === "truthy" || op === "falsy";
}

/** Catalog defaults → a node's starting parameters; ONE source for trigger re-typing and catalog adds. */
export function defaultParamsFromSchema(
  params?: Record<string, NodeParamSchema>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(params ?? {})) {
    const def = spec?.defaultValue ?? spec?.default;
    if (def !== undefined) out[k] = def;
  }
  return out;
}

export function getNodeCategory(nodeType: string): string {
  // Match the EXACT `orchestr:*` type, NEVER a substring — "spotify"/"slack.set_topic" merely CONTAIN
  // control-node words and are plain actions. Keep logically IDENTICAL to the server mirror
  // (`apps/service/src/compose/apply-ops.ts`), or the canvas guard and connect-op disagree.
  if (
    nodeType === "orchestr:trigger" ||
    nodeType === "orchestr:schedule" ||
    nodeType === "orchestr:chat" ||
    nodeType === "orchestr:webhook" ||
    nodeType === "orchestr:webhook_trigger"
  )
    return "trigger";
  // The AI Agent is action-like; named explicitly so it's never taken for a trigger or router.
  if (nodeType === "orchestr:agent") return "action";
  if (nodeType === "orchestr:if" || nodeType === "orchestr:switch" || nodeType === "orchestr:loop") return "logic";
  if (nodeType === "orchestr:code") return "transform";
  return "action";
}

/**
 * True when a node type legitimately has NO action-catalog row (control nodes, the trigger family, app
 * triggers), so its null lookup is expected. ONE predicate, or the deploy gate and the inspector's
 * broken-node banner disagree on which null-resolving nodes are actually broken.
 */
export function isNativeOrTriggerType(
  nodeType: string | undefined,
  metadata?: Record<string, unknown> | null,
): boolean {
  if (!nodeType) return true;
  if (nodeType.startsWith("orchestr:")) return true;
  if (/trigger$/i.test(nodeType)) return true;
  return (metadata as { trigger?: unknown } | undefined | null)?.trigger === true;
}

/** The two-port control nodes (IF then/else, Loop body/after) — one site, so renderer and edges agree. */
export function hasTwoOutputPorts(nodeType: string): boolean {
  return nodeType === "orchestr:if" || nodeType === "orchestr:loop";
}

/**
 * How many output handles a node exposes — THE source of truth for both the renderer and the edge
 * builder. A Switch is `cases.length + 1` (the last port is the default); a malformed `cases` still
 * yields at least 1, so a node never renders port-less.
 */
export function outputPortCount(nodeType: string, parameters?: Record<string, unknown>): number {
  if (nodeType === "orchestr:switch") {
    const cases = parameters?.cases;
    return (Array.isArray(cases) ? cases.length : 0) + 1;
  }
  if (hasTwoOutputPorts(nodeType)) return 2;
  return 1;
}

/** "gmail.send_message" → "Send message" — the quiet subtitle on node cards. */
export function getNodeTypeLabel(nodeType: string): string {
  // "AI Agent", not the bare "Agent" the generic colon-split would yield.
  if (nodeType === "orchestr:agent") return "AI Agent";
  // Control nodes label the part after the colon, not the raw type.
  if (nodeType.startsWith("orchestr:")) {
    const control = nodeType.slice("orchestr:".length).replace(/[_-]+/g, " ").trim();
    return control.charAt(0).toUpperCase() + control.slice(1);
  }
  const raw = nodeType.split(".").pop() ?? nodeType;
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ─── Diff palette ───
// Single source of truth for diff-status colors, imported by every diff surface.
export const DIFF_COLORS = {
  added: "var(--orchestr-success)", // success green — exists only on HEAD
  removed: "var(--orchestr-danger)", // danger red — exists only on BASE
  modifiedOld: "#d18b8b", // muted red — the pre-change version on BASE
  modifiedNew: "#d8c896", // amber — the post-change version on HEAD
  neutral: "var(--orchestr-line-strong)", // unchanged / ghost outline in diff mode
  accent: "var(--orchestr-ink-muted)", // edge/“edges” counter
} as const;

export type DiffColorKey = keyof typeof DIFF_COLORS;
