"use client";

import { memo, useEffect, useState, useMemo, useCallback, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
  Controls,
  MarkerType,
  applyNodeChanges,
  type Connection,
  type Node,
  type NodeChange,
  type Edge,
  type EdgeChange,
  type Viewport,
  useUpdateNodeInternals,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import WorkflowNodeComponent from "./WorkflowNode";
import { AddStepEdge, AppendGhostNode, EmptyStateNode } from "./AddStepAffordances";
import { getNodeColor, getNodeCategory, outputPortCount, DIFF_COLORS } from "@/lib/constants";
import { NODE_WIDTH } from "./WorkflowNode";
import { useNodeIcons } from "@/store/useNodeIcons";
import type { UnifiedEdge, UnifiedNode } from "@/lib/diffHelpers";

const nodeTypes = {
  workflowNode: WorkflowNodeComponent,
  addStepGhost: AppendGhostNode,
  addStepEmpty: EmptyStateNode,
};

// Tool-binding eligibility (invariant #14) — must stay in lockstep with the compiler's
// tool-edge peel, so an invalid wiring can't be drawn rather than being rejected at compile.
function isToolEligibleTarget(nodeType: string): boolean {
  return nodeType !== "orchestr:agent" && getNodeCategory(nodeType) === "action";
}

const edgeTypes = {
  addStep: AddStepEdge,
};

interface FlowCanvasProps {
  /** Regular mode — pass a workflow_json. Parsed internally (incrementally). */
  workflowJson?: Record<string, unknown> | null;
  /** IR mode — a WorkflowIR ({nodes, edges}); when it has nodes it wins over `workflowJson`. */
  workflowIr?: Record<string, unknown> | null;
  /** Drop the wrapper bg/border so the canvas blends with the page surface. */
  transparent?: boolean;
  /** Fixed pixel height. Default 350. Ignored when `fill` is true. */
  height?: number;
  /** When true, wrapper is height:100% (parent controls sizing). */
  fill?: boolean;
  /** Editor mode: move, wire port→port, and delete the selection. */
  editable?: boolean;
  onNodeMoved?: (name: string, x: number, y: number) => void;
  /** Drag-only mode: nodes move, but no connect / delete / add-step affordances. */
  movable?: boolean;
  onConnectNodes?: (source: string, target: string, port?: number, portType?: "main" | "error" | "tool") => void;
  onDeleteNodes?: (names: string[]) => void;
  onDeleteEdges?: (
    edges: { source: string; target: string; port?: number; portType?: "main" | "error" | "tool" }[],
  ) => void;
  /** Reports the current node selection (real nodes only) — powers copy/paste. */
  onSelectionChange?: (nodeIds: string[]) => void;
  /** Programmatic selection: each `selectNonce` bump selects exactly `selectNodeIds`. */
  selectNodeIds?: string[];
  selectNonce?: number;
  /** Splice "+" on a source→target edge (editor only, and only on a settled canvas). */
  onInsertBetween?: (source: string, target: string) => void;
  /** Trailing "+" off a leaf, or the empty-state card when the name is null. */
  onAppendAfter?: (nodeName: string | null) => void;
  /** Clicking empty canvas — used to close the inspector. */
  onCanvasClick?: () => void;
  /** Bump when the space around the canvas changes, so an editable canvas refits to its new footprint. */
  refitKey?: number;
  /** Pre-parsed diff mode — unified nodes/edges with ghosts. */
  preparsedNodes?: UnifiedNode[];
  preparsedEdges?: UnifiedEdge[];
  /** Name of the currently focused diff node — gets a ring. */
  highlightedNodeId?: string | null;
  /** Diff jump-to-node: the id names the target, the paired `focusNonce` bump re-triggers centering. */
  focusNodeId?: string | null;
  focusNonce?: number;
  /** Synced viewport (diff page split-scroll). */
  syncedViewport?: Viewport | null;
  onViewportChange?: (vp: Viewport) => void;
  onNodeClick?: (
    nodeId: string,
    nodeData: { name: string; type: string; parameters?: Record<string, unknown> },
  ) => void;
  /** Skip node entrance springs, for a settled canvas that would otherwise replay them on mount. */
  staticEntrance?: boolean;
}

// Applied via `style.stroke` (real CSS), so these follow the theme through the custom property.
const EDGE_STROKE = "var(--orchestr-edge)";
const EDGE_STROKE_PENDING = "var(--orchestr-edge-pending)";
// Must stay a literal: it is also handed to `markerEnd.color`, an SVG presentation attribute,
// which does not resolve CSS variables. Mid-grey reads on both the dark and light canvas.
const DIFF_EDGE_STROKE = "rgba(133, 133, 138, 0.75)";

// Bead dash cycles: both BEADS_* patterns below sum to a period of 12.
/**
 * Nodes added at runtime mount after React Flow's measurement pass, and RF only re-measures handle
 * bounds when told — without this a drag onto a fresh node finds no handle and the wire vanishes.
 */
function NodeInternalsSync({ signature }: { signature: string }) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    if (!signature) return;
    // Entries are "id#nodeType" (type included so handle-set changes retrigger).
    updateNodeInternals(signature.split("\u0000").map((entry) => entry.split("#")[0]!));
  }, [signature, updateNodeInternals]);
  return null;
}

