import type { DiffEntry, DiffResponse } from "@/api/client";
import * as irGraph from "@/lib/irGraph";

/** Per-side node diff status; `modified-old` renders on BASE, `modified-new` on HEAD. */
export type NodeDiffStatus = "unchanged" | "added" | "removed" | "modified-old" | "modified-new";

export interface NodeDiffStatusMaps {
  base: Record<string, NodeDiffStatus>;
  head: Record<string, NodeDiffStatus>;
}

export interface NodeParamChange {
  kind: "added" | "removed" | "modified";
  path: string;
  section: "parameters" | "credentials" | "position" | "name" | "type" | "other";
  oldValue?: unknown;
  newValue?: unknown;
}

export interface NodeDiffDetail {
  key: string;
  name: string;
  oldName?: string;
  /** Drawer-summary status — uses the simpler 3-state form. */
  status: "added" | "removed" | "modified" | "unchanged";
  positionDelta?: { dx: number; dy: number };
  changes: NodeParamChange[];
}

function classifyChange(entry: DiffEntry): NodeParamChange | null {
  if (!entry.path) return null;

  const path = entry.path;
  let section: NodeParamChange["section"] = "other";
  if (path.startsWith("parameters")) section = "parameters";
  else if (path.startsWith("credentials")) section = "credentials";
  else if (path.startsWith("position") || path === "position") section = "position";
  else if (path === "name") section = "name";
  else if (path === "node_type" || path === "type_version") section = "type";

  const hasOld = entry.old_value !== undefined && entry.old_value !== null;
  const hasNew = entry.new_value !== undefined && entry.new_value !== null;

  let kind: NodeParamChange["kind"];
  if (hasOld && !hasNew) kind = "removed";
  else if (!hasOld && hasNew) kind = "added";
  else kind = "modified";

  return {
    kind,
    path,
    section,
    oldValue: entry.old_value,
    newValue: entry.new_value,
  };
}

function nodeKey(entry: DiffEntry): string {
  return entry.target_name || entry.target_id;
}

/** Drawer detail for one node; null when there's nothing to show. */
export function buildNodeDiffDetail(diff: DiffResponse, key: string): NodeDiffDetail | null {
  // Entries key a renamed node by its NEW name, but a BASE-canvas click passes the OLD one — normalize
  // through the renames map or the base-side click finds nothing.
  const renamedTo = diff.renames?.find((r) => r.old_name === key)?.new_name;
  const lookupKey = renamedTo ?? key;
  const entries = diff.entries.filter((e) => e.operation.endsWith("_node") && nodeKey(e) === lookupKey);
  if (entries.length === 0) return null;

  let status: NodeDiffDetail["status"] = "unchanged";
  let positionDelta: { dx: number; dy: number } | undefined;
  let oldName: string | undefined;
  let displayName = key;
  const changes: NodeParamChange[] = [];

  for (const entry of entries) {
    if (entry.operation === "add_node") status = "added";
    else if (entry.operation === "remove_node") status = "removed";
    else if (entry.operation === "rename_node") {
      if (status === "unchanged") status = "modified";
      if (typeof entry.old_value === "string") oldName = entry.old_value;
      if (typeof entry.new_value === "string") displayName = entry.new_value;
      changes.push({
        kind: "modified",
        path: "name",
        section: "name",
        oldValue: entry.old_value,
        newValue: entry.new_value,
      });
    } else if (entry.operation === "modify_node") {
      if (entry.path === "position") {
        const ov = (entry.old_value ?? {}) as { x?: number; y?: number };
        const nv = (entry.new_value ?? {}) as { x?: number; y?: number };
        positionDelta = {
          dx: (nv.x ?? 0) - (ov.x ?? 0),
          dy: (nv.y ?? 0) - (ov.y ?? 0),
        };
      } else if (status === "unchanged") {
        status = "modified";
      }
      const change = classifyChange(entry);
      if (change) changes.push(change);
    }
  }

  return { key, name: displayName, oldName, status, positionDelta, changes };
}

