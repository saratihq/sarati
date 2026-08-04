"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, ChevronRight, Inbox, User, X } from "lucide-react";
import * as api from "@/api/client";
import type { WaitingRun } from "@/api/client";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import { useAuth } from "@/store/useAuth";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useApprovals } from "@/store/useApprovals";
import { SaratiLoader } from "./SaratiLogo";

const PAGE_POLL_MS = 10_000;

// "4m 32s left" / "overdue" — live countdown to a waiting run's timeout.
function timeoutCountdown(timeoutAt: string | null, now: number): string | null {
  if (!timeoutAt) return null;
  const t = new Date(timeoutAt).getTime();
  if (Number.isNaN(t)) return null;
  const remaining = Math.floor((t - now) / 1000);
  if (remaining <= 0) return "timed out";
  if (remaining < 60) return `${remaining}s left`;
  const minutes = Math.floor(remaining / 60);
  if (minutes < 60) return `${minutes}m ${remaining % 60}s left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m left`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
}

// One waiting run. Decisions drop the row optimistically and roll back on failure; Approve sends
// immediately, Reject holds the event behind an Undo toast and sends nothing if undone.
function WaitingRow({ run, now, mine }: { run: WaitingRun; now: number; mine: boolean }) {
  const remove = useApprovals((s) => s.remove);
  const restore = useApprovals((s) => s.restore);
  const settle = useApprovals((s) => s.settle);
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState("{}");

  const customParsed = useMemo(() => {
    try {
      return { value: JSON.parse(customText) as unknown, ok: true as const };
    } catch {
      return { value: undefined, ok: false as const };
    }
  }, [customText]);

  const deliver = async (payload: unknown): Promise<boolean> => {
    try {
      // Resume by the UNIQUE run id (org-wide: this may be a teammate's run).
      await api.sendRunEvent(run.id, { topic: run.topic, payload });
      settle(run.id);
      return true;
    } catch (e) {
      restore(run);
      toast.error("Couldn't deliver the event", e instanceof Error ? e.message : undefined);
      return false;
    }
  };

  const send = (payload: unknown, doneTitle: string) => {
    remove(run.id);
    void deliver(payload).then((ok) => {
      if (ok) toast.success(doneTitle, run.workflow_name ?? undefined);
    });
  };

  const approve = () => send({ decision: "approved", decided_at: new Date().toISOString() }, "Approved");

  const reject = () => {
    remove(run.id);
    toast.undoable("Run rejected", run.workflow_name ?? undefined, {
      // The rejection is only sent once the Undo window closes.
      onCommit: () => void deliver({ decision: "rejected", decided_at: new Date().toISOString() }),
      onUndo: () => restore(run),
    });
  };

  const countdown = timeoutCountdown(run.timeout_at, now);
  const overdue = countdown === "timed out";

  return (
    <li
      className="rounded-xl p-3.5"
      style={{ background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-line)" }}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            {run.workflow_id ? (
              <Link
                href={`/workflows/${run.workflow_id}/runs`}
                className="text-[13px] font-semibold truncate hover:underline underline-offset-2"
                style={{ color: "var(--orchestr-ink)" }}
              >
                {run.workflow_name || "Untitled workflow"}
              </Link>
            ) : (
              <span className="text-[13px] font-semibold truncate" style={{ color: "var(--orchestr-ink)" }}>
                {run.workflow_name || "Untitled workflow"}
              </span>
            )}
            <span
              className="text-[9px] py-[1px] px-1.5 rounded font-semibold uppercase"
              style={{ background: "var(--orchestr-warning-tint)", color: "var(--orchestr-warning)" }}
            >
              {run.topic}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1 text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
            <span className="inline-flex items-center gap-1">
              <User size={11} />
              {mine ? "you" : run.triggered_by.name || run.triggered_by.email || "a teammate"}
            </span>
            <span style={{ color: "var(--orchestr-ink-faint)" }}>·</span>
            <span>waiting {timeAgo(run.waiting_since)}</span>
            {countdown && (
              <>
                <span style={{ color: "var(--orchestr-ink-faint)" }}>·</span>
                <span style={{ color: overdue ? "var(--orchestr-danger)" : "var(--orchestr-ink-subtle)" }}>
                  {countdown}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="success" size="sm" onClick={approve}>
            <Check size={13} />
            Approve
          </Button>
          <Button variant="destructive" size="sm" onClick={reject}>
            <X size={13} />
            Reject
          </Button>
        </div>
      </div>

      {/* Custom payload — for topics that aren't a plain approve/reject. */}
      <div className="mt-2">
        <button
          onClick={() => setCustomOpen((v) => !v)}
          className="flex items-center gap-1 bg-transparent border-none cursor-pointer p-0 text-[11px]"
          style={{ color: "var(--orchestr-ink-subtle)" }}
        >
          {customOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Custom payload…
        </button>
        {customOpen && (
          <div className="mt-2">
            <textarea
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              rows={4}
              spellCheck={false}
              aria-label="Custom event payload (JSON)"
              className="w-full rounded-lg p-2.5 text-[11px] font-mono resize-y outline-none"
              style={{
                background: "var(--orchestr-field-strong)",
                border: `1px solid ${customParsed.ok ? "var(--orchestr-line)" : "var(--orchestr-danger)"}`,
                color: "var(--orchestr-ink)",
              }}
            />
            <div className="flex items-center gap-2 mt-1.5">
              <Button
                variant="secondary"
                size="sm"
                disabled={!customParsed.ok}
                onClick={() => send(customParsed.value, "Event sent")}
              >
                Send event
              </Button>
              {!customParsed.ok && (
                <span className="text-[11px]" style={{ color: "var(--orchestr-danger)" }}>
                  Not valid JSON yet
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

// Global approvals inbox: every run parked on a wait-for-event node across the org, on a poll.
export default function ApprovalsInboxPage() {
  useDocumentTitle("Approvals");
  const waiting = useApprovals((s) => s.waiting);
  const error = useApprovals((s) => s.error);
  const fetchWaiting = useApprovals((s) => s.fetchWaiting);
  const userId = useAuth((s) => s.user?.id ?? null);
  const [scope, setScope] = useState<"all" | "mine">("all");

  useEffect(() => {
    fetchWaiting();
    const t = setInterval(fetchWaiting, PAGE_POLL_MS);
    return () => clearInterval(t);
  }, [fetchWaiting]);

  // One shared ticker drives every row's timeout countdown.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!waiting || waiting.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);

  const isMine = (run: WaitingRun): boolean => run.triggered_by.id === userId;
  // The mine/all lens only earns its place once a teammate's run is on the list.
  const hasOthers = (waiting ?? []).some((r) => !isMine(r));
  const visible = (waiting ?? []).filter((r) => (scope === "mine" ? isMine(r) : true));

  return (
    <main className="flex-1 overflow-y-auto py-6 px-8">
      <div className="max-w-[760px] mx-auto">
        <div className="flex items-center gap-2.5 mb-6">
          <Inbox size={18} style={{ color: "var(--orchestr-ink-muted)" }} />
          <h1 className="text-[18px] font-semibold m-0" style={{ color: "var(--orchestr-ink)" }}>
            Approvals
          </h1>
          {waiting && waiting.length > 0 && (
            <span
              className="text-[11px] py-[1px] px-2 rounded-full font-semibold"
              style={{ background: "var(--orchestr-warning-tint)", color: "var(--orchestr-warning)" }}
            >
              {waiting.length}
            </span>
          )}
        </div>
        <p className="text-[12px] m-0 mb-5" style={{ color: "var(--orchestr-ink-muted)" }}>
          Runs paused on a wait-for-event step anywhere in this organization. Approving or rejecting resumes the
          run with your decision — you can act on a teammate&apos;s run, not just your own.
        </p>

        {/* Mine/all lens — only shown once someone else's run is on the list. */}
        {hasOthers && (
          <div className="inline-flex items-center gap-0.5 mb-4 p-0.5 rounded-lg" style={{ background: "var(--orchestr-accent-tint)" }}>
            {(["all", "mine"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className="text-[12px] px-2.5 py-1 rounded-md border-none cursor-pointer capitalize transition-colors"
                style={{
                  background: scope === s ? "var(--orchestr-surface-card)" : "transparent",
                  color: scope === s ? "var(--orchestr-ink)" : "var(--orchestr-ink-muted)",
                  fontWeight: scope === s ? 600 : 400,
                }}
              >
                {s === "all" ? "All" : "Mine"}
              </button>
            ))}
          </div>
        )}

        {error && waiting === null ? (
          <div
            className="rounded-xl py-12 text-center"
            style={{ background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-line)" }}
          >
            <p className="text-[13px] m-0" style={{ color: "var(--orchestr-danger)" }}>
              {error}
            </p>
            <button
              onClick={() => fetchWaiting()}
              className="text-[12px] mt-2 bg-transparent border-none cursor-pointer underline"
              style={{ color: "var(--orchestr-ink)" }}
            >
              Retry
            </button>
          </div>
        ) : waiting === null ? (
          <div className="flex items-center justify-center py-16">
            <SaratiLoader size={32} />
          </div>
        ) : visible.length === 0 ? (
          <div
            className="rounded-xl py-12 text-center"
            style={{
              background: "var(--orchestr-surface-card)",
              border: "1px solid var(--orchestr-line)",
            }}
          >
            <p className="text-[13px] m-0" style={{ color: "var(--orchestr-ink-muted)" }}>
              {waiting.length > 0 && scope === "mine" ? "None of the waiting runs are yours." : "Nothing waiting for approval."}
            </p>
            <p className="text-[12px] m-0 mt-1" style={{ color: "var(--orchestr-ink-subtle)" }}>
              {waiting.length > 0 && scope === "mine"
                ? "Switch to All to see the rest of the organization's runs."
                : "Runs pause here when they reach a wait-for-event step."}
            </p>
          </div>
        ) : (
          <ul className="list-none m-0 p-0 space-y-3">
            {visible.map((run) => (
              <WaitingRow key={run.id} run={run} now={now} mine={isMine(run)} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
