"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CircleDashed, Play, X } from "lucide-react";
import * as api from "@/api/client";
import { useWorkflow } from "@/store/useWorkflow";
import { runPinsFor, useStepSamples } from "@/store/useStepSamples";
import { Button } from "@/components/ui/button";
import RunWaitingNote, { waitingLabel } from "@/components/RunWaitingNote";
import { DRY_RUN_EXPLAINED, dryRunMarkerOf, withheldSummary } from "@/lib/dryRun";
import { REAL_RUN_CONSEQUENCE } from "@/lib/realRun";
import { useMissingRequired } from "@/lib/workflow-validation";

// Same cadence as the overview's run watcher (EnvironmentsRail).
const RUN_POLL_MS = 3000;
const RUN_POLL_CAP_MS = 5 * 60_000;

interface RunView {
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  dry: boolean;
  /** What a waiting run waits for, as the service reports it. */
  waiting?: api.RunWaiting | null;
  outputs?: Record<string, unknown>;
  /** The ordered step log — a dry run's accounts for steps that have no output, such as a wait. */
  trace?: api.RunTraceEntry[];
  error?: string | null;
}

const VIEW_META: Record<RunView["status"], { label: string; color: string }> = {
  running: { label: "Running…", color: "var(--orchestr-ai-bright)" },
  waiting: { label: "Waiting", color: "var(--orchestr-warning)" },
  completed: { label: "Completed", color: "var(--orchestr-success)" },
  failed: { label: "Failed", color: "var(--orchestr-danger)" },
  cancelled: { label: "Cancelled", color: "var(--orchestr-ink-muted)" },
};

// A dry run sent nothing, so it never borrows the word or the green of a run that did.
const DRY_VIEW_META: Record<RunView["status"], { label: string; color: string }> = {
  ...VIEW_META,
  running: { label: "Dry run in progress…", color: "var(--orchestr-ai-bright)" },
  completed: { label: "Dry run complete", color: "var(--orchestr-ink-muted)" },
  failed: { label: "Dry run failed", color: "var(--orchestr-danger)" },
};

/**
 * Runs the WORKING DRAFT on the canvas, not a committed version — for real, or as a dry run. A real run
 * is one sync `runWorkflowIr` call, which stays open while the run is parked on a wait; `getRun` is
 * polled meanwhile so the panel can say so. A dry run never parks, so it is that call alone.
 */