const BEADS_FLOW = "0.1 11.9";

/** Stable edge id — identical for pending and confirmed so confirmation restyles in place. */
const edgeId = (source: string, target: string) => `e:${source}->${target}`;

/** `p{n}` → port n; undefined for the plain or error handle. THE parser for connect/delete/reconnect. */
function portFromHandle(sourceHandle?: string | null): number | undefined {
  const m = sourceHandle ? /^p(\d+)$/.exec(sourceHandle) : null;
  return m ? Number(m[1]) : undefined;
}

function beadEdge(source: string, target: string, kind: "confirmed" | "pending"): Edge {
  if (kind === "pending") {
    return {
      id: edgeId(source, target),
      source,
      target,
      type: "default",
      style: { stroke: EDGE_STROKE_PENDING, strokeWidth: 1.75, strokeDasharray: BEADS_FLOW, strokeLinecap: "round" },
    };
  }
  return {
    id: edgeId(source, target),
    source,
    target,
    type: "default",
    style: { stroke: EDGE_STROKE, strokeWidth: 2, strokeLinecap: "round" },
  };
}

interface RawGraphNode {
  name?: string;
  type?: string;
  position?: number[];
  parameters?: Record<string, unknown>;
}

type ConnectionMap = Record<string, { main?: Array<Array<{ node: string }>> }>;

function parseFromIR(ir: Record<string, unknown>, editable: boolean): { nodes: Node[]; edges: Edge[] } {
  const rawNodes = (ir.nodes as Array<Record<string, unknown>>) || [];
  const rawEdges = (ir.edges as Array<Record<string, unknown>>) || [];

  const nodes: Node[] = rawNodes.map((n, i) => {
    const pos = (n.position as { x?: number; y?: number }) || {};
    const nodeType = (n.node_type as string) || "";
    const name = (n.name as string) || `Node ${i}`;
    return {
      id: (n.id as string) || name,
      type: "workflowNode",
      position: {
        x: typeof pos.x === "number" ? pos.x : 250 + i * 260,
        y: typeof pos.y === "number" ? pos.y : 300,
      },
      data: {
        label: name,
        color: getNodeColor(nodeType),
        // App triggers are triggers by `metadata.trigger` marker, not by type name.
        category: (n.metadata as { trigger?: unknown } | undefined)?.trigger === true ? "trigger" : getNodeCategory(nodeType),
        nodeType,
        parameters: (n.parameters as Record<string, unknown>) || {},
        connectable: editable,
      },
    };
  });

  // Multi-port control nodes wire through named `p{n}` handles. The count must come from the SAME
  // outputPortCount the renderer draws to, or edges land on handles the node never shows.
  const multiPortIds = new Set(
    rawNodes
      .filter(
        (n) =>
          outputPortCount(String(n.node_type ?? ""), n.parameters as Record<string, unknown> | undefined) > 1,
      )
      .map((n) => String(n.id ?? "")),
  );
  const edges: Edge[] = [];
  const seenKeys = new Set<string>();
  for (const e of rawEdges) {
    const source = (e.source_node_id as string) || "";
    const target = (e.target_node_id as string) || "";
    // Error and tool edges key on port_type so neither collapses with a
    // main edge between the same pair of nodes.
    const isError = e.port_type === "error";
    const isTool = e.port_type === "tool";
    const fromMultiPort = multiPortIds.has(source);
    const port = fromMultiPort && typeof e.source_port === "number" ? e.source_port : 0;
    const key = isError
      ? `${source}#err->${target}`
      : isTool
        ? `${source}#tool->${target}`
        : `${source}#${port}->${target}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const edge = beadEdge(source, target, "confirmed");
    if (isError) {
      edge.id = `${edge.id}#err`;
      edge.sourceHandle = "err";
      edge.style = { ...edge.style, stroke: "rgba(239, 112, 112, 0.75)", strokeDasharray: "5 4" };
    } else if (isTool) {
      edge.id = `${edge.id}#tool`;
      edge.sourceHandle = "tool";
      edge.style = { ...edge.style, stroke: "rgba(122, 162, 247, 0.8)", strokeDasharray: "2 4" };
    } else if (fromMultiPort) {
      edge.id = `${edge.id}#p${port}`;
      edge.sourceHandle = `p${port}`;
    }
    edges.push(edge);
  }

  return { nodes, edges };
}

