"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Check, GitMerge, Pencil, Trash2, X } from "lucide-react";
import type { ConflictInfo, MergeResolution, MergeResultResponse } from "@/api/client";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";

// The in-app three-way merge conflict resolver, one decision per card. Endpoint-agnostic: the caller's
// `onResolve` re-POSTs its own merge endpoint, so nothing merges until "Complete merge" succeeds.

interface ConflictResolverProps {
  conflicts: ConflictInfo[];
  sourceBranch: string;
  targetBranch: string;
  /** Re-POST the merge endpoint with the resolutions; resolves with the outcome. */
  onResolve: (resolutions: MergeResolution[]) => Promise<MergeResultResponse>;
  /** Called on a successful merge (parent toasts, closes, and refetches). */
  onMerged: (mergedVersionId: string | null | undefined) => void;
  /** Cancel / escape — no merge happened. */
  onCancel: () => void;
}

interface Decision {
  /** Undefined until the user picks. */
  choice?: MergeResolution["choice"];
  /** JSON editor buffer for the "Edit" option. */
  customText: string;
  /** Per-card message: invalid JSON, or an illegal-choice 400 attributed to this node. */
  error: string | null;
}

// "parameters.messages.0.text" → "messages › 0 › text"; the prefix is on every field, so it's noise.
function fieldLabel(path: string | null): string {
  if (!path) return "value";
  const parts = path.split(".").filter(Boolean);
  if (parts[0] === "parameters") parts.shift();
  return parts.length ? parts.join(" › ") : path;
}

// Round-tripping through JSON is what keeps the custom value's type.
function serialize(val: unknown): string {
  return val === undefined ? "" : JSON.stringify(val, null, 2);
}

// null when the buffer is valid JSON; also decides whether the conflict counts as resolved.
function jsonError(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch {
    return 'Not valid JSON — wrap text in quotes, e.g. "hello".';
  }
}

function ValueBlock({ val, tone }: { val: unknown; tone: "neutral" | "source" | "target" }) {
  const empty = val === undefined || val === null || val === "";
  const bg =
    tone === "source"
      ? "var(--orchestr-success-tint)"
      : tone === "target"
        ? "var(--orchestr-ai-tint)"
        : "var(--orchestr-accent-tint)";
  const text = empty ? "var(--orchestr-ink-subtle)" : "var(--orchestr-ink)";
  return (
    <pre
      className="mt-1.5 max-h-40 overflow-auto rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words m-0"
      style={{ background: bg, color: text }}
    >
      {empty ? (val === undefined ? "(not set)" : val === null ? "null" : "(empty)") : serialize(val)}
    </pre>
  );
}

// One selectable option row with radio semantics and the value shown inline.
function OptionRow({
  selected,
  onSelect,
  label,
  hint,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className="w-full text-left rounded-xl p-2.5 transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--orchestr-accent-tint-strong)]"
      style={{
        background: selected ? "var(--orchestr-accent-tint)" : "transparent",
        border: `1px solid ${selected ? "var(--orchestr-line-strong)" : "var(--orchestr-line)"}`,
      }}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className="flex items-center justify-center rounded-full shrink-0"
          style={{
            width: 15,
            height: 15,
            border: `1.5px solid ${selected ? "var(--orchestr-ink)" : "var(--orchestr-ink-subtle)"}`,
            background: selected ? "var(--orchestr-ink)" : "transparent",
          }}
        >
          {selected && <Check size={10} style={{ color: "var(--orchestr-surface)" }} strokeWidth={3} />}
        </span>
        <span className="text-[12px] font-semibold" style={{ color: "var(--orchestr-ink)" }}>
          {label}
        </span>
        {hint && (
          <span className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
            {hint}
          </span>
        )}
      </span>
      {children}
    </button>
  );
}