export default function EditorRunButton() {
  const workflowJson = useWorkflow((s) => s.workflowJson);
  const workflowId = useWorkflow((s) => s.workflowId);

  // Same per-node gate as Save: a draft missing a required field would run for real and fail obscurely.
  const missing = useMissingRequired(workflowJson);

  const [view, setView] = useState<RunView | null>(null);
  const [open, setOpen] = useState(false);
  // The run in flight. The ref is the same fact for the sync call's continuation, which outlives renders.
  const [active, setActive] = useState<{ id: string; dry: boolean } | null>(null);
  const activeRun = useRef<string | null>(null);

  // Whichever learns the outcome first settles the run: the sync call, or the watcher below.
  const settle = useCallback((runId: string, outcome: RunView) => {
    if (activeRun.current !== runId) return;
    activeRun.current = null;
    setActive(null);
    setView(outcome);
  }, []);

  // Watches a real run while its sync call is still open; that call settles the common case itself.
  useEffect(() => {
    if (!active || active.dry) return;
    const runId = active.id;
    const startedAt = Date.now();
    const interval = setInterval(async () => {
      try {
        const d = await api.getRun(runId);
        if (d.status === "waiting" || d.status === "running") {
          if (activeRun.current === runId) setView({ status: d.status, dry: false, waiting: d.waiting });
        } else if (d.status === "completed") {
          settle(runId, { status: "completed", dry: false, outputs: d.outputs ?? undefined });
        } else if (d.status === "cancelled") {
          settle(runId, { status: "cancelled", dry: false });
        } else if (d.status === "error") {
          settle(runId, {
            status: "failed",
            dry: false,
            outputs: d.outputs ?? undefined,
            error: d.error ?? "The run failed.",
          });
        }
      } catch {
        // Run row not written yet, or a transient failure — keep trying.
      }
      if (Date.now() - startedAt >= RUN_POLL_CAP_MS) clearInterval(interval);
    }, RUN_POLL_MS);
    return () => clearInterval(interval);
  }, [active, settle]);

  const run = async (dry: boolean) => {
    if (!workflowJson || activeRun.current || missing.length > 0) return;
    const runId = crypto.randomUUID();
    activeRun.current = runId;
    setActive({ id: runId, dry });
    setOpen(true);
    setView({ status: "running", dry });
    // True pinning: pinned steps replay their captured output, scope-guarded to this doc.
    const samples = useStepSamples.getState();
    const scopeKey =
      workflowId ?? (typeof workflowJson.name === "string" && workflowJson.name ? workflowJson.name : "draft");
    const pinMap = samples.scopeKey === scopeKey ? runPinsFor(samples) : {};
    const pins = Object.keys(pinMap).length > 0 ? pinMap : undefined;
    try {
      const res = await api.runWorkflowIr(workflowJson, undefined, {
        workflowId: workflowId ?? undefined,
        runId,
        pins,
        dryRun: dry || undefined,
      });
      settle(runId, { status: "completed", dry, outputs: res.outputs, trace: res.trace });
    } catch (e) {
      const cancelled = e instanceof api.ApiError && e.code === "run_cancelled";
      settle(
        runId,
        cancelled
          ? { status: "cancelled", dry }
          : { status: "failed", dry, error: e instanceof Error ? e.message : "Run failed" },
      );
    }
  };

  const blocked = active !== null || !workflowJson || missing.length > 0;
  const missingTitle =
    missing.length > 0
      ? `Fill ${missing.length} required field${missing.length !== 1 ? "s" : ""} before running`
      : undefined;
  const meta = view ? metaOf(view) : null;
  const withheld = view?.dry ? withheldSteps(view.trace, workflowJson) : [];

  return (
    <div className="relative shrink-0 flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => run(true)}
        disabled={blocked}
        title={missingTitle ?? DRY_RUN_EXPLAINED}
      >
        <CircleDashed size={12} />
        {active?.dry ? "Dry run…" : "Dry run"}
      </Button>
      <Button variant="secondary" size="sm" onClick={() => run(false)} disabled={blocked} title={missingTitle}>
        <Play size={12} />
        {active && !active.dry ? "Running…" : "Run"}
      </Button>

      {open && view && meta && (
        <div
          className="absolute right-0 top-full mt-2 w-[340px] max-w-[80vw] rounded-xl p-3 z-30 shadow-xl"
          style={{
            background: "var(--orchestr-surface-card)",
            border: "1px solid var(--orchestr-line)",
          }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: meta.color }}>
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  view.status === "running" || view.status === "waiting" ? "animate-pulse" : ""
                }`}
                style={{ background: meta.color }}
              />
              {meta.label}
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Dismiss run result"
              className="bg-transparent border-none p-0 cursor-pointer shrink-0"
              style={{ color: "var(--orchestr-ink-subtle)" }}
            >
              <X size={13} />
            </button>
          </div>

          <p className="text-[11px] m-0 mt-1.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
            {view.dry ? (
              <>A dry run of the draft on your canvas. {DRY_RUN_EXPLAINED}</>
            ) : (
              <>
                Runs the draft on your canvas for real on your connected accounts — it just isn&apos;t saved
                as a version. {REAL_RUN_CONSEQUENCE}
              </>
            )}
          </p>

          {view.error && (
            <div
              className="mt-2 p-2 rounded-lg text-[11px] leading-relaxed break-words"
              style={{ background: "var(--orchestr-danger-tint)", color: "var(--orchestr-ink)" }}
            >
              {view.error}
            </div>
          )}

          {view.status === "waiting" && view.waiting && (
            <p className="text-[11px] m-0 mt-2" style={{ color: "var(--orchestr-ink-muted)" }}>
              <RunWaitingNote waiting={view.waiting} />
            </p>
          )}

          {withheld.length > 0 && (
            <ul className="list-none m-0 mt-2 p-0 space-y-1" data-testid="dry-run-withheld">
              {withheld.map((step) => (
                <li key={step.id} className="text-[11px] leading-snug break-words">
                  <span className="font-medium" style={{ color: "var(--orchestr-ink)" }}>
                    {step.name}
                  </span>{" "}
                  <span style={{ color: "var(--orchestr-ink-muted)" }}>{step.summary}</span>
                </li>
              ))}
            </ul>
          )}

          {view.outputs && Object.keys(view.outputs).length > 0 && (
            <pre
              className="mt-2 p-2.5 rounded-lg text-[10px] leading-relaxed overflow-x-auto max-h-56 overflow-y-auto"
              style={{ background: "var(--orchestr-field-strong)", color: "var(--orchestr-ink-muted)" }}
            >
              {JSON.stringify(view.outputs, null, 2)}
            </pre>
          )}

          {workflowId && view.status !== "running" && view.status !== "waiting" && (
            <p className="text-[11px] m-0 mt-2">
              <Link
                href={`/workflows/${workflowId}/runs`}
                className="hover:underline underline-offset-2"
                style={{ color: "var(--orchestr-ink-subtle)" }}
              >
                View in runs history →
              </Link>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function metaOf(view: RunView): { label: string; color: string } {
  const meta = (view.dry ? DRY_VIEW_META : VIEW_META)[view.status];
  return view.status === "waiting" ? { ...meta, label: waitingLabel(view.waiting) } : meta;
}

/** The steps a dry run did not carry out, in the order it reached them, each with what it did instead. */
function withheldSteps(
  trace: api.RunTraceEntry[] | undefined,
  workflowJson: Record<string, unknown> | null,
): Array<{ id: string; name: string; summary: string }> {
  const nodes = Array.isArray(workflowJson?.nodes)
    ? (workflowJson.nodes as Array<{ id?: unknown; name?: unknown }>)
    : [];
  const nameOf = new Map(
    nodes.map((n) => [String(n.id), typeof n.name === "string" && n.name ? n.name : String(n.id)]),
  );
  return (trace ?? []).flatMap((entry, i) => {
    const marker = dryRunMarkerOf(entry.output);
    if (!marker) return [];
    return [
      {
        id: `${entry.nodeId}:${i}`,
        name: nameOf.get(entry.nodeId) ?? entry.nodeId,
        summary: withheldSummary(marker),
      },
    ];
  });
}
