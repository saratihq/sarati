"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import * as api from "@/api/client";
import type { Connection } from "@/api/client";
import { appDisplayName } from "@/lib/connections";

/**
 * Warns when a step of this workflow references a non-active connection. Derived client-side by
 * joining `parameters.connectionId` against the caller's own connections — unseen ones are skipped.
 */
export default function ConnectionHealthBanner({ nodes }: { nodes: Record<string, unknown>[] | null }) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .listConnections()
      .then(({ connections: c }) => {
        if (!cancelled) setConnections(c);
      })
      .catch(() => {
        /* best-effort surface — on failure the banner simply stays hidden */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const broken = useMemo(() => {
    if (!nodes || !connections) return [];
    const referenced = new Set<string>();
    for (const node of nodes) {
      const params = (node as { parameters?: Record<string, unknown> }).parameters;
      const id = params?.connectionId;
      if (typeof id === "string" && id) referenced.add(id);
    }
    return connections.filter((c) => referenced.has(c.id) && (c.status ?? "active") !== "active");
  }, [nodes, connections]);

  if (broken.length === 0) return null;

  const names = [...new Set(broken.map((c) => c.display_name || appDisplayName(c.provider)))];
  const text =
    names.length === 1
      ? `The ${names[0]} connection needs reconnecting`
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} connections need reconnecting`;
  const reasons = broken
    .map((c) => c.status_reason)
    .filter((r): r is string => typeof r === "string" && r.length > 0);

  return (
    <div
      role="status"
      data-testid="connection-health-banner"
      className="flex items-center gap-2 py-2 px-3 rounded-lg mb-4"
      style={{ background: "var(--orchestr-warning-tint)", border: "1px solid var(--orchestr-warning)" }}
    >
      <AlertTriangle size={13} className="shrink-0" style={{ color: "var(--orchestr-warning)" }} />
      <span className="text-xs" style={{ color: "var(--orchestr-ink)" }} title={reasons.join("\n")}>
        {text} —{" "}
        <Link href="/integrations" className="underline" style={{ color: "var(--orchestr-ink)" }}>
          fix {names.length === 1 ? "it" : "them"} in Integrations
        </Link>
        .
      </span>
    </div>
  );
}
