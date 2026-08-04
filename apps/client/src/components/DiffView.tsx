"use client";

import { useEffect, useState } from "react";
import { Plus, Minus, RefreshCw, ArrowRight } from "lucide-react";
import * as api from "@/api/client";
import type { DiffEntry, DiffResponse } from "@/api/client";
import { SaratiLoader } from "./SaratiLogo";

interface DiffViewProps {
  workflowId: string;
  fromVersion: number;
  toVersion: number;
  /** Identifies the from side outright; wins over fromVersion/fromBranch (invariant #1). */
  fromVersionId?: string | null;
  /** Identifies the to side outright; wins over toVersion/toBranch (invariant #1). */
  toVersionId?: string | null;
  /** Cross-branch compare: resolve fromVersion on this branch (api.getVersionDiff opts.fromBranch). */
  fromBranch?: string;
  /** Cross-branch compare: resolve toVersion on this branch (api.getVersionDiff opts.toBranch). */
  toBranch?: string;
}

const OP_COLORS: Record<string, { bg: string; text: string; icon: typeof Plus }> = {
  add_node: { bg: "var(--orchestr-success-tint)", text: "var(--orchestr-success)", icon: Plus },
  remove_node: { bg: "var(--orchestr-danger-tint)", text: "var(--orchestr-danger)", icon: Minus },
  modify_node: { bg: "var(--orchestr-warning-tint)", text: "var(--orchestr-warning)", icon: RefreshCw },
  rename_node: { bg: "var(--orchestr-accent-tint)", text: "var(--orchestr-ink)", icon: RefreshCw },
  add_edge: { bg: "var(--orchestr-success-tint)", text: "var(--orchestr-success)", icon: ArrowRight },
  remove_edge: { bg: "var(--orchestr-danger-tint)", text: "var(--orchestr-danger)", icon: ArrowRight },
  modify_settings: { bg: "var(--orchestr-warning-tint)", text: "var(--orchestr-warning)", icon: RefreshCw },
};

function OperationLabel({ op }: { op: string }) {
  const label = op.replace("_", " ");
  const style = OP_COLORS[op] || OP_COLORS.modify_node;
  return (
    <span
      className="text-[9px] py-[2px] px-2 rounded font-semibold uppercase"
      style={{ background: style.bg, color: style.text }}
    >
      {label}
    </span>
  );
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "object") return JSON.stringify(val, null, 2);
  return String(val);
}

const VALUE_TRUNCATE = 80;

/** Diff value pill: long values truncate behind a "show full" toggle rather than losing their tail. */
function ValuePill({ value, variant }: { value: unknown; variant: "old" | "new" }) {
  const [expanded, setExpanded] = useState(false);
  const raw = formatValue(value);
  const truncated = raw.length > VALUE_TRUNCATE;
  const text = expanded || !truncated ? raw : raw.slice(0, VALUE_TRUNCATE);
  const isOld = variant === "old";
  return (
    <span
      className={`inline-block py-0.5 px-1.5 rounded font-mono text-[10px] ${isOld ? "mr-1" : ""} ${
        expanded ? "whitespace-pre-wrap break-all align-top" : ""
      }`}
      style={{
        background: isOld ? "var(--orchestr-danger-tint)" : "var(--orchestr-success-tint)",
        color: isOld ? "var(--orchestr-danger)" : "var(--orchestr-success)",
      }}
    >
      <span style={{ textDecoration: isOld ? "line-through" : undefined }}>
        {text}
        {truncated && !expanded && "…"}
      </span>
      {truncated && (
        <button
          type="button"
          className="ml-1.5 underline"
          style={{ color: "var(--orchestr-ink-subtle)" }}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "show less" : "show full"}
        </button>
      )}
    </span>
  );
}