function hasIrNodes(ir: Record<string, unknown> | null | undefined): boolean {
  return Array.isArray(ir?.nodes) && (ir!.nodes as unknown[]).length > 0;
}

// Diff mode: solid strokes, arrows, status colors.
function styleForUnifiedEdge(e: UnifiedEdge): {
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
  arrow: boolean;
} {
  if (e.status === "added") {
    return e.isGhost
      ? { stroke: "rgba(85, 201, 138, 0.4)", strokeWidth: 1.5, strokeDasharray: "4 4", arrow: false }
      : { stroke: DIFF_COLORS.added, strokeWidth: 2, arrow: true };
  }
  if (e.status === "removed") {
    return e.isGhost
      ? { stroke: "rgba(239, 112, 112, 0.4)", strokeWidth: 1.5, strokeDasharray: "4 4", arrow: false }
      : { stroke: DIFF_COLORS.removed, strokeWidth: 1.75, strokeDasharray: "6 4", arrow: false };
  }
  return { stroke: DIFF_EDGE_STROKE, strokeWidth: 1.75, arrow: true };
}

function buildFromUnified(unifiedNodes: UnifiedNode[], unifiedEdges: UnifiedEdge[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = unifiedNodes.map((n) => ({
    id: n.name,
    type: "workflowNode",
    position: n.position,
    data: {
      label: n.name,
      color: getNodeColor(n.type),
      category: getNodeCategory(n.type),
      nodeType: n.type,
      parameters: n.parameters,
      diffStatus: n.status,
      inDiffMode: true,
      isGhost: n.isGhost,
      highlighted: false,
    },
  }));

  const edges: Edge[] = unifiedEdges.map((e) => {
    const style = styleForUnifiedEdge(e);
    return {
      id: `${e.isGhost ? "ghost:" : ""}${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
      type: "default",
      style: { stroke: style.stroke, strokeWidth: style.strokeWidth, strokeDasharray: style.strokeDasharray },
      markerEnd: style.arrow ? { type: MarkerType.ArrowClosed, width: 15, height: 15, color: style.stroke } : undefined,
    };
  });

  return { nodes, edges };
}

// Memoized — parents re-render freely; unchanged props skip the whole parse.
const FlowCanvas = memo(function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
});

export default FlowCanvas;

function FlowCanvasInner({
  workflowJson,
  workflowIr,
  transparent = false,
  height = 350,
  fill = false,
  editable = false,
  onNodeMoved,
  movable = false,
  onConnectNodes,
  onDeleteNodes,
  onDeleteEdges,
  onSelectionChange,
  selectNodeIds,
  selectNonce,
  onInsertBetween,
  onAppendAfter,
  onCanvasClick,
  refitKey,
  preparsedNodes,
  preparsedEdges,
  highlightedNodeId,
  focusNodeId,
  focusNonce,
  syncedViewport,
  onViewportChange,
  onNodeClick,
  staticEntrance = false,
}: FlowCanvasProps) {
  const fetchIcons = useNodeIcons((s) => s.fetchIcons);
  const { fitView, setViewport, getViewport, setCenter } = useReactFlow();
  const rfStoreApi = useStoreApi();

  const usePreparsed = preparsedNodes !== undefined && preparsedEdges !== undefined;
  const useIr = !usePreparsed && hasIrNodes(workflowIr);

  // The gate keeps the "+" affordances off the diff and IR canvases, which own their node grammar.
  const showAddAffordances =
    editable && !usePreparsed && !useIr && (onInsertBetween !== undefined || onAppendAfter !== undefined);
  const canDrag = editable || movable;

  // Keyed on the raw node object, so unchanged nodes come back by reference and memo() bails.
  const nodeCacheRef = useRef(new WeakMap<object, Node>());
  // Same for edges, keyed by identity+kind across per-event parses.
  const edgeCacheRef = useRef(new Map<string, Edge>());

  const parsed = useMemo(() => {
    if (usePreparsed) return buildFromUnified(preparsedNodes!, preparsedEdges!);
    if (useIr) return parseFromIR(workflowIr!, editable);

    const rawNodes = (workflowJson?.nodes as RawGraphNode[]) ?? [];
    const connections = (workflowJson?.connections as ConnectionMap) ?? {};

    const cache = nodeCacheRef.current;
    const nodes: Node[] = rawNodes.map((raw, i) => {
      const name = raw.name ?? `Node ${i}`;
      const position =
        Array.isArray(raw.position) && raw.position.length === 2
          ? { x: raw.position[0], y: raw.position[1] }
          : { x: 250 + i * 260, y: 300 };

      const cached = cache.get(raw as object);
      if (cached && (cached.data as { connectable?: boolean }).connectable === editable) {
        if (cached.position.x === position.x && cached.position.y === position.y) return cached;
        const moved = { ...cached, position };
        cache.set(raw as object, moved);
        return moved;
      }
      const nodeType = raw.type ?? "";
      const built: Node = {
        id: name,
        type: "workflowNode",
        position,
        draggable: editable,
        data: {
          label: name,
          color: getNodeColor(nodeType),
          category: getNodeCategory(nodeType),
          nodeType,
          parameters: raw.parameters ?? {},
          staticEntrance,
          connectable: editable,
        },
      };
      cache.set(raw as object, built);
      return built;
    });

    // Deduped: an if/switch routing two branches to one target would otherwise emit a duplicate id.
    const edgeCache = edgeCacheRef.current;
    const edges: Edge[] = [];
    const seenPairs = new Set<string>();
    const pushEdge = (source: string, target: string, kind: "confirmed" | "pending") => {
      const cacheKey = `${edgeId(source, target)}|${kind}`;
      let edge = edgeCache.get(cacheKey);
      if (!edge) {
        edge = beadEdge(source, target, kind);
        edgeCache.set(cacheKey, edge);
      }
      edges.push(edge);
    };
    for (const [source, conn] of Object.entries(connections)) {
      for (const output of conn?.main ?? []) {
        if (!Array.isArray(output)) continue;
        for (const ref of output) {
          const pair = `${source}->${ref.node}`;
          if (seenPairs.has(pair)) continue;
          seenPairs.add(pair);
          pushEdge(source, ref.node, "confirmed");
        }
      }
    }

    return { nodes, edges };
  }, [
    usePreparsed,
    useIr,
    preparsedNodes,
    preparsedEdges,
    workflowIr,
    workflowJson,
    editable,
    staticEntrance,
  ]);

  // THE framing every editor re-fit uses.
  const refit = useCallback(
    (duration = 300) => fitView({ maxZoom: 0.9, padding: 0.22, duration }),
    [fitView],
  );

  // Refit when the workspace resizes, or the graph sits half-clipped under the new panel edge.
  const refitKeyRef = useRef(refitKey);
  useEffect(() => {
    if (refitKey === undefined || refitKey === refitKeyRef.current) return;
    refitKeyRef.current = refitKey;
    if (!editable || usePreparsed) return;
    // Delayed past the flex reflow, so React Flow has measured the new width.
    const t = window.setTimeout(() => refit(), 80);
    return () => window.clearTimeout(t);
  }, [refitKey, editable, usePreparsed, refit]);

  // Keep editor adds on camera: a new step lands right of the widest node, often off-viewport, where
  // it is invisible and a drag released on its covered handle pans instead of wiring.
  const knownIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const prev = knownIdsRef.current;
    const ids = new Set(parsed.nodes.map((n) => n.id));
    knownIdsRef.current = ids;
    // prev === null is the initial parse, which the mount-time fitView already frames.
    if (prev === null || !editable || usePreparsed) return;
    const fresh = parsed.nodes.filter((n) => !prev.has(n.id));
    if (fresh.length === 0) return;
    const { width, height } = rfStoreApi.getState();
    const vp = getViewport();
    const NODE_H = 56; // card height estimate — fresh nodes aren't measured yet
    const outOfView = fresh.some((n) => {
      const x = n.position.x * vp.zoom + vp.x;
      const y = n.position.y * vp.zoom + vp.y;
      return x < 0 || y < 0 || x + NODE_WIDTH * vp.zoom > width || y + NODE_H * vp.zoom > height;
    });
    if (outOfView) refit();
  }, [parsed, editable, usePreparsed, refit, getViewport, rfStoreApi]);

  // The "add step" affordances layer on top of `parsed`, leaving the node cache above untouched.
  const handleInsert = useCallback(
    (source: string, target: string) => onInsertBetween?.(source, target),
    [onInsertBetween],
  );
  const handleAppend = useCallback((nodeName: string) => onAppendAfter?.(nodeName), [onAppendAfter]);
  const handleAddFirst = useCallback(() => onAppendAfter?.(null), [onAppendAfter]);

  const withAffordances = useMemo(() => {
    if (!showAddAffordances) return parsed;

    // Empty graph: a single centered "add the first step" card, no edges.
    if (parsed.nodes.length === 0) {
      return {
        nodes: [
          {
            id: "__add_first__",
            type: "addStepEmpty",
            position: { x: 60, y: 260 },
            draggable: false,
            selectable: false,
            data: { onAdd: handleAddFirst },
          } as Node,
        ],
        edges: [],
      };
    }

    // Node names and which of them have an outgoing edge.
    const realNames = new Set(parsed.nodes.map((n) => n.id));
    const hasOutgoing = new Set<string>();
    for (const e of parsed.edges) if (realNames.has(e.source)) hasOutgoing.add(e.source);

    // Re-typed to `addStep` for the centered "+"; the bead style passes through so the wire is identical.
    const edges: Edge[] = parsed.edges.map((e) => {
      if (!realNames.has(e.source) || !realNames.has(e.target)) return e;
      return { ...e, type: "addStep", data: { edgeStyle: e.style, onInsert: handleInsert } };
    });

    // Trailing "+" off each leaf, one short hop right of the leaf card on its row.
    const ghosts: Node[] = [];
    for (const n of parsed.nodes) {
      if (hasOutgoing.has(n.id)) continue;
      ghosts.push({
        id: `__append__:${n.id}`,
        type: "addStepGhost",
        position: { x: n.position.x + NODE_WIDTH + 34, y: n.position.y + 14 },
        draggable: false,
        selectable: false,
        data: { after: n.id, onAppend: handleAppend },
      });
    }

    return { nodes: [...parsed.nodes, ...ghosts], edges };
  }, [parsed, showAddAffordances, handleInsert, handleAppend, handleAddFirst]);

  const allEdges = withAffordances.edges;

  // Diff highlight overlay — only re-allocates the two affected node objects.
  const allNodes = useMemo(() => {
    if (!usePreparsed) return withAffordances.nodes;
    return withAffordances.nodes.map((n) => {
      const shouldHighlight = highlightedNodeId === n.id;
      const data = n.data as { highlighted?: boolean };
      if (data.highlighted === shouldHighlight) return n;
      return { ...n, data: { ...n.data, highlighted: shouldHighlight } };
    });
  }, [withAffordances.nodes, highlightedNodeId, usePreparsed]);

  // React Flow stays authoritative over `rfNodes` so a drag tracks the cursor 1:1; a controlled
  // `nodes` prop fights the in-flight drag by a frame. Re-seeding is skipped mid-drag for that reason.
  const [rfNodes, setRfNodes] = useState<Node[]>(allNodes);
  const draggingRef = useRef(false);
  // Select-after-paste rides the same re-seed (not a second effect, to avoid an extra setState pass).
  const pasteNonceRef = useRef(selectNonce);
  useEffect(() => {
    if (draggingRef.current) return;
    const applyPaste =
      selectNonce !== undefined && selectNonce !== pasteNonceRef.current;
    if (applyPaste) pasteNonceRef.current = selectNonce;
    const pasted = applyPaste ? new Set(selectNodeIds ?? []) : null;
    setRfNodes((prev) => {
      const wasSelected = new Map(prev.map((n) => [n.id, Boolean(n.selected)]));
      return allNodes.map((n) => {
        if (pasted) return { ...n, selected: pasted.has(n.id) };
        return wasSelected.get(n.id) ? { ...n, selected: true } : n;
      });
    });
  }, [allNodes, selectNonce, selectNodeIds]);
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  // Synthetic "+" nodes aren't part of the workflow graph, so they never reach the selection report.
  const handleSelectionChange = useCallback(
    ({ nodes: selNodes }: { nodes: Node[] }) => {
      if (!onSelectionChange) return;
      onSelectionChange(
        selNodes
          .filter((n) => n.type !== "addStepGhost" && n.type !== "addStepEmpty")
          .map((n) => n.id),
      );
    },
    [onSelectionChange],
  );

  // Edges stay controlled + derived; selection is tracked here because a controlled RF drops its
  // own 'select' changes on re-derivation, and the delete key needs to find the selected wire.
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<Set<string>>(new Set());
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const sel = changes.filter((c): c is EdgeChange & { type: "select" } => c.type === "select");
    if (sel.length === 0) return;
    setSelectedEdgeIds((prev) => {
      const next = new Set(prev);
      for (const c of sel) {
        if (c.selected) next.add(c.id);
        else next.delete(c.id);
      }
      return next;
    });
  }, []);

  const visibleEdges = useMemo(() => {
    if (selectedEdgeIds.size === 0 && allEdges.every((e) => !e.selected)) return allEdges;
    let changed = false;
    const merged = allEdges.map((e) => {
      const selected = selectedEdgeIds.has(e.id);
      if (Boolean(e.selected) === selected) return e;
      changed = true;
      return { ...e, selected };
    });
    return changed ? merged : allEdges;
  }, [allEdges, selectedEdgeIds]);

  // Fetch icons for every node type in view; usually a cache hit from discovery-time prefetch.
  useEffect(() => {
    const types: string[] = [];
    if (usePreparsed) {
      for (const n of preparsedNodes ?? []) if (n.type) types.push(n.type);
    } else if (useIr) {
      const raw = (workflowIr?.nodes as Array<Record<string, unknown>>) || [];
      for (const n of raw) if (n.node_type) types.push(n.node_type as string);
    } else {
      for (const n of (workflowJson?.nodes as RawGraphNode[]) ?? []) if (n.type) types.push(n.type);
    }
    if (types.length > 0) fetchIcons(types);
  }, [usePreparsed, useIr, preparsedNodes, workflowIr, workflowJson, fetchIcons]);

  // Viewport sync (diff page).
  const VP_EPS = { pan: 0.5, zoom: 0.001 };
  const sameViewport = (a: Viewport, b: Viewport) =>
    Math.abs(a.x - b.x) < VP_EPS.pan && Math.abs(a.y - b.y) < VP_EPS.pan && Math.abs(a.zoom - b.zoom) < VP_EPS.zoom;

  const programmaticRef = useRef(false);
  const lastSyncedRef = useRef<Viewport | null>(null);
  useEffect(() => {
    if (!syncedViewport) return;
    if (sameViewport(getViewport(), syncedViewport)) return;
    programmaticRef.current = true;
    lastSyncedRef.current = syncedViewport;
    setViewport(syncedViewport, { duration: 0 });
    const raf = requestAnimationFrame(() => {
      programmaticRef.current = false;
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncedViewport, setViewport, getViewport]);

  const handleMove = useCallback(
    (_: unknown, vp: Viewport) => {
      if (programmaticRef.current) return;
      if (lastSyncedRef.current && sameViewport(vp, lastSyncedRef.current)) return;
      onViewportChange?.(vp);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onViewportChange],
  );

  // Diff jump-to-node; guarded by the nonce so unrelated re-renders don't re-center.
  const focusNonceRef = useRef(focusNonce);
  useEffect(() => {
    if (focusNonce === undefined || focusNonce === focusNonceRef.current) return;
    focusNonceRef.current = focusNonce;
    if (!focusNodeId) return;
    const node = allNodes.find((n) => n.id === focusNodeId);
    if (!node) return;
    const NODE_H = 56; // card-height estimate — matches the out-of-view heuristic above
    setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + NODE_H / 2, {
      zoom: getViewport().zoom,
      duration: 400,
    });
  }, [focusNonce, focusNodeId, allNodes, setCenter, getViewport]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (!onNodeClick) return;
      // "+" affordances have their own handlers and no label/type/parameters for the inspector.
      if (node.type === "addStepGhost" || node.type === "addStepEmpty") return;
      const data = node.data as {
        label: string;
        nodeType: string;
        parameters?: Record<string, unknown>;
        isGhost?: boolean;
      };
      if (data.isGhost) return; // diff ghost placeholders are inert
      onNodeClick(node.id, {
        name: data.label,
        type: data.nodeType,
        parameters: data.parameters,
      });
    },
    [onNodeClick],
  );

  const handleNodeDragStart = useCallback(() => {
    // Freezes the re-seed for the drag, so an unrelated graph update can't snap the node back.
    draggingRef.current = true;
  }, []);

  const handleNodeDragStop = useCallback(
    (_: MouseEvent | TouchEvent, node: Node) => {
      draggingRef.current = false;
      // Rounded to match the store's setNodePosition, which the re-seed then reads back.
      onNodeMoved?.(node.id, Math.round(node.position.x), Math.round(node.position.y));
    },
    [onNodeMoved],
  );

  // THE lane (port + port_type) reader, shared by connect, delete, and reconnect.
  const laneOf = (sourceHandle?: string | null) => ({
    port: portFromHandle(sourceHandle),
    portType:
      sourceHandle === "err"
        ? ("error" as const)
        : sourceHandle === "tool"
          ? ("tool" as const)
          : ("main" as const),
  });
  const connectLane = useCallback(
    (source: string, target: string, sourceHandle?: string | null) => {
      if (sourceHandle === "err") {
        onConnectNodes?.(source, target, 0, "error");
        return;
      }
      // The tool handle binds the target as a tool, never a step in the main flow.
      if (sourceHandle === "tool") {
        onConnectNodes?.(source, target, 0, "tool");
        return;
      }
      onConnectNodes?.(source, target, portFromHandle(sourceHandle) ?? 0);
    },
    [onConnectNodes],
  );

  const handleConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      connectLane(conn.source, conn.target, conn.sourceHandle);
    },
    [connectLane],
  );

  // Only the tool lane is restricted: an ineligible target is greyed mid-drag rather than 422-ing later.
  const isValidConnection = useCallback(
    (conn: Connection | Edge) => {
      if (conn.sourceHandle !== "tool") return true;
      if (!conn.target || conn.source === conn.target) return false;
      const target = rfNodes.find((n) => n.id === conn.target);
      const targetType = (target?.data as { nodeType?: string } | undefined)?.nodeType ?? "";
      return isToolEligibleTarget(targetType);
    },
    [rfNodes],
  );

  // Edge reconnection needs all three React Flow callbacks; the ref distinguishes "dropped on a
  // handle" (reroute) from "dropped on nothing" (detach).
  const reconnectOk = useRef(true);
  const handleReconnectStart = useCallback(() => {
    reconnectOk.current = false;
  }, []);
  const handleReconnect = useCallback(
    (oldEdge: Edge, conn: Connection) => {
      reconnectOk.current = true;
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      const old = laneOf(oldEdge.sourceHandle);
      onDeleteEdges?.([{ source: oldEdge.source, target: oldEdge.target, port: old.port, portType: old.portType }]);
      connectLane(conn.source, conn.target, conn.sourceHandle);
    },
    [connectLane, onDeleteEdges],
  );
  const handleReconnectEnd = useCallback(
    (_evt: unknown, edge: Edge) => {
      if (reconnectOk.current) return;
      const lane = laneOf(edge.sourceHandle);
      onDeleteEdges?.([{ source: edge.source, target: edge.target, port: lane.port, portType: lane.portType }]);
    },
    [onDeleteEdges],
  );

  const handleNodesDelete = useCallback(
    (deleted: Node[]) => {
      // Skip synthetic canvas nodes — the "+" affordances aren't part of the
      // workflow graph.
      const names = deleted
        .filter((n) => n.type !== "addStepGhost" && n.type !== "addStepEmpty")
        .map((n) => n.id);
      if (names.length > 0) onDeleteNodes?.(names);
    },
    [onDeleteNodes],
  );

  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      const pairs = deleted.map((e) => ({
        source: e.source,
        target: e.target,
        // Scoped to the wire's own port so deleting one Switch case can't take its siblings.
        port: portFromHandle(e.sourceHandle),
        // Scoped to its own lane so a main-edge delete can't remove a co-located error/tool edge.
        portType:
          e.sourceHandle === "err"
            ? ("error" as const)
            : e.sourceHandle === "tool"
              ? ("tool" as const)
              : ("main" as const),
      }));
      if (pairs.length > 0) onDeleteEdges?.(pairs);
    },
    [onDeleteEdges],
  );

  return (
    <div
      // The canvas surface is themed in globals.css: its SVG data-URI texture can't read a custom
      // property, so light/dark need separate declarations there rather than an inline background.
      className={`${fill && transparent ? "" : "rounded-2xl"} ${transparent ? "canvas-surface" : "canvas-inset"} relative overflow-hidden ${editable ? "flow-editable" : ""}`}
      style={{
        border: transparent ? "none" : "1px solid var(--orchestr-line)",
        height: fill ? "100%" : height,
      }}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={visibleEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={canDrag}
        nodesConnectable={editable}
        elementsSelectable={true}
        onNodesChange={canDrag ? onNodesChange : undefined}
        onEdgesChange={editable ? onEdgesChange : undefined}
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        fitView={!syncedViewport}
        fitViewOptions={{ maxZoom: 0.9, padding: 0.22 }}
        minZoom={0.3}
        maxZoom={2}
        onMove={handleMove}
        onNodeClick={handleNodeClick}
        onNodeDragStart={canDrag ? handleNodeDragStart : undefined}
        onNodeDragStop={canDrag ? handleNodeDragStop : undefined}
        onConnect={editable ? handleConnect : undefined}
        isValidConnection={editable ? isValidConnection : undefined}
        onReconnect={editable ? handleReconnect : undefined}
        onReconnectStart={editable ? handleReconnectStart : undefined}
        onReconnectEnd={editable ? handleReconnectEnd : undefined}
        onNodesDelete={editable ? handleNodesDelete : undefined}
        onEdgesDelete={editable ? handleEdgesDelete : undefined}
        onSelectionChange={editable ? handleSelectionChange : undefined}
        onPaneClick={onCanvasClick}
        proOptions={{ hideAttribution: true }}
      >
        <NodeInternalsSync
          signature={rfNodes
            .map((n) => {
              const d = n.data as { nodeType?: string; parameters?: Record<string, unknown> };
              // Port count must be in the signature: a Switch gaining a case changes its handle
              // count without changing its type, and unmeasured handles swallow wires.
              return `${n.id}#${d.nodeType ?? ""}#${outputPortCount(d.nodeType ?? "", d.parameters)}`;
            })
            .sort()
            .join("\u0000")}
        />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
