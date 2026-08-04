"use client";

import { memo } from "react";
import { motion } from "framer-motion";
import { Pin, Zap } from "lucide-react";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { DIFF_COLORS, getNodeTypeLabel, hasTwoOutputPorts, opDropsRight, opLabel, outputPortCount } from "@/lib/constants";
import { triggerKindLabel } from "@/lib/triggerKind";
import { pendingQuestionFor, useComposer } from "@/store/useComposer";
import { useStepSamples } from "@/store/useStepSamples";
import { ComposerConnectChip, QuestionChip } from "./ComposerBar";
import NodeIcon, { nodeIconKind } from "./NodeIcon";

type DiffStatus = "unchanged" | "added" | "removed" | "modified-old" | "modified-new";

interface WorkflowNodeData {
  label: string;
  color: string;
  category: string;
  nodeType: string;
  parameters?: Record<string, unknown>;
  diffStatus?: DiffStatus;
  /** True on the diff page (set by FlowCanvas whenever a status map is passed). */
  inDiffMode?: boolean;
  /** True = render as dashed placeholder. Status/color overrides skip. */
  isGhost?: boolean;
  /** True = skip the entrance animation (settled canvas mount, not a fresh reveal). */
  staticEntrance?: boolean;
  /** Edit mode: ports become connectable. */
  connectable?: boolean;
  highlighted?: boolean;
  [key: string]: unknown;
}

const MOUNT_SPRING = { type: "spring" as const, stiffness: 360, damping: 30, mass: 0.9 };

// Card geometry is fixed so the layout engine can reason about it.
export const NODE_WIDTH = 244;

// Per-status diff accents, derived from the shared DIFF_COLORS palette.
const DIFF_STYLES: Record<Exclude<DiffStatus, "unchanged">, { border: string; bg: string }> = {
  added: { border: DIFF_COLORS.added, bg: "var(--orchestr-success-tint)" },
  removed: { border: DIFF_COLORS.removed, bg: "var(--orchestr-danger-tint)" },
  "modified-old": { border: DIFF_COLORS.modifiedOld, bg: "rgba(209,139,139,0.08)" },
  "modified-new": { border: DIFF_COLORS.modifiedNew, bg: "rgba(216,200,150,0.10)" },
};

function badgeFor(status: DiffStatus): { symbol: string; color: string } | null {
  if (status === "added") return { symbol: "+", color: DIFF_COLORS.added };
  if (status === "removed") return { symbol: "−", color: DIFF_COLORS.removed };
  if (status === "modified-old") return { symbol: "~", color: DIFF_COLORS.modifiedOld };
  if (status === "modified-new") return { symbol: "~", color: DIFF_COLORS.modifiedNew };
  return null;
}

const PORT_OFF = {
  background: "transparent",
  border: "none",
  width: 8,
  height: 8,
  pointerEvents: "none" as const,
};

/** Tooltip for a Switch output handle (p{i}) — the last handle is the default, earlier ones are cases. */
function switchPortTitle(i: number, count: number, cases: unknown): string {
  if (i === count - 1) return "default — runs when no case matches";
  const list = Array.isArray(cases) ? cases : [];
  const c = (list[i] ?? {}) as { left?: unknown; op?: unknown; right?: unknown };
  const left = typeof c.left === "string" ? c.left.trim() : "";
  const op = typeof c.op === "string" ? c.op : "";
  const noRight = opDropsRight(op);
  const right = typeof c.right === "string" ? c.right.trim() : "";
  const cond = [left, op ? opLabel(op) : "", noRight ? "" : right].filter(Boolean).join(" ");
  return cond ? `case ${i + 1} — runs when ${cond}` : `case ${i + 1}`;
}

function GhostNode({ label }: { label: string }) {
  // The invisible handles are mandatory: React Flow silently drops edges that
  // reference a node without them.
  return (
    <div
      className="rounded-xl relative"
      style={{
        width: NODE_WIDTH,
        height: 56,
        background: "transparent",
        border: `2px dashed ${DIFF_COLORS.neutral}`,
      }}
      aria-label={`Placeholder for ${label}`}
    >
      <Handle type="target" position={Position.Left} style={PORT_OFF} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PORT_OFF} isConnectable={false} />
    </div>
  );
}

