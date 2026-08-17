import { getNodeTypeLabel } from "@/lib/constants";

/** The canonical trigger node in a workflow doc — id "trigger", a native kind, or the app-trigger marker. */
export function findTriggerNode(
  nodes: Array<Record<string, unknown>> | null | undefined,
): Record<string, unknown> | null {
  if (!Array.isArray(nodes)) return null;
  return (
    nodes.find((n) => {
      const type = typeof n.node_type === "string" ? n.node_type : "";
      const meta = n.metadata as { trigger?: unknown } | undefined;
      return (
        n.id === "trigger" ||
        type === "orchestr:trigger" ||
        type === "orchestr:webhook" ||
        type === "orchestr:schedule" ||
        type === "orchestr:chat" ||
        type === "orchestr:tool_trigger" ||
        meta?.trigger === true
      );
    }) ?? null
  );
}

/** How a workflow starts, in plain words — one source for the canvas subtitle and the overview indicator. */
export function triggerKindLabel(nodeType: string | undefined): string {
  if (nodeType === "orchestr:webhook") return "Webhook";
  if (nodeType === "orchestr:schedule") return "Schedule";
  if (nodeType === "orchestr:chat") return "Chat";
  if (nodeType === "orchestr:tool_trigger") return "Called by another workflow";
  if (!nodeType || nodeType === "orchestr:trigger" || !nodeType.includes(".")) return "Manual start";
  return getNodeTypeLabel(nodeType);
}

/** True for the on-demand manual start — the only kind that never fires on its own. */
export function isManualTrigger(nodeType: string | undefined): boolean {
  return !nodeType || nodeType === "orchestr:trigger";
}
