"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { WorkflowSummary } from "@/api/client";
import { useWorkflow } from "@/store/useWorkflow";
import NodeIcon from "@/components/NodeIcon";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/format";

interface WorkflowCardProps {
  workflow: WorkflowSummary;
}

const MAX_STACK_ICONS = 5;

// Same tag palette as the feed / environments rail — env chips only.
const ENV_CHIP_COLORS: Record<string, { bg: string; text: string }> = {
  uat: { bg: "var(--orchestr-warning-tint)", text: "var(--orchestr-warning)" },
  staging: { bg: "var(--orchestr-info-tint)", text: "var(--orchestr-info)" },
  dev: { bg: "var(--orchestr-violet-tint)", text: "var(--orchestr-violet)" },
};

function envChipColor(env: string) {
  return (
    ENV_CHIP_COLORS[env] || {
      bg: "var(--orchestr-accent-tint)",
      text: "var(--orchestr-ink-muted)",
    }
  );
}

export default function WorkflowCard({ workflow }: WorkflowCardProps) {
  const router = useRouter();
  const highlightedWorkflowId = useWorkflow((s) => s.highlightedWorkflowId);
  const clearHighlight = useWorkflow((s) => s.clearHighlight);

  const highlighted = highlightedWorkflowId === workflow.id;

  useEffect(() => {
    if (!highlighted) return;
    const timer = setTimeout(clearHighlight, 3000);
    return () => clearTimeout(timer);
  }, [highlighted, clearHighlight]);

  // Integration stack — one chip per distinct node type.
  const distinctTypes = Array.from(new Set(workflow.node_types || []));
  const stackTypes = distinctTypes.slice(0, MAX_STACK_ICONS);
  const stackOverflow = distinctTypes.length - stackTypes.length;

  return (
    <div
      className={`group h-full flex flex-col rounded-xl p-5 transition-all duration-200 cursor-pointer border hover:-translate-y-[1px] hover:shadow-[0_8px_24px_rgba(0,0,0,0.35)] ${
        highlighted
          ? "border-[var(--orchestr-accent-tint-strong)]"
          : "border-[var(--orchestr-line)] hover:border-[var(--orchestr-line-strong)]"
      }`}
      onClick={() => router.push(`/workflows/${workflow.id}/overview`)}
      style={{ background: "var(--orchestr-surface-card)" }}
    >
      {/* Integration stack + freshness */}
      <div className="flex items-center justify-between mb-3.5">
        <div className="flex items-center">
          {stackTypes.length > 0 ? (
            stackTypes.map((t, i) => (
              <div
                key={t}
                className={`w-7 h-7 rounded-lg flex items-center justify-center ${i > 0 ? "-ml-1.5" : ""}`}
                style={{
                  background: "var(--orchestr-surface-raised)",
                  border: "1px solid var(--orchestr-line-strong)",
                  zIndex: stackTypes.length - i,
                }}
              >
                <NodeIcon nodeType={t} size={15} />
              </div>
            ))
          ) : (
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center"
              style={{
                background: "var(--orchestr-surface-raised)",
                border: "1px solid var(--orchestr-line-strong)",
              }}
            >
              <NodeIcon nodeType="__unknown__" size={15} />
            </div>
          )}
          {stackOverflow > 0 && (
            <div
              className="h-7 -ml-1.5 px-1.5 rounded-lg flex items-center text-[10px] font-medium"
              style={{
                background: "var(--orchestr-surface-raised)",
                border: "1px solid var(--orchestr-line-strong)",
                color: "var(--orchestr-ink-muted)",
              }}
            >
              +{stackOverflow}
            </div>
          )}
        </div>
        {workflow.created_at && (
          <span
            className="text-[10px] shrink-0"
            style={{ color: "var(--orchestr-ink-subtle)" }}
          >
            {timeAgo(workflow.created_at)}
          </span>
        )}
      </div>

      {/* Name + badges */}
      <div className="flex items-center gap-2 min-w-0">
        <h4
          className="text-[15px] font-semibold m-0 truncate"
          style={{ color: "var(--orchestr-ink)" }}
        >
          {workflow.name}
        </h4>
        {workflow.source === "imported" && (
          <span
            className="text-[9px] py-[1px] px-1.5 rounded font-semibold uppercase shrink-0"
            style={{
              background: "var(--orchestr-accent-tint)",
              color: "var(--orchestr-ink-muted)",
            }}
          >
            Imported
          </span>
        )}
        {/* Env chips (H1) — only when a NON-prod pointer exists, so the common
            prod-only case stays clean. */}
        {(workflow.environments ?? []).map((env) => {
          const color = envChipColor(env);
          return (
            <span
              key={env}
              className="text-[9px] py-[1px] px-1.5 rounded font-semibold uppercase shrink-0"
              style={{ background: color.bg, color: color.text }}
            >
              {env}
            </span>
          );
        })}
      </div>

      {/* Status + meta */}
      <div
        className="flex items-center gap-2 mt-2 text-[11px]"
        style={{ color: "var(--orchestr-ink-muted)" }}
      >
        <span className="flex items-center gap-1.5">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: workflow.active
                ? "var(--orchestr-success)"
                : "var(--orchestr-ink-subtle)",
            }}
          />
          {workflow.active ? "Active" : "Paused"}
        </span>
        <span style={{ color: "var(--orchestr-ink-faint)" }}>·</span>
        <span>
          {workflow.node_count} node{workflow.node_count !== 1 ? "s" : ""}
        </span>
        {workflow.version_count != null && workflow.version_count > 0 && (
          <>
            <span style={{ color: "var(--orchestr-ink-faint)" }}>·</span>
            <span>
              {workflow.version_count} version
              {workflow.version_count !== 1 ? "s" : ""}
            </span>
          </>
        )}
      </div>

      {/* Actions */}
      <div
        className="flex items-center justify-between gap-1 mt-4 pt-3 border-t border-[var(--orchestr-line)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Versions/executions/reviews all live on the one-page overview now. */}
        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => router.push(`/workflows/${workflow.id}/overview`)}
          >
            Open
          </Button>
        </div>
      </div>
    </div>
  );
}