/** Card body shared by sketch and live nodes — icon tile left, name + type label right. */
function CardBody({
  label,
  nodeType,
  category,
  dimmed = false,
}: {
  label: string;
  nodeType: string;
  category: string;
  dimmed?: boolean;
}) {
  // getNodeCategory buckets the whole built-in trigger family as "trigger", so
  // the category alone is authoritative.
  const isTrigger = category === "trigger";
  // Trigger kind comes from the node itself (ADR 0018) — one definition site
  // shared with the overview's read-only indicator.
  const triggerSubtitle = triggerKindLabel(nodeType);
  // Glyphs need a chip behind them; an app logo brings its own tile, so it fills
  // the 36px slot directly rather than nesting inside a second chip.
  const iconKind = nodeIconKind(nodeType);
  return (
    <div className="flex items-center gap-3 px-3.5 py-3" style={{ opacity: dimmed ? 0.55 : 1 }}>
      {iconKind === "glyph" ? (
        <div
          className="w-[36px] h-[36px] rounded-[12px] flex items-center justify-center shrink-0"
          style={{
            background: "var(--orchestr-surface-raised)",
            border: "1px solid var(--orchestr-line)",
          }}
        >
          <NodeIcon nodeType={nodeType} size={20} />
        </div>
      ) : (
        <NodeIcon nodeType={nodeType} size={36} className="shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div
          className="text-[13px] font-semibold leading-[1.25] truncate"
          style={{ color: "var(--orchestr-ink)" }}
          title={label}
        >
          {label}
        </div>
        <div
          className="text-[10.5px] leading-[1.3] truncate flex items-center gap-1"
          style={{ color: "var(--orchestr-ink-subtle)" }}
        >
          {isTrigger && <Zap size={9} strokeWidth={2.5} className="shrink-0" />}
          {isTrigger ? triggerSubtitle : getNodeTypeLabel(nodeType)}
        </div>
      </div>
    </div>
  );
}

function WorkflowNodeComponent({ id, data, selected }: NodeProps) {
  // Handle bounds measured mid-entrance-spring land ~10px off and derail
  // drag-to-connect — re-measure once the spring settles.
  const updateNodeInternals = useUpdateNodeInternals();
  // Composer mirrors: the question chip and assumption badges render the same
  // state as the thread.
  const pinnedQuestion = useComposer((s) => pendingQuestionFor(s.questions, id));
  const nodeAssumptions = useComposer((s) => s.assumptions[id]);
  const stepResult = useComposer((s) => s.stepResults[id]);
  // Pinned for runs (ADR 0021): a Run replays this step's captured output
  // instead of executing it.
  const pinned = useStepSamples((s) => Boolean(s.pinned[id]));
  const connectionNeed = useComposer((s) => s.connectionNeeds[id]);
  const requestPrefill = useComposer((s) => s.requestPrefill);
  const {
    label,
    category,
    nodeType,
    parameters,
    diffStatus,
    inDiffMode,
    isGhost,
    staticEntrance,
    connectable,
    highlighted,
  } = data as unknown as WorkflowNodeData;

  if (isGhost) return <GhostNode label={label} />;

  const isTrigger = category === "trigger";
  const diffOverride = diffStatus && diffStatus !== "unchanged" ? DIFF_STYLES[diffStatus] : null;

  // The diff canvas is the only surface where the border carries color.
  const border = diffOverride
    ? `2px solid ${diffOverride.border}`
    : selected
      ? "1px solid rgb(var(--orchestr-chrome-rgb) / 0.45)"
      : inDiffMode
        ? `1px solid ${DIFF_COLORS.neutral}`
        : "1px solid rgb(var(--orchestr-chrome-rgb) / 0.16)";
  const bg = diffOverride?.bg ?? "var(--orchestr-surface-node)";

  const badge = diffStatus ? badgeFor(diffStatus) : null;
  const isClickable = Boolean(diffStatus === "modified-old" || diffStatus === "modified-new" || connectable);

  // IF and Loop share port geometry and ids (p0 = first, p1 = second); only the
  // labels differ.
  const twoPorts = hasTwoOutputPorts(nodeType);
  const isLoop = nodeType === "orchestr:loop";
  const port0Title = isLoop ? "body — runs once per item" : "then — runs when the condition holds";
  const port1Title = isLoop ? "after — runs once when the loop finishes" : "else — runs when it does not";
  // Switch handle count comes from the same outputPortCount the edge builder
  // reads, so drawn handles and wired ports never disagree.
  const isSwitch = nodeType === "orchestr:switch";
  const switchPortCount = isSwitch ? outputPortCount(nodeType, parameters) : 0;
  // The AI Agent (ADR 0045, invariant #14) adds a "tool" handle at its base
  // alongside the main and error outputs.
  const isAgent = nodeType === "orchestr:agent";

  return (
    <motion.div
      // Settled canvases skip the entrance so a remount doesn't replay every
      // node's spring at once.
      initial={staticEntrance ? false : { opacity: 0, scale: 0.9, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={MOUNT_SPRING}
      onAnimationComplete={() => updateNodeInternals(id)}
    >
      <div
        className={`rounded-xl relative ${isClickable ? "cursor-pointer" : ""}`}
        style={{
          width: NODE_WIDTH,
          background: bg,
          border,
          boxShadow: highlighted
            ? "0 0 0 3px var(--orchestr-ink)"
            : selected
              ? "0 0 0 3px var(--orchestr-accent-tint-strong)"
              : // Resting lift — keeps the card off the dark canvas backdrop.
                "0 1px 2px rgba(0,0,0,0.45), 0 8px 20px rgba(0,0,0,0.30)",
        }}
      >
        {badge && (
          <div
            className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-semibold leading-none z-10"
            style={{
              background: badge.color,
              color: "var(--orchestr-surface)",
              boxShadow: "0 0 0 2px var(--orchestr-surface)",
            }}
          >
            {badge.symbol}
          </div>
        )}
        {/* Run bead (A2): the latest test/run outcome for this step. */}
        {stepResult && !badge && (
          <span
            className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full z-10"
            style={{
              background: stepResult.status === "passed" ? "var(--orchestr-success)" : "var(--orchestr-danger)",
              boxShadow: "0 0 0 2px var(--orchestr-surface)",
            }}
            title={
              stepResult.summary ?? (stepResult.status === "passed" ? "Ran clean" : "Failed in the last run")
            }
            data-testid={`node-bead-${stepResult.status}`}
          />
        )}
        {/* Pin marker — a Run replays this step's data instead of executing it (ADR 0021). */}
        {pinned && (
          <span
            className="absolute -top-1 -left-1 w-3.5 h-3.5 rounded-full z-10 flex items-center justify-center"
            style={{ background: "var(--orchestr-surface)", boxShadow: "0 0 0 1.5px var(--orchestr-surface)" }}
            title="Pinned — a run replays this step's data and does not execute it"
            data-testid="node-pin"
          >
            <Pin size={9} style={{ color: "var(--orchestr-ai)" }} />
          </span>
        )}

        {/* Ports — triggers have no input side; branching control nodes expose two output handles. */}
        {!isTrigger && (
          <Handle type="target" position={Position.Left} className="wf-port" isConnectable={connectable ?? false} />
        )}
        <CardBody label={label} nodeType={nodeType} category={category} />
        {twoPorts ? (
          <>
            <Handle
              id="p0"
              type="source"
              position={Position.Right}
              className="wf-port"
              style={{ top: "32%" }}
              title={port0Title}
              isConnectable={connectable ?? false}
            />
            <Handle
              id="p1"
              type="source"
              position={Position.Right}
              className="wf-port"
              style={{ top: "68%" }}
              title={port1Title}
              isConnectable={connectable ?? false}
            />
          </>
        ) : isSwitch ? (
          // One evenly-spaced handle per case + a trailing default, same p{i}
          // convention as the two-port nodes.
          Array.from({ length: switchPortCount }, (_, i) => (
            <Handle
              key={`p${i}`}
              id={`p${i}`}
              type="source"
              position={Position.Right}
              className="wf-port"
              style={{ top: `${((i + 1) / (switchPortCount + 1)) * 100}%` }}
              title={switchPortTitle(i, switchPortCount, parameters?.cases)}
              isConnectable={connectable ?? false}
            />
          ))
        ) : (
          <Handle type="source" position={Position.Right} className="wf-port" isConnectable={connectable ?? false} />
        )}
        {/* Tool output (ADR 0045, invariant #14) — wires from here are `port_type:"tool"` edges, never a next step. */}
        {isAgent && (
          <Handle
            id="tool"
            type="source"
            position={Position.Bottom}
            className="wf-port wf-port-tool"
            style={{ left: "32%" }}
            title="tools — wire action nodes here to give the agent tools it can call"
            isConnectable={connectable ?? false}
          />
        )}
        {/* Error output (ADR 0020) — a wire from here runs when this step fails, skipping the main flow. */}
        {!isTrigger && (
          <Handle
            id="err"
            type="source"
            position={Position.Bottom}
            className="wf-port wf-port-err"
            style={isAgent ? { left: "68%" } : undefined}
            title="on failure — runs this branch when the step errors, skipping the main flow"
            isConnectable={connectable ?? false}
          />
        )}
      </div>
      {(pinnedQuestion || connectionNeed || (nodeAssumptions && nodeAssumptions.length > 0)) && (
        <div
          className="nodrag nopan absolute top-full left-0 mt-1.5 flex flex-col gap-1 z-20"
          style={{ width: NODE_WIDTH }}
          onClick={(e) => e.stopPropagation()}
        >
          {pinnedQuestion && <QuestionChip questionId={pinnedQuestion.questionId} compact />}
          {connectionNeed && (
            <div className="self-start">
              <ComposerConnectChip
                provider={connectionNeed.provider}
                providerLabel={connectionNeed.providerLabel}
                compact
              />
            </div>
          )}
          {nodeAssumptions?.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => requestPrefill(`Change ${text.replace(/^assumed:\s*/i, "")} to `)}
              className="self-start text-[10.5px] rounded-full px-2 py-0.5 cursor-pointer"
              style={{
                border: "1px solid var(--orchestr-warning)",
                color: "var(--orchestr-warning)",
                background: "var(--orchestr-surface-card)",
              }}
              title="Tap to change this assumption"
              data-testid="node-assumption"
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </motion.div>
  );
}

export default memo(WorkflowNodeComponent);