function ConflictCard({
  conflict,
  index,
  sourceBranch,
  targetBranch,
  decision,
  onChange,
}: {
  conflict: ConflictInfo;
  index: number;
  sourceBranch: string;
  targetBranch: string;
  decision: Decision;
  onChange: (next: Decision) => void;
}) {
  const set = (choice: MergeResolution["choice"]) => onChange({ ...decision, choice, error: null });

  const cardStyle = {
    background: "var(--orchestr-surface-card)",
    border: "1px solid var(--orchestr-line)",
  } as const;

  const header = (
    <div className="flex items-start gap-2">
      <span
        className="text-[10px] font-semibold rounded-full shrink-0 flex items-center justify-center"
        style={{
          width: 18,
          height: 18,
          background: decision.choice ? "var(--orchestr-success-tint)" : "var(--orchestr-warning-tint)",
          color: decision.choice ? "var(--orchestr-success)" : "var(--orchestr-warning)",
        }}
      >
        {decision.choice ? <Check size={11} strokeWidth={3} /> : index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold truncate" style={{ color: "var(--orchestr-ink)" }}>
          {conflict.node_name}
        </div>
        {conflict.kind === "field" ? (
          <div className="text-[11px]" style={{ color: "var(--orchestr-ink-muted)" }}>
            <span style={{ color: "var(--orchestr-ink)" }}>{fieldLabel(conflict.field_path)}</span>
            {conflict.field_path && conflict.field_path !== fieldLabel(conflict.field_path) && (
              <span className="ml-1.5 font-mono text-[10px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
                {conflict.field_path}
              </span>
            )}
          </div>
        ) : (
          <div className="text-[11px]" style={{ color: "var(--orchestr-ink-muted)" }}>
            edited on one branch, deleted on the other
          </div>
        )}
      </div>
    </div>
  );

  if (conflict.kind === "edit_delete") {
    // deleted_on tells us which side removed the node; the other side edited it.
    const editedOn = conflict.deleted_on === "source" ? targetBranch : sourceBranch;
    const deletedOn = conflict.deleted_on === "source" ? sourceBranch : targetBranch;
    return (
      <div className="rounded-xl p-3.5" style={cardStyle}>
        {header}
        <p className="text-[12px] mt-2.5 mb-3 leading-relaxed" style={{ color: "var(--orchestr-ink-muted)" }}>
          <span className="font-semibold" style={{ color: "var(--orchestr-ink)" }}>
            {conflict.node_name}
          </span>{" "}
          was edited on <span style={{ color: "var(--orchestr-ink)" }}>{editedOn}</span> and deleted on{" "}
          <span style={{ color: "var(--orchestr-ink)" }}>{deletedOn}</span>. Keep the edited node, or accept the
          deletion?
        </p>
        <div role="radiogroup" aria-label={`Resolve ${conflict.node_name}`} className="space-y-1.5">
          <OptionRow selected={decision.choice === "keep"} onSelect={() => set("keep")} label="Keep the edited node">
            <span className="flex items-center gap-1.5 mt-1.5 text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
              <Pencil size={11} /> The node stays, with its edits.
            </span>
          </OptionRow>
          <OptionRow
            selected={decision.choice === "delete"}
            onSelect={() => set("delete")}
            label="Accept the deletion"
          >
            <span className="flex items-center gap-1.5 mt-1.5 text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
              <Trash2 size={11} /> The node is removed from the merge.
            </span>
          </OptionRow>
        </div>
        {decision.error && (
          <div className="text-[11px] mt-2 flex items-center gap-1.5" style={{ color: "var(--orchestr-danger)" }}>
            <AlertTriangle size={12} /> {decision.error}
          </div>
        )}
      </div>
    );
  }

  // field conflict
  const editing = decision.choice === "custom";
  const liveJsonError = editing ? jsonError(decision.customText) : null;
  return (
    <div className="rounded-xl p-3.5" style={cardStyle}>
      {header}
      {conflict.ancestor_value !== undefined && (
        <div className="mt-2.5 text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
          Originally
          <ValueBlock val={conflict.ancestor_value} tone="neutral" />
        </div>
      )}
      <div role="radiogroup" aria-label={`Resolve ${conflict.node_name} · ${fieldLabel(conflict.field_path)}`} className="space-y-1.5 mt-2.5">
        <OptionRow
          selected={decision.choice === "source"}
          onSelect={() => set("source")}
          label="Use theirs"
          hint={sourceBranch}
        >
          <ValueBlock val={conflict.source_value} tone="source" />
        </OptionRow>
        <OptionRow
          selected={decision.choice === "target"}
          onSelect={() => set("target")}
          label="Use current"
          hint={targetBranch}
        >
          <ValueBlock val={conflict.target_value} tone="target" />
        </OptionRow>
        <OptionRow selected={editing} onSelect={() => set("custom")} label="Edit" hint="write a custom value">
          {editing && (
            <div className="mt-2" onClick={(e) => e.stopPropagation()}>
              <textarea
                value={decision.customText}
                autoFocus
                spellCheck={false}
                onChange={(e) => onChange({ ...decision, customText: e.target.value, error: null })}
                rows={Math.min(8, Math.max(2, decision.customText.split("\n").length))}
                className="w-full rounded-lg px-2.5 py-2 text-[11px] font-mono leading-relaxed outline-none resize-y"
                style={{
                  background: "var(--orchestr-surface)",
                  border: `1px solid ${liveJsonError ? "var(--orchestr-danger)" : "var(--orchestr-line-strong)"}`,
                  color: "var(--orchestr-ink)",
                }}
                aria-label="Custom value (JSON)"
                aria-invalid={Boolean(liveJsonError)}
              />
              {liveJsonError ? (
                <div className="text-[10px] mt-1 flex items-center gap-1" style={{ color: "var(--orchestr-danger)" }}>
                  <AlertTriangle size={11} /> {liveJsonError}
                </div>
              ) : (
                <div className="text-[10px] mt-1" style={{ color: "var(--orchestr-ink-subtle)" }}>
                  JSON — strings in quotes, e.g. <span className="font-mono">&quot;hello&quot;</span> or{" "}
                  <span className="font-mono">{"{ \"key\": 1 }"}</span>
                </div>
              )}
            </div>
          )}
        </OptionRow>
      </div>
      {decision.error && (
        <div className="text-[11px] mt-2 flex items-center gap-1.5" style={{ color: "var(--orchestr-danger)" }}>
          <AlertTriangle size={12} /> {decision.error}
        </div>
      )}
    </div>
  );
}

export default function ConflictResolver({
  conflicts,
  sourceBranch,
  targetBranch,
  onResolve,
  onMerged,
  onCancel,
}: ConflictResolverProps) {
  const [decisions, setDecisions] = useState<Decision[]>(() =>
    // Each "Edit" buffer starts from the source value rather than a blank box.
    conflicts.map((c) => ({ choice: undefined, customText: serialize(c.source_value), error: null })),
  );
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  // Escape cancels (nothing merged) unless a merge is already in flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, submitting]);

  const setDecision = (i: number, next: Decision) =>
    setDecisions((prev) => prev.map((d, idx) => (idx === i ? next : d)));

  // A conflict is resolved once it has a choice, and for a custom value that the JSON parses.
  const resolvedCount = useMemo(
    () =>
      decisions.filter((d, i) => {
        if (!d.choice) return false;
        if (conflicts[i].kind === "field" && d.choice === "custom") return !jsonError(d.customText);
        return true;
      }).length,
    [decisions, conflicts],
  );
  const allResolved = resolvedCount === conflicts.length;

  const complete = async () => {
    setFormError(null);
    // One resolution per conflict; the guards below back up the `allResolved` gate on the button.
    const resolutions: MergeResolution[] = [];
    for (let i = 0; i < conflicts.length; i++) {
      const c = conflicts[i];
      const d = decisions[i];
      if (!d.choice) return;
      if (c.kind === "field" && d.choice === "custom") {
        if (jsonError(d.customText)) return;
        resolutions.push({ node_id: c.node_id, field_path: c.field_path, choice: "custom", value: JSON.parse(d.customText) });
      } else {
        resolutions.push({ node_id: c.node_id, field_path: c.field_path, choice: d.choice });
      }
    }

    setSubmitting(true);
    try {
      const result = await onResolve(resolutions);
      if (result.status === "merged") {
        onMerged(result.merged_version_id);
      } else {
        setFormError("The merge still reports conflicts. Reopen the merge and try again.");
      }
    } catch (e) {
      const msg = e instanceof ApiError || e instanceof Error ? e.message : "Couldn't complete the merge.";
      // Best-effort attribution of an illegal-choice 400 to the card it names.
      const offending = conflicts.findIndex((c) => c.node_name && msg.includes(c.node_name));
      if (offending >= 0) {
        setDecision(offending, { ...decisions[offending], error: msg });
      } else {
        setFormError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={() => !submitting && onCancel()}
    >
      <motion.div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-resolver-title"
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.15 }}
        onClick={(e) => e.stopPropagation()}
        className="rounded-2xl w-full max-w-[600px] max-h-[86vh] flex flex-col outline-none"
        style={{
          background: "var(--orchestr-surface-raised)",
          border: "1px solid var(--orchestr-line-strong)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
        }}
      >
        {/* Header */}
        <div className="flex items-start gap-3 p-5 pb-4" style={{ borderBottom: "1px solid var(--orchestr-line)" }}>
          <span
            className="flex items-center justify-center rounded-xl shrink-0"
            style={{ width: 34, height: 34, background: "var(--orchestr-warning-tint)" }}
          >
            <GitMerge size={17} style={{ color: "var(--orchestr-warning)" }} />
          </span>
          <div className="flex-1 min-w-0">
            <h2 id="conflict-resolver-title" className="text-[15px] font-semibold m-0" style={{ color: "var(--orchestr-ink)" }}>
              Resolve merge conflicts
            </h2>
            <p className="text-[12px] mt-0.5 m-0" style={{ color: "var(--orchestr-ink-muted)" }}>
              <span style={{ color: "var(--orchestr-ink)" }}>{sourceBranch}</span> →{" "}
              <span style={{ color: "var(--orchestr-ink)" }}>{targetBranch}</span> · {conflicts.length} change
              {conflicts.length === 1 ? " differs" : "s differ"} on both sides. Nothing has merged yet.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            aria-label="Cancel merge"
            className="shrink-0 rounded-lg p-1 cursor-pointer bg-transparent border-none hover:bg-[var(--orchestr-accent-tint)] disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-[var(--orchestr-accent-tint-strong)]"
            style={{ color: "var(--orchestr-ink-muted)" }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Conflict cards */}
        <div className="overflow-y-auto px-5 py-4 space-y-2.5">
          {conflicts.map((c, i) => (
            <ConflictCard
              key={`${c.node_id}:${c.field_path ?? "deleted"}`}
              conflict={c}
              index={i}
              sourceBranch={sourceBranch}
              targetBranch={targetBranch}
              decision={decisions[i]}
              onChange={(next) => setDecision(i, next)}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="p-4 px-5" style={{ borderTop: "1px solid var(--orchestr-line)" }}>
          {formError && (
            <div
              className="text-[12px] mb-3 py-2 px-3 rounded-lg flex items-center gap-2"
              style={{ background: "var(--orchestr-danger-tint)", color: "var(--orchestr-danger)" }}
            >
              <AlertTriangle size={13} className="shrink-0" />
              <span>{formError}</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <span
              className="text-[12px]"
              style={{ color: allResolved ? "var(--orchestr-success)" : "var(--orchestr-ink-muted)" }}
            >
              {allResolved && <Check size={12} className="inline mr-1" strokeWidth={3} />}
              {resolvedCount} of {conflicts.length} resolved
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={onCancel} disabled={submitting}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={complete}
                disabled={!allResolved || submitting}
                title={allResolved ? undefined : "Choose how to resolve every conflict first"}
              >
                <GitMerge size={13} />
                {submitting ? "Merging…" : "Complete merge"}
              </Button>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