export type EdgeDiffStatus = "unchanged" | "added" | "removed";

// A control char that can't appear in a node name, so `edgeKey("A","BC")` and `edgeKey("AB","C")` can't collide.
const EDGE_KEY_SEP = "\u0001";
function edgeKey(source: string, target: string): string {
  return `${source}${EDGE_KEY_SEP}${target}`;
}

interface ParsedNode {
  name: string;
  position: { x: number; y: number };
  type: string;
  parameters: Record<string, unknown>;
}

interface ParsedEdge {
  source: string;
  target: string;
}

// Index-keyed fallback name, so a nameless node resolves identically in parseNodes and parseEdges.
function nodeName(n: Record<string, unknown>, i: number): string {
  return (n.name as string) || `Node ${i}`;
}

/**
 * Parse a version's workflow_json into nodes keyed by display NAME — the same key the IR diff reports
 * ops under. Handles both shapes: IR (`{x,y}` position, `node_type`) and the legacy `[x,y]`/`type` graph.
 */
function parseNodes(json: Record<string, unknown> | undefined): Map<string, ParsedNode> {
  const out = new Map<string, ParsedNode>();
  const raw = (json?.nodes as Array<Record<string, unknown>>) ?? [];
  const isIr = irGraph.isIrDocument(json);
  raw.forEach((n, i) => {
    const name = nodeName(n, i);
    let position: { x: number; y: number };
    let type: string;
    if (isIr) {
      const pos = (n.position as { x?: number; y?: number }) || {};
      position = {
        x: typeof pos.x === "number" ? pos.x : 250 + i * 200,
        y: typeof pos.y === "number" ? pos.y : 300,
      };
      type = (n.node_type as string) || "";
    } else {
      const pos = Array.isArray(n.position) && n.position.length === 2 ? (n.position as number[]) : [250 + i * 200, 300];
      position = { x: pos[0], y: pos[1] };
      type = (n.type as string) || "";
    }
    out.set(name, { name, position, type, parameters: (n.parameters as Record<string, unknown>) || {} });
  });
  return out;
}

