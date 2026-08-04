"use client";

import { Clock, MessageCircle, Webhook, Zap } from "lucide-react";
import type { TriggerActivationHealth } from "@/api/client";
import { timeAgo } from "@/lib/format";
import { findTriggerNode, isManualTrigger, triggerKindLabel } from "@/lib/triggerKind";

/** Cap a runtime error so one gnarly stack/message can't blow out the card. */
function truncateError(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 119)}…` : oneLine;
}

/** Runtime-health line: the most recent poll across ACTIVE activations, plus a note if any last failed. */
function healthView(health: TriggerActivationHealth[] | null): {
  checked: string;
  error: string | null;
} | null {
  const active = (health ?? []).filter((h) => h.active);
  if (active.length === 0) return null;

  const polls = active.map((h) => h.last_polled_at).filter((t): t is string => Boolean(t));
  const lastPolled = polls.sort().at(-1) ?? null;
  const checked = lastPolled ? `Last checked ${timeAgo(lastPolled)}` : "Not polled yet";

  const failed = active.filter((h) => h.last_error);
  if (failed.length === 0) return { checked, error: null };

  // Show the most-recently-polled failure; prefix the env only when several are live.
  const worst = failed.reduce((a, b) =>
    (b.last_polled_at ?? "") >= (a.last_polled_at ?? "") ? b : a,
  );
  const multiEnv = new Set(active.map((h) => h.environment)).size > 1;
  const detail = truncateError(worst.last_error ?? "");
  const error = `Last run failed: ${multiEnv ? `${worst.environment}: ${detail}` : detail}`;
  return { checked, error };
}

/** Read-only trigger indicator for the overview (ADR 0018) — the trigger is configured on the canvas. */
export default function TriggerActivationCard({
  nodes,
  liveVersion,
  hasUnpublished,
  health,
}: {
  nodes: Array<Record<string, unknown>> | null;
  liveVersion: number | null;
  hasUnpublished: boolean;
  health?: TriggerActivationHealth[] | null;
}) {
  const trigger = findTriggerNode(nodes);
  if (!trigger) return null;

  const nodeType = typeof trigger.node_type === "string" ? trigger.node_type : undefined;
  const label = triggerKindLabel(nodeType);
  const manual = isManualTrigger(nodeType);
  const Icon =
    nodeType === "orchestr:webhook"
      ? Webhook
      : nodeType === "orchestr:schedule"
        ? Clock
        : nodeType === "orchestr:chat"
          ? MessageCircle
          : Zap;

  // Save ≠ Live: manual never auto-fires; anything else is live only once a
  // version carrying it is published.
  const status: { dot: string; text: string } = manual
    ? { dot: "var(--orchestr-ink-subtle)", text: "Runs on demand — never fires on its own" }
    : liveVersion != null
      ? {
          dot: "var(--orchestr-success)",
          text: hasUnpublished ? "Live — head has unpublished changes" : "Live",
        }
      : { dot: "var(--orchestr-warning)", text: "Not live yet — publish a version to start it" };

  // Manual triggers never poll — they have no runtime health to show.
  const runtime = manual ? null : healthView(health ?? null);

  return (
    <section
      className="rounded-xl p-4"
      style={{ background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-line)" }}
      aria-label="Trigger"
    >
      <div className="flex items-center justify-between mb-2.5">
        <h3 className="text-[13px] font-semibold m-0" style={{ color: "var(--orchestr-ink)" }}>
          Trigger
        </h3>
        <span className="text-[10.5px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
          Set it on the canvas
        </span>
      </div>

      <div className="flex items-center gap-2 mb-2">
        <div
          className="w-8 h-8 rounded-[10px] flex items-center justify-center shrink-0"
          style={{ background: "var(--orchestr-surface-raised)", border: "1px solid var(--orchestr-line)" }}
        >
          <Icon size={15} style={{ color: "var(--orchestr-ink-muted)" }} />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] leading-tight" style={{ color: "var(--orchestr-ink-subtle)" }}>
            How it starts
          </div>
          <div className="text-[13px] font-medium leading-tight truncate" style={{ color: "var(--orchestr-ink)" }} title={label}>
            {label}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: status.dot }} aria-hidden />
        <span className="text-[11px]" style={{ color: "var(--orchestr-ink-muted)" }}>
          {status.text}
        </span>
      </div>

      {runtime && (
        <div className="mt-1.5 flex flex-col gap-1">
          <span className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
            {runtime.checked}
          </span>
          {runtime.error && (
            <span
              className="text-[11px] leading-snug"
              style={{ color: "var(--orchestr-danger)" }}
              title={runtime.error}
            >
              {runtime.error}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
