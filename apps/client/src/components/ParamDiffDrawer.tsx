"use client";

import { useEffect, useMemo, useState } from "react";
import { X, Target, ChevronDown, ChevronRight } from "lucide-react";
import { DIFF_COLORS } from "@/lib/constants";
import type { NodeDiffDetail, NodeParamChange } from "@/lib/diffHelpers";
import NodeIcon from "./NodeIcon";
import { Button } from "@/components/ui/button";

interface ParamDiffDrawerProps {
  detail: NodeDiffDetail | null;
  /** Used to render the head node's icon — drawer only opens for modified nodes. */
  nodeType?: string;
  onClose: () => void;
  /** Pan/zoom both canvases to center the node. */
  onJumpToNode?: () => void;
}

const SECTION_ORDER: NodeParamChange["section"][] = ["name", "type", "parameters", "credentials", "position", "other"];

const SECTION_LABEL: Record<NodeParamChange["section"], string> = {
  name: "Name",
  type: "Type",
  parameters: "Parameters",
  credentials: "Credentials",
  position: "Position",
  other: "Other",
};

// Diff-status hues come from the shared DIFF_COLORS palette; only drawer-local
// tones are declared here.
const COLORS = {
  add: DIFF_COLORS.added,
  remove: DIFF_COLORS.removed,
  modify: DIFF_COLORS.modifiedNew,
  muted: "var(--orchestr-ink-muted)",
  divider: "var(--orchestr-line)",
};

function formatValue(val: unknown): string {
  if (val === undefined) return "—";
  if (val === null) return "null";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

function truncate(s: string, max = 120): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + "…", truncated: true };
}

function ValuePill({ value, variant }: { value: unknown; variant: "old" | "new" }) {
  const [expanded, setExpanded] = useState(false);
  const raw = formatValue(value);
  const { text, truncated } = expanded ? { text: raw, truncated: false } : truncate(raw);
  const color = variant === "old" ? COLORS.remove : COLORS.add;
  const bg = variant === "old" ? "var(--orchestr-danger-tint)" : "var(--orchestr-success-tint)";
  const prefix = variant === "old" ? "−" : "+";
  return (
    <div
      className="font-mono text-[11px] leading-relaxed px-2 py-1 rounded break-all whitespace-pre-wrap"
      style={{ background: bg, color }}
    >
      <span style={{ color: COLORS.muted, marginRight: 6 }}>{prefix}</span>
      {text}
      {truncated && (
        <button
          type="button"
          className="ml-2 underline"
          style={{ color: COLORS.muted, fontSize: 10 }}
          onClick={() => setExpanded(true)}
        >
          show full
        </button>
      )}
    </div>
  );
}

function ChangeRow({ change }: { change: NodeParamChange }) {
  const accent = change.kind === "added" ? COLORS.add : change.kind === "removed" ? COLORS.remove : COLORS.modify;
  const symbol = change.kind === "added" ? "+" : change.kind === "removed" ? "−" : "~";
  return (
    <div className="pl-3 py-2" style={{ borderLeft: `2px solid ${accent}` }}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-semibold" style={{ color: accent }}>
          {symbol}
        </span>
        <span className="font-mono text-[11px]" style={{ color: "var(--orchestr-ink)" }}>
          {change.path}
        </span>
      </div>
      <div className="space-y-1">
        {change.kind !== "added" && <ValuePill value={change.oldValue} variant="old" />}
        {change.kind !== "removed" && <ValuePill value={change.newValue} variant="new" />}
      </div>
    </div>
  );
}

