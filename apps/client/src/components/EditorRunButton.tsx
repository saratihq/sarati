"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Play, X } from "lucide-react";
import * as api from "@/api/client";
import { useWorkflow } from "@/store/useWorkflow";
import { runPinsFor, useStepSamples } from "@/store/useStepSamples";
import { Button } from "@/components/ui/button";
import { REAL_RUN_CONSEQUENCE } from "@/lib/realRun";
import { useMissingRequired } from "@/lib/workflow-validation";

// Same cadence as the overview's run watcher (EnvironmentsRail).
const RUN_POLL_MS = 3000;
const RUN_POLL_CAP_MS = 5 * 60_000;

interface RunView {
  status: "running" | "waiting" | "completed" | "failed";
  outputs?: Record<string, unknown>;
  error?: string | null;
}

const VIEW_META: Record<RunView["status"], { label: string; color: string }> = {
  running: { label: "Running…", color: "var(--orchestr-ai-bright)" },
  waiting: { label: "Waiting for a decision", color: "var(--orchestr-warning)" },
  completed: { label: "Completed", color: "var(--orchestr-success)" },
  failed: { label: "Failed", color: "var(--orchestr-danger)" },
};

/**
 * Runs the WORKING DRAFT on the canvas, not a committed version: sync `runWorkflowIr`, falling back
 * to the durable route when the plan parks on an approval, then polling `getRun` to a terminal state.
 */
export default function EditorRunButton() {
  const workflowJson = useWorkflow((s) => s.workflowJson);
  const workflowId = useWorkflow((s) => s.workflowId);

  // Same per-node gate as Save: a draft missing a required field would run for real and fail obscurely.
  const missing = useMissingRequired(workflowJson);

  const [view, setView] = useState<RunView | null>(null);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [pollRunId, setPollRunId] = useState<string | null>(null);

  // Watches a parked/async run until it resolves; the sync call already handled the common case.
  useEffect(() => {
    if (!pollRunId) return;
    let cancelled = false;
    const startedAt = Date.now();
    const interval = setInterval(async () => {
      try {
        const d = await api.getRun(pollRunId);
        if (cancelled) return;
        if (d.status === "waiting") {
          setView((v) => (v?.status === "completed" || v?.status === "failed" ? v : { status: "waiting" }));
        } else if (d.status === "completed" || d.status === "failed") {
          setView({ status: d.status, outputs: d.outputs ?? undefined, error: d.error });
          setPollRunId(null);
        }
      } catch {
        // Run row not written yet, or a transient failure — keep trying.
      }
      if (!cancelled && Date.now() - startedAt >= RUN_POLL_CAP_MS) setPollRunId(null);
    }, RUN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollRunId]);

  const run = async () => {
    if (!workflowJson || running || missing.length > 0) return;
    const runId = crypto.randomUUID();
    setRunning(true);
    setOpen(true);
    setView({ status: "running" });
    setPollRunId(runId);
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
      });
      setView({ status: "completed", outputs: res.outputs });
      setPollRunId(null);
    } catch (e) {
      // Both patterns must match, or a compile-error 400 that merely mentions a wait node
      // would false-trigger the durable-route fallback.
      if (
        e instanceof api.ApiError &&
        e.status === 400 &&
        /async/i.test(e.message) &&
        /approval|wait|human/i.test(e.message)
      ) {
        try {
          const started = await api.runWorkflowIrAsync(workflowJson, undefined, {
            workflowId: workflowId ?? undefined,
            runId,
            pins,
          });
          setView({ status: "running" });
          setPollRunId(started.run_id || runId);
        } catch (e2) {
          setView({ status: "failed", error: e2 instanceof Error ? e2.message : "Run failed" });
          setPollRunId(null);
        }
      } else {
        setView({ status: "failed", error: e instanceof Error ? e.message : "Run failed" });
        setPollRunId(null);
      }
    } finally {
      setRunning(false);
    }
  };

  const inFlight = running || pollRunId !== null;
  const meta = view ? VIEW_META[view.status] : null;

  return (
    <div className="relative shrink-0">
      <Button
        variant="secondary"
        size="sm"
        onClick={run}
        disabled={inFlight || !workflowJson || missing.length > 0}
        title={
          missing.length > 0
            ? `Fill ${missing.length} required field${missing.length !== 1 ? "s" : ""} before running`
            : undefined
        }
      >
        <Play size={12} />
        {inFlight ? "Running…" : "Run"}
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
            Runs the draft on your canvas for real on your connected accounts — it just isn&apos;t saved as
            a version. {REAL_RUN_CONSEQUENCE}
          </p>

          {view.error && (
            <div
              className="mt-2 p-2 rounded-lg text-[11px] leading-relaxed break-words"
              style={{ background: "var(--orchestr-danger-tint)", color: "var(--orchestr-ink)" }}
            >
              {view.error}
            </div>
          )}

          {view.status === "waiting" && (
            <p className="text-[11px] m-0 mt-2" style={{ color: "var(--orchestr-ink-muted)" }}>
              Paused on an approval step —{" "}
              <Link href="/approvals" className="underline underline-offset-2" style={{ color: "var(--orchestr-ink)" }}>
                open the approvals inbox
              </Link>
              .
            </p>
          )}

          {view.outputs && Object.keys(view.outputs).length > 0 && (
            <pre
              className="mt-2 p-2.5 rounded-lg text-[10px] leading-relaxed overflow-x-auto max-h-56 overflow-y-auto"
              style={{ background: "var(--orchestr-field-strong)", color: "var(--orchestr-ink-muted)" }}
            >
              {JSON.stringify(view.outputs, null, 2)}
            </pre>
          )}

          {workflowId && (view.status === "completed" || view.status === "failed") && (
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
