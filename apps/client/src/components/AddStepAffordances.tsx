"use client";

import { memo } from "react";
import { Plus } from "lucide-react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";

// Edit-only "add step" affordances: FlowCanvas registers these types only on the editable canvas,
// so the diff and IR canvases keep their own edge/node language.

/** Shared "+" bubble — used by the edge splice button and the ghost nodes. */
function PlusBubble({ onClick, title, size = 22 }: { onClick: () => void; title: string; size?: number }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className="add-step-plus nodrag nopan flex items-center justify-center rounded-full cursor-pointer"
      style={{
        width: size,
        height: size,
        padding: 0,
        background: "var(--orchestr-surface-raised)",
        border: "1px solid var(--orchestr-line-strong)",
        color: "var(--orchestr-ink-muted)",
        boxShadow: "0 1px 4px rgba(0, 0, 0, 0.35)",
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Plus size={Math.round(size * 0.55)} strokeWidth={2.5} />
    </button>
  );
}

interface AddStepEdgeData {
  /** Same bead style the plain edge would have used — reused verbatim. */
  edgeStyle: React.CSSProperties;
  onInsert: (source: string, target: string) => void;
  [key: string]: unknown;
}

/** Edge plus a centered "+" that splices a node onto it; draws the plain edge's style verbatim. */
function AddStepEdgeComponent({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const d = data as AddStepEdgeData | undefined;

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={d?.edgeStyle} />
      <EdgeLabelRenderer>
        <div
          className="add-step-edge-label absolute"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
          }}
        >
          <PlusBubble
            title="Insert a step here"
            size={22}
            onClick={() => d?.onInsert(source, target)}
          />
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const AddStepEdge = memo(AddStepEdgeComponent);

interface AppendGhostData {
  /** The leaf node's name — the source we append after. */
  after: string;
  onAppend: (nodeName: string) => void;
  [key: string]: unknown;
}

/**
 * Trailing "+" off a leaf node — appends a wired step after it. The inert target Handle is required:
 * React Flow silently drops edges against a handle-less node.
 */
function AppendGhostNodeComponent({ data }: NodeProps) {
  const d = data as unknown as AppendGhostData;
  return (
    <div className="relative flex items-center justify-center" style={{ width: 28, height: 28 }}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0, pointerEvents: "none" }} isConnectable={false} />
      <PlusBubble title="Add a step" size={26} onClick={() => d.onAppend(d.after)} />
    </div>
  );
}

export const AppendGhostNode = memo(AppendGhostNodeComponent);

interface EmptyStateData {
  onAdd: () => void;
  [key: string]: unknown;
}

/** Centered empty-state card for a graph with no nodes. */
function EmptyStateNodeComponent({ data }: NodeProps) {
  const d = data as unknown as EmptyStateData;
  return (
    <button
      type="button"
      className="add-step-empty nodrag nopan flex flex-col items-center justify-center gap-2 rounded-xl cursor-pointer"
      style={{
        width: 220,
        padding: "22px 18px",
        background: "var(--orchestr-surface-card)",
        border: "1.5px dashed var(--orchestr-line-strong)",
        color: "var(--orchestr-ink-muted)",
      }}
      onClick={(e) => {
        e.stopPropagation();
        d.onAdd();
      }}
    >
      <span
        className="flex items-center justify-center rounded-full"
        style={{
          width: 34,
          height: 34,
          background: "var(--orchestr-surface-raised)",
          border: "1px solid var(--orchestr-line-strong)",
          color: "var(--orchestr-ink)",
        }}
      >
        <Plus size={18} strokeWidth={2.5} />
      </span>
      <span className="text-[12.5px] font-semibold" style={{ color: "var(--orchestr-ink)" }}>
        Add a trigger to start
      </span>
      <span className="text-[10.5px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
        Pick the event that kicks off your workflow
      </span>
    </button>
  );
}

export const EmptyStateNode = memo(EmptyStateNodeComponent);
