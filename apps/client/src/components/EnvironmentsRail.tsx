"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Rocket } from "lucide-react";
import * as api from "@/api/client";
import type { EnvPointer } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/term";
import { ENV_POINTER_GATE } from "@/store/useOrgs";
import { getTagColor } from "@/lib/envPresentation";

/** The live/draft version the rail points at (number + its IR document). */
interface RunTarget {
  number: number;
  json: Record<string, unknown>;
}

const CARD_STYLE = {
  background: "var(--orchestr-surface-card)",
  border: "1px solid var(--orchestr-line)",
} as const;

interface EnvironmentsRailProps {
  workflowId: string;
  /** Bumped by the parent after feed mutations (deploys, rollbacks) — refetch. */
  refreshKey: number;
  /** Opens the parent's Publish dialog (field-diff release). */
  onRequestPublish?: () => void;
  /** ADR 0032 gate: false when the member can't move the live pointer, so Publish disables with a why. */
  canPublish?: boolean;
}

export default function EnvironmentsRail({
  workflowId,
  refreshKey,
  onRequestPublish,
  canPublish = true,
}: EnvironmentsRailProps) {
  // Save ≠ Live: `live` is the version the active pointer names, `draft` is the highest-numbered.
  const [runtime, setRuntime] = useState<{
    live: RunTarget | null;
    draft: RunTarget | null;
    pointers: EnvPointer[];
  } | null>(null);

  const [lastId, setLastId] = useState(workflowId);
  if (workflowId !== lastId) {
    setLastId(workflowId);
    setRuntime(null);
  }

  useEffect(() => {
    let cancelled = false;
    api
      .listVersions(workflowId, "main")
      .then((res) => {
        if (cancelled) return;
        const versions = res.versions ?? [];
        const head = versions.reduce(
          (a, b) => (a === null || b.version_number > a.version_number ? b : a),
          null as (typeof versions)[number] | null,
        );
        const liveV = res.active_version_id
          ? (versions.find((v) => v.id === res.active_version_id) ?? null)
          : null;
        const asTarget = (
          v: (typeof versions)[number] | null,
        ): RunTarget | null =>
          v?.workflow_json
            ? { number: v.version_number, json: v.workflow_json }
            : null;
        setRuntime({
          live: asTarget(liveV),
          draft: asTarget(head),
          pointers: res.env_pointers ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) setRuntime(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, refreshKey]);

  const live = runtime?.live ?? null;
  const draft = runtime?.draft ?? null;
  const unpublished =
    draft != null && (live == null || draft.number > live.number);
  // One environment keeps the single "Live" line; more than one renders the per-env list.
  const pointers = runtime?.pointers ?? [];
  const multiEnv = pointers.length > 1;
  return (
    <div className="space-y-4 min-w-0">
      <div>
        <div
          className="text-[11px] uppercase tracking-[1px] font-semibold mb-2"
          style={{ color: "var(--orchestr-ink-muted)" }}
        >
          Runtime
        </div>
        <div className="rounded-xl p-3.5" style={CARD_STYLE}>
          <Link
            href={`/workflows/${workflowId}/runs`}
            className="flex items-center gap-2 group"
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: "var(--orchestr-success)" }}
            />
            <span
              className="text-[12px] font-semibold group-hover:underline underline-offset-2"
              style={{ color: "var(--orchestr-ink)" }}
            >
              Live on Sarati
            </span>
            {!multiEnv && live && (
              <span
                className="text-[12px] font-mono font-semibold"
                style={{ color: "var(--orchestr-ink)" }}
              >
                v{live.number}
              </span>
            )}
            <span
              className="text-[11px] ml-auto opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ color: "var(--orchestr-ink-subtle)" }}
            >
              Runs →
            </span>
          </Link>
          {multiEnv && (
            <div className="mt-2 space-y-1.5">
              {pointers.map((p) => {
                const color = getTagColor(p.environment);
                return (
                  <div
                    key={p.environment}
                    className="flex items-center gap-2 text-[12px]"
                  >
                    <span
                      className="text-[9px] py-[1px] px-1.5 rounded font-semibold uppercase"
                      style={{ background: color.bg, color: color.text }}
                    >
                      {p.environment}
                    </span>
                    <span style={{ color: "var(--orchestr-ink-muted)" }}>
                      runs
                    </span>
                    <span
                      className="font-mono font-semibold"
                      style={{ color: "var(--orchestr-ink)" }}
                    >
                      v{p.version_number}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {unpublished && draft ? (
            <div className="mt-2.5 flex items-center gap-2 flex-wrap">
              <span
                className="text-[11px]"
                style={{ color: "var(--orchestr-ink-subtle)" }}
              >
                latest: v{draft.number}
              </span>
              {onRequestPublish &&
                (canPublish ? (
                  <Button variant="ghost" size="xs" onClick={onRequestPublish}>
                    <Rocket size={11} />
                    Publish
                  </Button>
                ) : (
                  <Tooltip content={ENV_POINTER_GATE.publish}>
                    <Button variant="ghost" size="xs" disabled>
                      <Rocket size={11} />
                      Publish
                    </Button>
                  </Tooltip>
                ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
