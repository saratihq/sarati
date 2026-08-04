"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, CheckCircle2, ExternalLink, FlaskConical, XCircle } from "lucide-react";
import * as api from "@/api/client";
import type { ReviewTestRun, ReviewTestSummary } from "@/api/client";
import type { EnvironmentSummary } from "@/api/environments";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { timeAgo } from "@/lib/format";
import { REAL_RUN_CONSEQUENCE } from "@/lib/realRun";
import { toast } from "@/lib/toast";

// Sentinel for the "Default (your connections)" option — an empty string can
// never collide with a real env id.
const DEFAULT_ENV = "";
const VALUE_TRUNCATE = 60;

interface ReviewTestPanelProps {
  workflowId: string;
  reviewId: string;
  /** Named environments to scope the test to; null = list unavailable (Default only). */
  environments: EnvironmentSummary[] | null;
  /** The persisted / latest test result to render, or null if never tested. */
  result: ReviewTestSummary | null;
  /** Lift a fresh result up so the card's merge-gate warning stays in sync. */
  onResult: (r: ReviewTestSummary) => void;
  /** False once the review is merged/closed — the result stays, running is off. */
  canRun: boolean;
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

// A before → after value pair, reusing the review diff-cell colors.
function ValueCell({ value, side }: { value: unknown; side: "before" | "after" }) {
  const raw = formatValue(value);
  const truncated = raw.length > VALUE_TRUNCATE;
  const text = truncated ? `${raw.slice(0, VALUE_TRUNCATE)}…` : raw;
  const isBefore = side === "before";
  return (
    <span
      className="inline-block py-0.5 px-1.5 rounded font-mono text-[10px] align-middle"
      title={truncated ? raw : undefined}
      style={{
        background: isBefore ? "var(--orchestr-danger-tint)" : "var(--orchestr-success-tint)",
        color: isBefore ? "var(--orchestr-danger)" : "var(--orchestr-success)",
      }}
    >
      <span style={{ textDecoration: isBefore ? "line-through" : undefined }}>{text}</span>
    </span>
  );
}

// One node-id chip for whole outputs that appeared / disappeared head-vs-baseline.
function NodeChip({ id, tone }: { id: string; tone: "added" | "removed" }) {
  const added = tone === "added";
  return (
    <span
      className="inline-block py-0.5 px-1.5 rounded font-mono text-[10px]"
      style={{
        background: added ? "var(--orchestr-success-tint)" : "var(--orchestr-danger-tint)",
        color: added ? "var(--orchestr-success)" : "var(--orchestr-danger)",
      }}
    >
      {id}
    </span>
  );
}

// One side of the replay — links to its run and shows how it landed.
function RunSideRow({
  label,
  workflowId,
  run,
}: {
  label: string;
  workflowId: string;
  run: ReviewTestRun;
}) {
  const errored = run.status === "error";
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <span className="shrink-0 font-semibold" style={{ color: "var(--orchestr-ink-muted)" }}>
        {label}
      </span>
      <span
        className="shrink-0"
        style={{ color: errored ? "var(--orchestr-danger)" : "var(--orchestr-success)" }}
      >
        {errored ? "errored" : "completed"}
      </span>
      <Link
        href={`/workflows/${workflowId}/runs?run=${run.run_id}`}
        className="inline-flex items-center gap-1 underline underline-offset-2 shrink-0"
        style={{ color: "var(--orchestr-ink-subtle)" }}
      >
        <span className="font-mono">{run.run_id.slice(0, 8)}</span>
        <ExternalLink size={10} />
      </Link>
      {errored && run.error && (
        <span className="min-w-0 break-words" style={{ color: "var(--orchestr-danger)" }}>
          {run.error}
        </span>
      )}
    </div>
  );
}

