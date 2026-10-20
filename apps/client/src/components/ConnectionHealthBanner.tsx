"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import * as api from "@/api/client";
import type { Connection } from "@/api/client";
import { appDisplayName } from "@/lib/connections";

type Nodes = Record<string, unknown>[];

const inactive = (c: Connection): boolean => (c.status ?? "active") !== "active";

// The accounts steps choose, joined against the caller's own connections; unseen ones are skipped.
async function chosenBroken(nodes: Nodes): Promise<Connection[]> {
  const chosen = new Set(
    nodes.flatMap((node) => {
      const id = (node as { parameters?: Record<string, unknown> }).parameters?.connectionId;
      return typeof id === "string" && id ? [id] : [];
    }),
  );
  const { connections } = await api.listConnections();
  return connections.filter((c) => chosen.has(c.id) && inactive(c));
}

// A step the run-as rule finds no active account for runs as your only one once it is reconnected; `?app=` matches as the rule does.
async function onlyAccountBroken(nodes: Nodes): Promise<Connection[]> {
  const { steps } = await api.runAsAccounts({ nodes });
  const unserved = steps.filter((s) => s.state === "none");
  const apps = [...new Set(unserved.map((s) => s.app))];
  const broken = await Promise.all(
    apps.map(async (app) => {
      const managedOnly = unserved.every((s) => s.app !== app || s.managed_only);
      const { connections } = await api.listConnections(app);
      return connections.filter((c) => inactive(c) && (!managedOnly || c.auth_type === "managed"));
    }),
  );
  return broken.flat();
}

/** Warns when a step would run as a connection that isn't active — one it chose, or its only one, as the run-as rule answers. */
export default function ConnectionHealthBanner({ nodes }: { nodes: Nodes | null }) {
  const [found, setFound] = useState<{ nodes: Nodes; broken: Connection[] } | null>(null);
  useEffect(() => {
    if (!nodes) return;
    let cancelled = false;
    const quiet = (): Connection[] => [];
    void Promise.all([chosenBroken(nodes).catch(quiet), onlyAccountBroken(nodes).catch(quiet)]).then((halves) => {
      if (cancelled) return;
      const byId = new Map(halves.flat().map((c) => [c.id, c]));
      setFound({ nodes, broken: [...byId.values()] });
    });
    return () => {
      cancelled = true;
    };
  }, [nodes]);

  // An answer for another document never shows over this one.
  const broken = found && found.nodes === nodes ? found.broken : [];
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
