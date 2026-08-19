"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Check, ChevronDown, ChevronRight, CornerDownRight, CornerUpLeft, User, X } from "lucide-react";
import * as api from "@/api/client";
import type { RunDetail, RunStepInfo, RunSummary } from "@/api/client";
import { formatDuration, timeAgo } from "@/lib/format";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { SaratiLoader } from "./SaratiLogo";
import { useWorkflowContext } from "./WorkflowDetail";

const LIST_POLL_MS = 3000;

// Status presentation — one source for the dot, label, and text color.
const STATUS_META: Record<string, { label: string; color: string }> = {
  completed: { label: "Completed", color: "var(--orchestr-success)" },
  failed: { label: "Failed", color: "var(--orchestr-danger)" },
  running: { label: "Running", color: "var(--orchestr-ai-bright)" },
  waiting: { label: "Waiting", color: "var(--orchestr-warning)" },
};

function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, color: "var(--orchestr-ink-muted)" };
}

function isActive(status: string): boolean {
  return status === "running" || status === "waiting";
}

function StatusDot({ status }: { status: string }) {
  const meta = statusMeta(status);
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive(status) ? "animate-pulse" : ""}`}
        style={{ background: meta.color }}
      />
      <span className="text-[12px] font-medium" style={{ color: meta.color }}>
        {meta.label}
      </span>
    </span>
  );
}

// Step outputs arrive as a string preview or a small JSON value — render both.
function previewText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// An output too large to store is kept as its head — say so, in the unit the cap is counted in.
function truncationNote(step: RunStepInfo): string | null {
  const cut = step.output_truncated;
  if (!cut) return null;
  const n = (chars: number) => chars.toLocaleString("en-US");
  return `Output too large to store — ${n(cut.size_chars)} characters, cap ${n(cut.max_chars)}. Showing the start of it.`;
}

function stepDuration(step: RunStepInfo): string | null {
  if (!step.started_at || !step.finished_at) return null;
  const ms = new Date(step.finished_at).getTime() - new Date(step.started_at).getTime();
  return Number.isFinite(ms) && ms >= 0 ? formatDuration(ms) : null;
}

function StepRow({ step }: { step: RunStepInfo }) {
  const failed = step.status === "failed" || step.status === "error" || step.status === "crashed";
  const succeeded = step.status === "completed" || step.status === "success";
  const output = previewText(step.output_preview);
  const truncated = truncationNote(step);
  const duration = stepDuration(step);

  return (
    <li className="flex items-start gap-2.5 py-2">
      {succeeded ? (
        <Check size={14} className="mt-0.5 shrink-0" style={{ color: "var(--orchestr-success)" }} />
      ) : failed ? (
        <X size={14} className="mt-0.5 shrink-0" style={{ color: "var(--orchestr-danger)" }} />
      ) : (
        <span
          className={`mt-1.5 ml-0.5 mr-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${
            isActive(step.status) ? "animate-pulse" : ""
          }`}
          style={{ background: isActive(step.status) ? statusMeta(step.status).color : "var(--orchestr-ink-faint)" }}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className="text-[13px] truncate"
            style={{ color: failed ? "var(--orchestr-danger)" : "var(--orchestr-ink)" }}
          >
            {step.name || step.node_id}
          </span>
          {duration && (
            <span className="text-[11px] shrink-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
              {duration}
            </span>
          )}
        </div>
        {step.error && (
          <p className="text-[12px] m-0 mt-1 break-words" style={{ color: "var(--orchestr-danger)" }}>
            {step.error}
          </p>
        )}
        {/* Non-fatal honesty notes: the step ran, but the rail ignored an input or
            a `{{ref}}` resolved to nothing. Amber, not error-red — a dropped input
            made visible. Null/empty → nothing renders. */}
        {step.warnings && step.warnings.length > 0 && (
          <div
            className="mt-1.5 rounded-lg px-2.5 py-1.5 flex items-start gap-1.5"
            style={{ background: "var(--orchestr-warning-tint)", color: "var(--orchestr-warning)" }}
            data-testid="run-step-warnings"
          >
            <AlertTriangle size={13} className="shrink-0 mt-[2px]" />
            <div className="min-w-0">
              {step.warnings.map((w, i) => (
                <p key={i} className={`text-[11px] leading-snug break-words m-0 ${i > 0 ? "mt-0.5" : ""}`}>
                  {w}
                </p>
              ))}
            </div>
          </div>
        )}
        {truncated && (
          <p
            className="text-[11px] m-0 mt-1.5 break-words"
            style={{ color: "var(--orchestr-warning)" }}
            data-testid="run-step-output-truncated"
          >
            {truncated}
          </p>
        )}
        {output && (
          <pre
            className="m-0 mt-1.5 p-2.5 rounded-lg text-[10px] font-mono leading-relaxed overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-words"
            style={{ background: "var(--orchestr-field-strong)", color: "var(--orchestr-ink-muted)" }}
          >
            {output}
          </pre>
        )}
      </div>
    </li>
  );
}

/**
 * Both ends of a sub-workflow call. A nested run lives under the workflow that ran, so
 * this is the only path between them — without it "why did that step fail?" has nowhere to go.
 */
function SubWorkflowLinks({ detail }: { detail: RunDetail }) {
  const calls = detail.calls ?? [];
  const calledBy = detail.called_by ?? null;
  if (!calledBy && calls.length === 0) return null;

  const linkStyle = { color: "var(--orchestr-accent)" };
  return (
    <div className="mt-2 space-y-1" data-testid="sub-workflow-links">
      {calledBy && (
        <p className="text-[11px] m-0 inline-flex items-center gap-1" style={{ color: "var(--orchestr-ink-subtle)" }}>
          <CornerUpLeft size={11} />
          Run by{" "}
          {calledBy.workflow_id ? (
            <Link href={`/workflows/${calledBy.workflow_id}/runs`} style={linkStyle}>
              {calledBy.workflow_name ?? "another workflow"}
            </Link>
          ) : (
            (calledBy.workflow_name ?? "another workflow")
          )}
          {calledBy.step_key ? ` · step "${calledBy.step_key}"` : ""}
        </p>
      )}
      {calls.map((call) => (
        <p
          key={call.run_id}
          className="text-[11px] m-0 flex items-center gap-1"
          style={{ color: "var(--orchestr-ink-subtle)" }}
        >
          <CornerDownRight size={11} className="shrink-0" />
          {call.step_key ? `"${call.step_key}" ran ` : "Ran "}
          {call.workflow_id ? (
            <Link href={`/workflows/${call.workflow_id}/runs`} style={linkStyle}>
              {call.workflow_name ?? "a workflow"}
            </Link>
          ) : (
            (call.workflow_name ?? "a workflow")
          )}
          <span style={{ color: call.status === "error" ? "var(--orchestr-danger)" : undefined }}>
            · {call.status}
          </span>
        </p>
      ))}
    </div>
  );
}

// The expanded panel under a clicked run — its step log.
function RunDetailPanel({ detail, error }: { detail: RunDetail | null; error: string | null }) {
  if (error) {
    return (
      <div
        className="mx-3.5 mb-3 py-2 px-3 rounded-lg text-[11px]"
        style={{ background: "var(--orchestr-danger-tint)", color: "var(--orchestr-danger)" }}
      >
        {error}
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex items-center justify-center py-4">
        <SaratiLoader size={22} />
      </div>
    );
  }
  return (
    <div className="px-3.5 pb-3">
      <div className="pt-1 border-t" style={{ borderColor: "var(--orchestr-line)" }}>
        {/* The run error usually copies the failing step's — only render it when it adds something. */}
        {detail.error && !detail.steps.some((s) => s.error === detail.error) && (
          <div
            className="mt-2 py-2 px-3 rounded-lg text-[12px] break-words"
            style={{ background: "var(--orchestr-danger-tint)", color: "var(--orchestr-danger)" }}
          >
            {detail.error}
          </div>
        )}
        {detail.steps.length === 0 ? (
          <p className="text-[12px] m-0 mt-2" style={{ color: "var(--orchestr-ink-muted)" }}>
            No step log for this run.
          </p>
        ) : (
          <ul className="list-none m-0 p-0 divide-y divide-white/5">
            {detail.steps.map((step, i) => (
              <StepRow key={`${step.node_id}:${i}`} step={step} />
            ))}
          </ul>
        )}
        {detail.decided_by && (
          <p
            className="text-[11px] m-0 mt-2 inline-flex items-center gap-1"
            style={{ color: "var(--orchestr-ink-subtle)" }}
          >
            <User size={11} />
            Resolved by {detail.decided_by.name || detail.decided_by.email || "a teammate"}
            {detail.decided_at ? ` · ${timeAgo(detail.decided_at)}` : ""}
          </p>
        )}
        <SubWorkflowLinks detail={detail} />
        <p className="text-[10px] m-0 mt-2 break-all" style={{ color: "var(--orchestr-ink-faint)" }}>
          Run ID: {detail.run_id}
        </p>
      </div>
    </div>
  );
}

// Run history for one workflow, newest first — polls while any run is in
// flight and goes quiet once everything has settled.
export default function WorkflowRunsPage() {
  const { workflowId, workflowName } = useWorkflowContext();
  useDocumentTitle("Runs", workflowName);

  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  // ?run=<id> deep link: expand that run and scroll to it, once, after the first load.
  const searchParams = useSearchParams();
  const runParam = searchParams.get("run");
  const deepLinkConsumed = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await api.listRuns({ workflowId, limit: 50 });
      setRuns(res.runs);
      setListError(null);
    } catch (e) {
      // Keep any data we already have — surface the error only when there's nothing to show.
      setRuns((prev) => {
        if (prev === null) setListError(e instanceof Error ? e.message : "Failed to load runs");
        return prev ?? [];
      });
    }
  }, [workflowId]);

  useEffect(() => {
    setRuns(null);
    setListError(null);
    setExpanded(null);
    load();
  }, [load]);

  // Auto-refresh while anything is running/waiting; stop once all settled.
  const anyActive = runs?.some((r) => isActive(r.status)) ?? false;
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(load, LIST_POLL_MS);
    return () => clearInterval(t);
  }, [anyActive, load]);

  useEffect(() => {
    if (deepLinkConsumed.current || !runParam || !runs) return;
    if (!runs.some((r) => r.run_id === runParam)) return;
    deepLinkConsumed.current = true;
    setExpanded(runParam);
    requestAnimationFrame(() => {
      document.getElementById(`run-${runParam}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [runParam, runs]);

  // Expanded run: fetch its step log, and keep re-fetching while it's active.
  const detailActive = expanded !== null && (detail === null || isActive(detail.status));
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    const fetchDetail = async () => {
      try {
        const d = await api.getRun(expanded);
        if (cancelled) return;
        setDetail(d);
        setDetailError(null);
      } catch (e) {
        if (cancelled) return;
        setDetail((prev) => {
          if (prev === null) setDetailError(e instanceof Error ? e.message : "Failed to load the run");
          return prev;
        });
      }
    };
    fetchDetail();
    if (!detailActive) return;
    const t = setInterval(fetchDetail, LIST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [expanded, detailActive]);

  const toggle = (runId: string) => {
    setDetail(null);
    setDetailError(null);
    setExpanded((cur) => (cur === runId ? null : runId));
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <h2 className="text-[18px] font-semibold text-[color:var(--orchestr-ink)] m-0">Runs</h2>
        {anyActive && (
          <span className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
            auto-refreshing…
          </span>
        )}
      </div>

      {runs === null ? (
        <div className="flex items-center justify-center py-16">
          <SaratiLoader size={32} />
        </div>
      ) : listError ? (
        <div
          className="py-3 px-4 rounded-xl text-[12px]"
          style={{ background: "var(--orchestr-danger-tint)", color: "var(--orchestr-danger)" }}
        >
          {listError}
        </div>
      ) : runs.length === 0 ? (
        <div
          className="rounded-xl py-10 text-center text-[13px]"
          style={{
            background: "var(--orchestr-surface-card)",
            border: "1px solid var(--orchestr-line)",
            color: "var(--orchestr-ink-muted)",
          }}
        >
          No runs yet — trigger one from the{" "}
          <Link
            href={`/workflows/${workflowId}/overview`}
            className="underline underline-offset-2"
            style={{ color: "var(--orchestr-ink)" }}
          >
            overview
          </Link>
          .
        </div>
      ) : (
        <div
          className="rounded-xl overflow-hidden"
          style={{ background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-line)" }}
        >
          {/* Column header */}
          <div
            className="hidden sm:grid grid-cols-[110px_90px_90px_60px_90px_80px_1fr_20px] gap-3 items-center py-2 px-3.5 text-[10px] uppercase tracking-[1px] font-semibold border-b"
            style={{ color: "var(--orchestr-ink-subtle)", borderColor: "var(--orchestr-line)" }}
          >
            <span>Status</span>
            <span>Source</span>
            <span>Environment</span>
            <span>Version</span>
            <span>Started</span>
            <span>Duration</span>
            <span>Error</span>
            <span />
          </div>
          <ul className="list-none m-0 p-0 divide-y" style={{ borderColor: "var(--orchestr-line)" }}>
            {runs.map((run) => {
              const isOpen = expanded === run.run_id;
              return (
                <li id={`run-${run.run_id}`} key={run.run_id} style={{ borderColor: "var(--orchestr-line)" }}>
                  <button
                    onClick={() => toggle(run.run_id)}
                    className="w-full grid grid-cols-[110px_90px_90px_60px_90px_80px_1fr_20px] gap-3 items-center py-2.5 px-3.5 bg-transparent border-none cursor-pointer text-left hover:bg-[var(--orchestr-accent-tint)] transition-colors"
                    aria-expanded={isOpen}
                  >
                    <StatusDot status={run.status} />
                    <span className="min-w-0">
                      {run.source && (
                        <span
                          className="text-[9px] py-[1px] px-1.5 rounded font-semibold uppercase"
                          style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink-muted)" }}
                        >
                          {run.source}
                        </span>
                      )}
                    </span>
                    {/* null environment = the Default pool — labeled, never blank. */}
                    <span className="min-w-0">
                      <span
                        className="text-[9px] py-[1px] px-1.5 rounded font-semibold uppercase"
                        style={{
                          background: "var(--orchestr-accent-tint)",
                          color: run.environment ? "var(--orchestr-ink-muted)" : "var(--orchestr-ink-subtle)",
                        }}
                      >
                        {run.environment ?? "Default"}
                      </span>
                    </span>
                    {/* != null also covers the field being absent (service half may lag this UI). */}
                    <span
                      className="text-[12px] font-mono"
                      style={{
                        color:
                          run.version_number != null ? "var(--orchestr-ink-muted)" : "var(--orchestr-ink-faint)",
                      }}
                    >
                      {run.version_number != null ? `v${run.version_number}` : "—"}
                    </span>
                    <span className="text-[12px] whitespace-nowrap" style={{ color: "var(--orchestr-ink-muted)" }}>
                      {timeAgo(run.started_at)}
                    </span>
                    <span className="text-[12px] font-mono" style={{ color: "var(--orchestr-ink-muted)" }}>
                      {formatDuration(run.duration_ms)}
                    </span>
                    <span
                      className="text-[12px] truncate"
                      style={{ color: run.error ? "var(--orchestr-danger)" : "var(--orchestr-ink-faint)" }}
                      title={run.error ?? undefined}
                    >
                      {run.error ?? ""}
                    </span>
                    {isOpen ? (
                      <ChevronDown size={14} style={{ color: "var(--orchestr-ink-subtle)" }} />
                    ) : (
                      <ChevronRight size={14} style={{ color: "var(--orchestr-ink-subtle)" }} />
                    )}
                  </button>
                  {isOpen && <RunDetailPanel detail={detail} error={detailError} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