function parseEdges(json: Record<string, unknown> | undefined): ParsedEdge[] {
  const out: ParsedEdge[] = [];

  // IR edges carry node IDs, but the rest of the diff machinery keys by display name — resolve first.
  if (irGraph.isIrDocument(json)) {
    const rawNodes = (json!.nodes as Array<Record<string, unknown>>) ?? [];
    const idToName = new Map<string, string>();
    rawNodes.forEach((n, i) => {
      const name = nodeName(n, i);
      idToName.set((n.id as string) || name, name);
    });
    const rawEdges = (json!.edges as Array<Record<string, unknown>>) ?? [];
    for (const e of rawEdges) {
      const source = idToName.get(e.source_node_id as string);
      const target = idToName.get(e.target_node_id as string);
      if (source && target) out.push({ source, target });
    }
    return out;
  }

  // Legacy graph: a `connections` map keyed by source node name.
  const connections = (json?.connections as Record<string, { main?: Array<Array<{ node: string }>> }>) || {};
  for (const [source, conn] of Object.entries(connections)) {
    if (!conn?.main) continue;
    for (const port of conn.main) {
      if (!Array.isArray(port)) continue;
      for (const c of port) {
        if (typeof c?.node === "string") out.push({ source, target: c.node });
      }
    }
  }
  return out;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** A node as rendered on one side of the diff; ghosts are placeholders that keep the two canvases aligned. */
export interface UnifiedNode {
  name: string;
  position: { x: number; y: number };
  type: string;
  parameters: Record<string, unknown>;
  status: NodeDiffStatus;
  /** True = render as dashed placeholder. Status is informational only when set. */
  isGhost: boolean;
}

export interface UnifiedEdge {
  source: string;
  target: string;
  status: EdgeDiffStatus;
  /** True = render as faded dashed line; the edge doesn't exist on this side. */
  isGhost: boolean;
}

export interface UnifiedGraph {
  base: { nodes: UnifiedNode[]; edges: UnifiedEdge[] };
  head: { nodes: UnifiedNode[]; edges: UnifiedEdge[] };
}

// Suppress a ghost within this radius of a real node — roughly half a node's width, so a node replaced
// in-position doesn't render both new and ghost.
const GHOST_OVERLAP_PX = 80;

/**
 * Build a render-ready unified graph: each canvas gets its real content plus ghost placeholders for the
 * other side's exclusives. An edge renders only when both its endpoints exist on that side.
 */
export function buildUnifiedGraph(
  baseJson: Record<string, unknown> | undefined,
  headJson: Record<string, unknown> | undefined,
  diff: DiffResponse | null,
): UnifiedGraph {
  const baseNodes = parseNodes(baseJson);
  const headNodes = parseNodes(headJson);

  // `diff.renames` lets a renamed node render unified across both canvases instead of as remove+add.
  const renamedOldToNew = new Map<string, string>();
  const renamedNewToOld = new Map<string, string>();
  for (const r of diff?.renames ?? []) {
    if (r.old_name && r.new_name) {
      renamedOldToNew.set(r.old_name, r.new_name);
      renamedNewToOld.set(r.new_name, r.old_name);
    }
  }

  // Non-position changes only: a position-only change is already visible as the node's own offset.
  const modifiedNames = new Set<string>();
  if (diff) {
    const perNode = new Map<string, { ops: Set<string>; paths: Set<string> }>();
    for (const entry of diff.entries) {
      if (!entry.operation.endsWith("_node")) continue;
      const key = nodeKey(entry);
      if (!perNode.has(key)) perNode.set(key, { ops: new Set(), paths: new Set() });
      const bucket = perNode.get(key)!;
      bucket.ops.add(entry.operation);
      if (entry.path) bucket.paths.add(entry.path);
    }
    for (const [name, { ops, paths }] of perNode) {
      if (ops.has("add_node") || ops.has("remove_node")) continue;
      const nonPositionChange =
        ops.has("rename_node") || Array.from(paths).some((p) => !(p === "position" || p.startsWith("position.")));
      if (nonPositionChange) modifiedNames.add(name);
    }
  }

  const baseSide: UnifiedNode[] = [];
  const headSide: UnifiedNode[] = [];

  for (const [name, n] of baseNodes) {
    const inHead = headNodes.has(name);
    const renamedTo = renamedOldToNew.get(name);
    let status: NodeDiffStatus;
    if (inHead) {
      status = modifiedNames.has(name) ? "modified-old" : "unchanged";
    } else if (renamedTo) {
      status = "modified-old";
    } else {
      status = "removed";
    }
    baseSide.push({ ...n, status, isGhost: false });
  }

  for (const [name, n] of headNodes) {
    const inBase = baseNodes.has(name);
    const renamedFrom = renamedNewToOld.get(name);
    let status: NodeDiffStatus;
    if (inBase) {
      status = modifiedNames.has(name) ? "modified-new" : "unchanged";
    } else if (renamedFrom) {
      status = "modified-new";
    } else {
      status = "added";
    }
    headSide.push({ ...n, status, isGhost: false });
  }

  // Ghost on HEAD per base-only node, unless something already sits in its place. Renamed nodes are
  // skipped — their new-name counterpart already represents them.
  for (const [name, n] of baseNodes) {
    if (headNodes.has(name)) continue;
    if (renamedOldToNew.has(name)) continue;
    const tooClose = Array.from(headNodes.values()).some((h) => distance(h.position, n.position) < GHOST_OVERLAP_PX);
    if (tooClose) continue;
    headSide.push({ ...n, status: "removed", isGhost: true });
  }

  // Ghost on BASE per head-only node — same suppression rule.
  for (const [name, n] of headNodes) {
    if (baseNodes.has(name)) continue;
    if (renamedNewToOld.has(name)) continue;
    const tooClose = Array.from(baseNodes.values()).some((b) => distance(b.position, n.position) < GHOST_OVERLAP_PX);
    if (tooClose) continue;
    baseSide.push({ ...n, status: "added", isGhost: true });
  }

  // Includes ghosts, so an edge between two ghosts still renders and the missing structure stays visible.
  const baseEndpoints = new Set(baseSide.map((n) => n.name));
  const headEndpoints = new Set(headSide.map((n) => n.name));

  // Edge identity is canonical = HEAD-side names, so a renamed node's edges match across sides instead
  // of reading as one removed + one added. BASE inverts the rename; HEAD is already canonical.
  const toBase = (name: string) => renamedNewToOld.get(name) ?? name;
  const toHead = (name: string) => renamedOldToNew.get(name) ?? name;
  const baseByCanon = new Map<string, ParsedEdge>();
  for (const e of parseEdges(baseJson)) baseByCanon.set(edgeKey(toHead(e.source), toHead(e.target)), e);
  const headByCanon = new Map<string, ParsedEdge>();
  for (const e of parseEdges(headJson)) headByCanon.set(edgeKey(e.source, e.target), e);

  // One pass over the union: per side an edge is either real or a ghost projected from the other side.
  const baseEdges: UnifiedEdge[] = [];
  const headEdges: UnifiedEdge[] = [];
  const pushIfWired = (out: UnifiedEdge[], ends: Set<string>, edge: UnifiedEdge) => {
    if (ends.has(edge.source) && ends.has(edge.target)) out.push(edge);
  };
  for (const canon of new Set([...baseByCanon.keys(), ...headByCanon.keys()])) {
    const inBase = baseByCanon.has(canon);
    const inHead = headByCanon.has(canon);
    const headEdge = headByCanon.get(canon);
    const baseEdge = baseByCanon.get(canon);

    // Real in BASE spelling if present, else a ghost of the head-only edge projected back to BASE names.
    const baseSpelled = baseEdge ?? { source: toBase(headEdge!.source), target: toBase(headEdge!.target) };
    pushIfWired(baseEdges, baseEndpoints, {
      ...baseSpelled,
      status: inBase ? (inHead ? "unchanged" : "removed") : "added",
      isGhost: !inBase,
    });

    // Real in canonical spelling if present, else a ghost of the base-only edge projected to HEAD names.
    const headSpelled = headEdge ?? { source: toHead(baseEdge!.source), target: toHead(baseEdge!.target) };
    pushIfWired(headEdges, headEndpoints, {
      ...headSpelled,
      status: inHead ? (inBase ? "unchanged" : "added") : "removed",
      isGhost: !inHead,
    });
  }

  return {
    base: { nodes: baseSide, edges: baseEdges },
    head: { nodes: headSide, edges: headEdges },
  };
}

/** Top-line counters used by the diff page header chip row. */
export function summarizeDiff(diff: DiffResponse): {
  added: number;
  removed: number;
  modified: number;
  edgeAdded: number;
  edgeRemoved: number;
} {
  let added = 0;
  let removed = 0;
  let edgeAdded = 0;
  let edgeRemoved = 0;
  const modifiedKeys = new Set<string>();

  for (const e of diff.entries) {
    if (e.operation === "add_node") added++;
    else if (e.operation === "remove_node") removed++;
    else if (e.operation === "modify_node" || e.operation === "rename_node") {
      modifiedKeys.add(nodeKey(e));
    } else if (e.operation === "add_edge") edgeAdded++;
    else if (e.operation === "remove_edge") edgeRemoved++;
  }
  return { added, removed, modified: modifiedKeys.size, edgeAdded, edgeRemoved };
}
