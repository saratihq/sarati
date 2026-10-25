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

/** The environments some of a trigger's activations are in, and whether that is every one. */
interface Scope {
  environments: string[];
  everywhere: boolean;
}

interface HealthView {
  /** When the activations running unheld were last polled; null when none is. */
  checked: string | null;
  /** The environments whose account holds the trigger back or holds it, and each one's reason, which names its fix. */
  heldBack: Array<{ environment: string; reason: string }>;
  /** Where it takes no events. */
  notListening: Scope;
  /** Where it is held while still taking what its app sends. */
  held: Scope;
  error: string | null;
}

function scopeOf(some: TriggerActivationHealth[], all: TriggerActivationHealth[]): Scope {
  return { environments: [...new Set(some.map((h) => h.environment))], everywhere: some.length === all.length };
}

/** Runtime health across ACTIVE activations: where it listens, why any is held back or held, the most recent poll of those running unheld, and the last failure. */
function healthView(health: TriggerActivationHealth[] | null): HealthView | null {
  const active = (health ?? []).filter((h) => h.active);
  if (active.length === 0) return null;

  // A held or held-back activation's last_error is why, never a failed run.
  const heldBack = active
    .filter((h) => h.held_back_by_slot)
    .map((h) => ({ environment: h.environment, reason: h.last_error ?? "" }));
  const notListening = scopeOf(active.filter((h) => !h.listening), active);
  const held = scopeOf(active.filter((h) => h.listening && h.held_back_by_slot), active);
  const view = { checked: null, heldBack, notListening, held, error: null };
  const running = active.filter((h) => !h.held_back_by_slot);
  if (running.length === 0) return view;

  const polls = running.map((h) => h.last_polled_at).filter((t): t is string => Boolean(t));
  const lastPolled = polls.sort().at(-1) ?? null;
  const checked = lastPolled ? `Last checked ${timeAgo(lastPolled)}` : "Not polled yet";

  const failed = running.filter((h) => h.last_error);
  if (failed.length === 0) return { ...view, checked };

  // Show the most-recently-polled failure; prefix the env only when several are live.
  const worst = failed.reduce((a, b) =>
    (b.last_polled_at ?? "") >= (a.last_polled_at ?? "") ? b : a,
  );
  const multiEnv = new Set(active.map((h) => h.environment)).size > 1;
  const detail = truncateError(worst.last_error ?? "");
  const error = `Last run failed: ${multiEnv ? `${worst.environment}: ${detail}` : detail}`;
  return { ...view, checked, error };
}

function scoped(text: string, scope: Scope): string {
  return scope.everywhere ? text : `${text} in ${scope.environments.join(", ")}`;
}

// Live, not listening or held by its environment's account in some or every environment, or not live yet.
function statusOf(
  manual: boolean,
  liveVersion: number | null,
  hasUnpublished: boolean,
  runtime: HealthView | null,
): { dot: string; text: string } {
  if (manual) return { dot: "var(--orchestr-ink-subtle)", text: "Runs on demand — never fires on its own" };
  if (liveVersion == null) {
    return { dot: "var(--orchestr-warning)", text: "Not live yet — publish a version to start it" };
  }
  if (runtime && runtime.notListening.environments.length > 0) {
    return { dot: "var(--orchestr-warning)", text: scoped("Not listening", runtime.notListening) };
  }
  if (runtime && runtime.held.environments.length > 0) {
    return { dot: "var(--orchestr-warning)", text: scoped("Held", runtime.held) };
  }
  return {
    dot: "var(--orchestr-success)",
    text: hasUnpublished ? "Live — head has unpublished changes" : "Live",
  };
}

/** Read-only trigger indicator for the overview — the trigger is configured on the canvas. */
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

  // Manual triggers never poll — they have no runtime health to show.
  const runtime = manual ? null : healthView(health ?? null);
  // Save ≠ Live: manual never auto-fires; anything else is live only once a version carrying it is published.
  const status = statusOf(manual, liveVersion, hasUnpublished, runtime);

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
          {runtime.heldBack.map((h, i) => (
            <span
              key={`${h.environment}-${i}`}
              className="text-[11px] leading-snug"
              style={{ color: "var(--orchestr-warning)" }}
            >
              {h.reason}
            </span>
          ))}
          {runtime.checked && (
            <span className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
              {runtime.checked}
            </span>
          )}
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