export default function DiffView({
  workflowId,
  fromVersion,
  toVersion,
  fromVersionId,
  toVersionId,
  fromBranch,
  toBranch,
}: DiffViewProps) {
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Keyed on what actually identifies each side, so an id change refetches and a shadowed number doesn't.
  const currentKey = `${workflowId}:${fromVersionId || fromVersion}:${toVersionId || toVersion}:${fromBranch ?? ""}:${toBranch ?? ""}`;
  const [lastKey, setLastKey] = useState(currentKey);

  if (currentKey !== lastKey) {
    setLastKey(currentKey);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    api
      .getVersionDiff(workflowId, fromVersion, toVersion, { fromVersionId, toVersionId, fromBranch, toBranch })
      .then(setDiff)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load diff"))
      .finally(() => setLoading(false));
  }, [workflowId, fromVersion, toVersion, fromVersionId, toVersionId, fromBranch, toBranch]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <SaratiLoader size={32} />
      </div>
    );
  }

  if (error) {
    return <div className="text-[12px] text-[var(--orchestr-danger)] py-4">{error}</div>;
  }

  if (!diff || diff.entries.length === 0) {
    return (
      <div className="text-[12px] py-4 text-center" style={{ color: "var(--orchestr-ink-subtle)" }}>
        No changes
      </div>
    );
  }

  // A node move renders as a quiet "moved" line, never a coordinate blob.
  const isMove = (e: DiffEntry) =>
    e.operation === "modify_node" && (e.path === "position" || Boolean(e.path?.startsWith("position.")));
  const grouped = new Map<string, { moves: DiffEntry[]; changes: DiffEntry[] }>();
  for (const entry of diff.entries) {
    const key = entry.target_name || entry.target_id;
    if (!grouped.has(key)) grouped.set(key, { moves: [], changes: [] });
    grouped.get(key)![isMove(entry) ? "moves" : "changes"].push(entry);
  }
  // A move folds into its node's card, so it only counts when it is all that changed.
  const changeCount = [...grouped.values()].reduce((n, g) => n + (g.changes.length || 1), 0);

  // Label each side with the branch the SERVER resolved, not the prop: a branch's first version is
  // compared against its fork point, which lives on the parent branch.
  const fromResolved = diff.from_branch ?? fromBranch;
  const toResolved = diff.to_branch ?? toBranch;
  const crossBranch = Boolean(fromResolved && toResolved && fromResolved !== toResolved);
  const fromLabel = crossBranch ? fromResolved : fromBranch;
  const toLabel = crossBranch ? toResolved : toBranch;

  return (
    <div>
      <div
        className="text-[11px] mb-3 py-1.5 px-3 rounded-lg"
        style={{ color: "var(--orchestr-ink-muted)", background: "var(--orchestr-surface-card)" }}
      >
        {changeCount} change{changeCount === 1 ? "" : "s"} &mdash; {fromLabel ? `${fromLabel} ` : ""}v
        {diff.from_version} &rarr; {toLabel ? `${toLabel} ` : ""}v{diff.to_version}
      </div>

      <div className="space-y-2">
        {[...grouped].map(([name, { moves, changes }]) =>
          changes.length === 0 ? (
            <div key={name} className="py-1 px-3 text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
              moved {name}
            </div>
          ) : (
            <div
              key={name}
              className="rounded-lg overflow-hidden"
              style={{
                background: "var(--orchestr-surface-card)",
                border: "1px solid var(--orchestr-line)",
              }}
            >
              <div
                className="flex items-center gap-2 py-2 px-3"
                style={{ borderBottom: "1px solid var(--orchestr-line)" }}
              >
                <span className="text-[12px] font-semibold" style={{ color: "var(--orchestr-ink)" }}>
                  {name}
                </span>
                {changes.map((e, i) => (
                  <OperationLabel key={i} op={e.operation} />
                ))}
              </div>

              <div className="py-1.5 px-3">
                {changes.map((entry, i) => (
                  <div key={i} className="py-1 text-[11px]">
                    {entry.path && (
                      <span className="mr-2 font-mono" style={{ color: "var(--orchestr-ink-subtle)" }}>
                        {entry.path}
                      </span>
                    )}
                    {entry.old_value !== undefined && entry.old_value !== null && (
                      <ValuePill value={entry.old_value} variant="old" />
                    )}
                    {entry.new_value !== undefined && entry.new_value !== null && (
                      <ValuePill value={entry.new_value} variant="new" />
                    )}
                  </div>
                ))}
                {moves.length > 0 && (
                  <div className="py-1 text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
                    moved
                  </div>
                )}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