function TestResult({ result, workflowId }: { result: ReviewTestSummary; workflowId: string }) {
  const green = result.verdict === "green";
  const { changed, added, removed } = result.regression;
  const noChanges = changed.length === 0 && added.length === 0 && removed.length === 0;
  const Icon = green ? CheckCircle2 : XCircle;
  const tone = green ? "var(--orchestr-success)" : "var(--orchestr-danger)";
  const tint = green ? "var(--orchestr-success-tint)" : "var(--orchestr-danger-tint)";

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="inline-flex items-center gap-1.5 py-0.5 px-2 rounded-full text-[11px] font-semibold"
          style={{ background: tint, color: tone }}
        >
          <Icon size={13} />
          {green ? "Passed" : "Failing"}
        </span>
        <span className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
          Tested {timeAgo(result.tested_at)}
        </span>
      </div>

      {!green && (
        <div
          className="rounded-lg py-2 px-2.5 text-[12px]"
          style={{ background: "var(--orchestr-danger-tint)", color: "var(--orchestr-danger)" }}
        >
          <div className="font-semibold">This branch introduces a new failure.</div>
          {result.head.error && (
            <div className="mt-0.5 break-words" style={{ color: "var(--orchestr-danger)" }}>
              {result.head.error}
            </div>
          )}
        </div>
      )}

      {/* Field-level output regression, styled like the review diff cells. */}
      {noChanges ? (
        <div className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
          No output changes.
        </div>
      ) : (
        <div className="space-y-1.5">
          {changed.map((c) => (
            <div key={`${c.node_id}:${c.path}`} className="flex items-center gap-1.5 flex-wrap text-[11px]">
              <span className="font-mono" style={{ color: "var(--orchestr-ink-muted)" }}>
                {c.node_id}
              </span>
              <span style={{ color: "var(--orchestr-ink-subtle)" }}>·</span>
              <span className="font-mono" style={{ color: "var(--orchestr-ink-subtle)" }}>
                {c.path}
              </span>
              <ValueCell value={c.before} side="before" />
              <ArrowRight size={11} style={{ color: "var(--orchestr-ink-subtle)" }} />
              <ValueCell value={c.after} side="after" />
            </div>
          ))}
          {added.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
              <span style={{ color: "var(--orchestr-ink-subtle)" }}>Added output:</span>
              {added.map((id) => (
                <NodeChip key={id} id={id} tone="added" />
              ))}
            </div>
          )}
          {removed.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
              <span style={{ color: "var(--orchestr-ink-subtle)" }}>Removed output:</span>
              {removed.map((id) => (
                <NodeChip key={id} id={id} tone="removed" />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="space-y-1 pt-0.5">
        <RunSideRow label="Baseline (target)" workflowId={workflowId} run={result.base} />
        <RunSideRow label="This branch (head)" workflowId={workflowId} run={result.head} />
      </div>
    </div>
  );
}

export default function ReviewTestPanel({
  workflowId,
  reviewId,
  environments,
  result,
  onResult,
  canRun,
}: ReviewTestPanelProps) {
  const [envId, setEnvId] = useState<string>(DEFAULT_ENV);
  const [payloadSource, setPayloadSource] = useState<"latest" | "paste">("latest");
  const [payloadText, setPayloadText] = useState("");
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);

  // prod first, matching the Promote menu's ordering.
  const sortedEnvs = environments
    ? [...environments].sort((a, b) => Number(b.is_prod) - Number(a.is_prod))
    : [];
  const envLabel =
    envId === DEFAULT_ENV
      ? "Default (your connections)"
      : (sortedEnvs.find((e) => e.id === envId)?.name ?? "the selected environment");

  // Paste mode needs a non-empty payload; Latest run reuses the workflow's last trigger.
  const pasteEmpty = payloadSource === "paste" && payloadText.trim() === "";
  const runDisabled = running || pasteEmpty;

  const buildBody = (): { environment_id?: string; trigger_payload?: unknown } | null => {
    const body: { environment_id?: string; trigger_payload?: unknown } = {};
    if (envId !== DEFAULT_ENV) body.environment_id = envId;
    if (payloadSource === "paste") {
      try {
        body.trigger_payload = JSON.parse(payloadText);
      } catch {
        setPayloadError("That payload isn't valid JSON.");
        return null;
      }
    }
    return body;
  };

  const handleTestClick = () => {
    setPayloadError(null);
    // Validate the JSON up front so the confirm never opens on a payload that would fail.
    if (buildBody() === null) return;
    setConfirmOpen(true);
  };

  const runTest = async () => {
    setConfirmOpen(false);
    const body = buildBody();
    if (body === null) return;
    setRunning(true);
    try {
      const summary = await api.testReviewBranch(workflowId, reviewId, body);
      onResult(summary);
      if (summary.verdict === "green") {
        toast.success("Branch passed", "No new failure introduced.");
      } else {
        toast.error("Branch is failing", summary.head.error ?? "The change errors where the baseline passed.");
      }
    } catch (e) {
      toast.error("Test failed to run", e instanceof Error ? e.message : undefined);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--orchestr-line)" }}>
      <div className="flex items-center gap-1.5 mb-2">
        <FlaskConical size={13} style={{ color: "var(--orchestr-ink-muted)" }} />
        <span
          className="text-[11px] uppercase tracking-[1px] font-semibold"
          style={{ color: "var(--orchestr-ink-muted)" }}
        >
          Test this branch
        </span>
      </div>

      {canRun && (
        <div className="space-y-2.5">
          {/* Environment + payload source controls */}
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-medium" style={{ color: "var(--orchestr-ink-subtle)" }}>
                Environment
              </span>
              <select
                value={envId}
                onChange={(e) => setEnvId(e.target.value)}
                className="py-1.5 px-2.5 rounded text-[12px] outline-none cursor-pointer"
                style={{
                  background: "var(--orchestr-accent-tint)",
                  color: "var(--orchestr-ink)",
                  border: "1px solid var(--orchestr-line)",
                }}
              >
                <option value={DEFAULT_ENV}>Default (your connections)</option>
                {sortedEnvs.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium" style={{ color: "var(--orchestr-ink-subtle)" }}>
                Trigger payload
              </span>
              <div
                className="inline-flex rounded overflow-hidden"
                style={{ border: "1px solid var(--orchestr-line)" }}
              >
                {(["latest", "paste"] as const).map((src) => {
                  const active = payloadSource === src;
                  return (
                    <button
                      key={src}
                      type="button"
                      onClick={() => {
                        setPayloadSource(src);
                        setPayloadError(null);
                      }}
                      className="py-1.5 px-2.5 text-[12px] cursor-pointer border-none"
                      style={{
                        background: active ? "var(--orchestr-accent-tint)" : "transparent",
                        color: active ? "var(--orchestr-ink)" : "var(--orchestr-ink-muted)",
                        fontWeight: active ? 600 : 400,
                      }}
                    >
                      {src === "latest" ? "Latest run" : "Paste JSON"}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {payloadSource === "paste" && (
            <div>
              <textarea
                value={payloadText}
                onChange={(e) => {
                  setPayloadText(e.target.value);
                  setPayloadError(null);
                }}
                placeholder='{"example": "trigger payload"}'
                rows={3}
                spellCheck={false}
                className="w-full py-1.5 px-2.5 rounded text-[12px] font-mono border-none outline-none resize-y"
                style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink)" }}
              />
              {payloadError && (
                <div className="text-[11px] mt-1" style={{ color: "var(--orchestr-danger)" }}>
                  {payloadError}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2.5">
            <Button variant="ai" size="sm" onClick={handleTestClick} disabled={runDisabled}>
              {running ? "Running test…" : "Test this branch"}
            </Button>
            {pasteEmpty && !running && (
              <span className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
                Paste a JSON payload, or switch to Latest run.
              </span>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className={canRun ? "mt-3" : ""}>
          <TestResult result={result} workflowId={workflowId} />
        </div>
      )}

      {!canRun && !result && (
        <div className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
          This review was never tested.
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Run a real test?"
        message={`This runs both branches for real on ${envLabel} — the target (baseline) and this branch (head). Live steps will execute.`}
        consequence={REAL_RUN_CONSEQUENCE}
        confirmLabel="Run test"
        cancelLabel="Cancel"
        onConfirm={() => void runTest()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