function Section({ label, changes, defaultOpen }: { label: string; changes: NodeParamChange[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (changes.length === 0) return null;
  return (
    <div className="py-2" style={{ borderTop: `1px solid ${COLORS.divider}` }}>
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-2"
        onClick={() => setOpen(!open)}
      >
        <span
          className="flex items-center gap-1 text-[11px] uppercase tracking-wider font-semibold"
          style={{ color: COLORS.muted }}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {label}
        </span>
        <span className="text-[10px]" style={{ color: COLORS.muted }}>
          {changes.length} {changes.length === 1 ? "change" : "changes"}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-1 space-y-2">
          {changes.map((c, i) => (
            <ChangeRow key={`${c.path}-${i}`} change={c} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ParamDiffDrawer({ detail, nodeType, onClose, onJumpToNode }: ParamDiffDrawerProps) {
  // Close on Esc — standard right-drawer pattern.
  useEffect(() => {
    if (!detail) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [detail, onClose]);

  const grouped = useMemo(() => {
    const map = new Map<NodeParamChange["section"], NodeParamChange[]>();
    if (!detail) return map;
    for (const change of detail.changes) {
      if (!map.has(change.section)) map.set(change.section, []);
      map.get(change.section)!.push(change);
    }
    return map;
  }, [detail]);

  // Summary counters at the top of the drawer.
  const counts = useMemo(() => {
    if (!detail) return { added: 0, removed: 0, modified: 0 };
    let added = 0;
    let removed = 0;
    let modified = 0;
    for (const c of detail.changes) {
      if (c.kind === "added") added++;
      else if (c.kind === "removed") removed++;
      else modified++;
    }
    return { added, removed, modified };
  }, [detail]);

  if (!detail) return null;

  return (
    <>
      {/* Backdrop — dims canvas but keeps it visible so the reviewer doesn't
          lose spatial context while reading the drawer. */}
      <div
        className="fixed inset-0 z-40 transition-opacity"
        style={{ background: "rgba(0,0,0,0.45)" }}
        onClick={onClose}
        aria-hidden
      />
      {/* Drawer panel */}
      <aside
        className="fixed top-0 right-0 z-50 flex flex-col"
        style={{
          width: "min(420px, 100vw)",
          height: "100vh",
          background: "var(--orchestr-surface-card)",
          borderLeft: `1px solid ${COLORS.divider}`,
          boxShadow: "-20px 0 50px rgba(0,0,0,0.4)",
        }}
        role="dialog"
        aria-label={`Diff for ${detail.name}`}
      >
        {/* Header — sticky */}
        <div className="px-4 py-4" style={{ borderBottom: `1px solid ${COLORS.divider}` }}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              {nodeType && <NodeIcon nodeType={nodeType} size={22} />}
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold leading-tight" style={{ color: "var(--orchestr-ink)" }}>
                  {detail.oldName ? (
                    <span>
                      <span style={{ color: COLORS.remove, textDecoration: "line-through" }}>{detail.oldName}</span>
                      <span style={{ color: COLORS.muted, margin: "0 6px" }}>→</span>
                      <span style={{ color: COLORS.add }}>{detail.name}</span>
                    </span>
                  ) : (
                    detail.name
                  )}
                </div>
                {nodeType && (
                  <div className="text-[10px] mt-0.5 font-mono" style={{ color: COLORS.muted }}>
                    {nodeType}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {onJumpToNode && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onJumpToNode}
                  title="Jump to node on canvas"
                  aria-label="Jump to node on canvas"
                >
                  <Target size={14} />
                </Button>
              )}
              <button
                type="button"
                className="p-1.5 rounded"
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--orchestr-accent-tint)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                onClick={onClose}
                title="Close"
              >
                <X size={16} style={{ color: COLORS.muted }} />
              </button>
            </div>
          </div>

          {/* Counters — "position only" reads when the sole change is a
              positional shift (moves no longer have their own status). */}
          <div className="flex items-center gap-3 mt-3 text-[10px]">
            {counts.added + counts.removed + counts.modified === 0 && detail.positionDelta ? (
              <span style={{ color: COLORS.muted }}>position only</span>
            ) : (
              <>
                <span style={{ color: COLORS.modify }}>~{counts.modified} changed</span>
                <span style={{ color: COLORS.add }}>+{counts.added} added</span>
                <span style={{ color: COLORS.remove }}>−{counts.removed} removed</span>
              </>
            )}
            {detail.positionDelta && (
              <span style={{ color: COLORS.muted, marginLeft: "auto" }}>
                Δ {Math.round(detail.positionDelta.dx)}, {Math.round(detail.positionDelta.dy)}
              </span>
            )}
          </div>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto">
          {SECTION_ORDER.map((section) => {
            const changes = grouped.get(section) ?? [];
            if (changes.length === 0) return null;
            // Parameters expand by default. Position collapses unless it's the only change.
            const defaultOpen = section === "parameters" || section === "name" || section === "type";
            return <Section key={section} label={SECTION_LABEL[section]} changes={changes} defaultOpen={defaultOpen} />;
          })}

          {detail.changes.length === 0 && (
            <div className="px-4 py-8 text-center text-[12px]" style={{ color: COLORS.muted }}>
              Nothing changed in this node's params.
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
