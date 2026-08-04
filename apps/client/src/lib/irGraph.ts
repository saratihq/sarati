// Pure, structurally-sharing editors for WorkflowIR documents ({nodes, edges} arrays).
// The contract: a new top-level document, untouched entries kept by reference, and the SAME object back
// on a no-op — callers use identity to skip re-renders and dirty-marking. snake_case IS the wire shape.

export type IrDocument = Record<string, unknown>;

export interface IrNode {
  id: string;
  name?: string;
  node_type?: string;
  parameters?: Record<string, unknown>;
  position?: { x: number; y: number };
  [key: string]: unknown;
}

export interface IrEdge {
  id: string;
  source_node_id: string;
  source_port: number;
  target_node_id: string;
  target_port: number;
  port_type: string;
  [key: string]: unknown;
}

/** True when the doc is IR-shaped ({nodes, edges}) rather than the legacy {nodes, connections} graph. */
export function isIrDocument(doc: Record<string, unknown> | null | undefined): boolean {
  return Boolean(doc) && Array.isArray(doc!.nodes) && Array.isArray(doc!.edges);
}

export function getIrNodes(doc: IrDocument): IrNode[] {
  return Array.isArray(doc.nodes) ? (doc.nodes as IrNode[]) : [];
}

export function getIrEdges(doc: IrDocument): IrEdge[] {
  return Array.isArray(doc.edges) ? (doc.edges as IrEdge[]) : [];
}

export function countIrEdges(doc: IrDocument): number {
  return getIrEdges(doc).length;
}

/** The ONE definition site for a main edge's id, so a re-ported edge re-ids exactly as a fresh one. */
function mainEdgeId(sourceId: string, targetId: string, port: number): string {
  return port > 0 ? `e-${sourceId}-p${port}-${targetId}` : `e-${sourceId}-${targetId}`;
}

/**
 * Wire source → target on an output port. Idempotent per (source, port, target) — but a router may
 * legitimately wire MULTIPLE ports to one target, so only the full triple dedupes.
 */
export function addIrEdge(
  doc: IrDocument,
  sourceId: string,
  targetId: string,
  port = 0,
  portType: "main" | "error" | "tool" = "main",
): IrDocument {
  const edges = getIrEdges(doc);
  if (
    edges.some(
      (e) =>
        e.source_node_id === sourceId &&
        e.target_node_id === targetId &&
        (e.source_port ?? 0) === port &&
        (e.port_type ?? "main") === portType,
    )
  ) {
    return doc;
  }
  // An error/tool edge is DISTINCT from a main one, so its id carries `port_type` to avoid colliding
  // with a main edge between the same nodes (mirrors the server's edge key — invariant #4).
  const edge: IrEdge = {
    id:
      portType === "error"
        ? `e-${sourceId}-err-${targetId}`
        : portType === "tool"
          ? `e-${sourceId}-tool-${targetId}`
          : mainEdgeId(sourceId, targetId, port),
    source_node_id: sourceId,
    source_port: port,
    target_node_id: targetId,
    target_port: 0,
    port_type: portType,
  };
  return { ...doc, edges: [...edges, edge] };
}

/**
 * Renumber a node's outgoing MAIN ports after its port count shifts: `remap(port)` returning null DROPS
 * the wire, a number MOVES it and re-mints its id. Error/incoming edges are untouched.
 */
export function remapOutgoingMainPorts(
  doc: IrDocument,
  sourceId: string,
  remap: (port: number) => number | null,
): IrDocument {
  const edges = getIrEdges(doc);
  let changed = false;
  const next: IrEdge[] = [];
  for (const e of edges) {
    const isMain = (e.port_type ?? "main") === "main";
    if (e.source_node_id !== sourceId || !isMain) {
      next.push(e);
      continue;
    }
    const from = e.source_port ?? 0;
    const to = remap(from);
    if (to === null) {
      changed = true; // the port is gone — drop the wire rather than dangle it
      continue;
    }
    if (to === from) {
      next.push(e);
      continue;
    }
    changed = true;
    next.push({ ...e, source_port: to, id: mainEdgeId(sourceId, e.target_node_id, to) });
  }
  return changed ? { ...doc, edges: next } : doc;
}

/** Drop source → target edges: one port when given, ALL ports otherwise. Same object back when none exist. */
export function removeIrEdge(
  doc: IrDocument,
  sourceId: string,
  targetId: string,
  port?: number,
  portType?: "main" | "error" | "tool",
): IrDocument {
  const edges = getIrEdges(doc);
  const kept = edges.filter(
    (e) =>
      !(
        e.source_node_id === sourceId &&
        e.target_node_id === targetId &&
        (port === undefined || (e.source_port ?? 0) === port) &&
        (portType === undefined || (e.port_type ?? "main") === portType)
      ),
  );
  if (kept.length === edges.length) return doc;
  return { ...doc, edges: kept };
}

/** Append a node (no wiring — pair with addIrEdge). Position is the caller's. */
export function addIrNode(doc: IrDocument, node: IrNode): IrDocument {
  return { ...doc, nodes: [...getIrNodes(doc), node] };
}

/** Patch a node in place. `parameters` REPLACE wholesale — merging here would resurrect deleted keys. */
export function updateIrNode(
  doc: IrDocument,
  nodeId: string,
  patch: {
    name?: string;
    parameters?: Record<string, unknown>;
    node_type?: string;
    metadata?: Record<string, unknown>;
  },
): IrDocument {
  const nodes = getIrNodes(doc);
  const idx = nodes.findIndex((n) => n.id === nodeId);
  if (idx < 0) return doc;
  const next = [...nodes];
  next[idx] = {
    ...next[idx],
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.parameters !== undefined ? { parameters: patch.parameters } : {}),
    // A trigger node re-types in place when its kind changes; the node id (identity) is preserved.
    ...(patch.node_type !== undefined ? { node_type: patch.node_type } : {}),
    // App triggers need `metadata.trigger = true` for the service's isTriggerNode; merged, not replaced.
    ...(patch.metadata !== undefined
      ? { metadata: { ...((next[idx].metadata as Record<string, unknown>) ?? {}), ...patch.metadata } }
      : {}),
  };
  return { ...doc, nodes: next };
}

/** Remove a node plus every edge into or out of it. */
export function deleteIrNode(doc: IrDocument, nodeId: string): IrDocument {
  const nodes = getIrNodes(doc).filter((n) => n.id !== nodeId);
  const edges = getIrEdges(doc).filter((e) => e.source_node_id !== nodeId && e.target_node_id !== nodeId);
  return { ...doc, nodes, edges };
}
