"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "@/api/client";
import type { Connection } from "@/api/client";
import { useWorkflow } from "@/store/useWorkflow";
import { useNodeIcons } from "@/store/useNodeIcons";
import { catalogEntryFor } from "./NodeCatalogPanel";
import { activeConnections, appDisplayName, matchingConnections } from "@/lib/connections";
import ConnectAppButton from "./ConnectAppButton";
import NodeIcon from "./NodeIcon";

interface IrNodeShape {
  id: string;
  node_type?: string;
  parameters?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Post-generation connection capture: silently attaches the app's single account to steps that need
 * one, and offers a Connect chip per unconnected app. Never blocks Create/Deploy.
 */
export default function ConnectCaptureBanner() {
  const workflowJson = useWorkflow((s) => s.workflowJson);
  const updateIrNode = useWorkflow((s) => s.updateIrNode);

  const nodes = useMemo(
    () =>
      ((workflowJson?.nodes as IrNodeShape[] | undefined) ?? []).filter(
        // Action steps only: triggers (ADR 0018) resolve their connection from the environment slot,
        // and their types aren't in the action catalog, so the lookup below would never resolve.
        (n) => n.id && n.node_type?.includes(".") && n.metadata?.trigger !== true,
      ),
    [workflowJson],
  );

  // Which node types require a connection, per the catalog; unknown types resolve to false.
  const [needsAuth, setNeedsAuth] = useState<Record<string, boolean>>({});
  const [lookupRetry, setLookupRetry] = useState(0);
  useEffect(() => {
    const missing = [...new Set(nodes.map((n) => n.node_type as string))].filter((t) => !(t in needsAuth));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map(async (t) => [t, await catalogEntryFor(t)] as const),
    ).then((pairs) => {
      if (cancelled) return;
      setNeedsAuth((prev) => {
        const next = { ...prev };
        let changed = false;
        // A null entry is a FAILED lookup, not "no auth needed" — leave it missing so the retry re-asks.
        for (const [t, entry] of pairs) {
          if (entry) {
            next[t] = entry.auth === "connection";
            changed = true;
          }
        }
        // Must return the SAME reference when nothing resolved: this effect depends on needsAuth,
        // so a fresh object for an unresolvable type is an infinite render loop.
        return changed ? next : prev;
      });
      if (pairs.some(([, entry]) => !entry)) {
        setTimeout(() => setLookupRetry((n) => (n < 5 ? n + 1 : n)), 2000);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [nodes, needsAuth, lookupRetry]);

  const [connections, setConnections] = useState<Connection[] | null>(null);
  const loadConnections = useCallback(() => {
    api
      .listConnections()
      // Active-only: silent auto-attach must never grab a pending/failed row.
      .then(({ connections: rows }) => setConnections(activeConnections(rows)))
      .catch(() => {
        // Keep whatever we knew: an initial failure leaves `null`, so the banner stays hidden.
      });
  }, []);
  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  // Steps that need a connection and have none, grouped by app slug.
  const needingByApp = useMemo(() => {
    const byApp = new Map<string, string[]>();
    for (const n of nodes) {
      if (!needsAuth[n.node_type as string]) continue;
      const cid = n.parameters?.connectionId;
      if (typeof cid === "string" && cid !== "") continue;
      const app = (n.node_type as string).split(".")[0];
      byApp.set(app, [...(byApp.get(app) ?? []), n.id]);
    }
    return byApp;
  }, [nodes, needsAuth]);

  // Exactly one account for the app → attach it; re-reads the live node so concurrent edits survive.
  useEffect(() => {
    if (!connections) return;
    for (const [app, nodeIds] of needingByApp) {
      const matches = matchingConnections(connections, app);
      if (matches.length !== 1) continue;
      for (const id of nodeIds) {
        const doc = useWorkflow.getState().workflowJson as { nodes?: IrNodeShape[] } | null;
        const live = doc?.nodes?.find((n) => n.id === id);
        if (!live) continue;
        const p = live.parameters ?? {};
        if (typeof p.connectionId === "string" && p.connectionId !== "") continue;
        // markDirty: false — silent capture is a default, not a user edit, so Save must stay quiet.
        updateIrNode(id, { parameters: { ...p, connectionId: matches[0].id } }, { markDirty: false });
      }
    }
  }, [connections, needingByApp, updateIrNode]);

  // Banner entries: apps with zero connected accounts (several accounts is the inspector's choice).
  const unconnected = useMemo(() => {
    if (!connections) return [];
    return [...needingByApp.keys()].filter((app) => matchingConnections(connections, app).length === 0);
  }, [connections, needingByApp]);

  useEffect(() => {
    if (unconnected.length > 0) {
      void useNodeIcons.getState().fetchIcons(unconnected.map((app) => `${app}.connection`));
    }
  }, [unconnected]);

  if (unconnected.length === 0) return null;

  return (
    <div
      role="status"
      data-testid="connect-capture-banner"
      className="flex items-center flex-wrap gap-x-3 gap-y-2 rounded-xl px-3.5 py-2.5 mt-3"
      style={{ background: "var(--orchestr-accent-tint)", border: "1px solid var(--orchestr-line)" }}
    >
      <span className="text-[12px]" style={{ color: "var(--orchestr-ink-muted)" }}>
        <span className="font-semibold" style={{ color: "var(--orchestr-ink)" }}>
          {unconnected.length === 1 ? "1 app needs connecting" : `${unconnected.length} apps need connecting`}
        </span>{" "}
        — those steps will use the account you connect.
      </span>
      {unconnected.map((app) => (
        <ConnectAppButton
          key={app}
          app={app}
          appName={appDisplayName(app)}
          onConnected={loadConnections}
          size="xs"
          variant="secondary"
          data-testid={`connect-app-${app}`}
        >
          <NodeIcon nodeType={`${app}.connection`} size={12} />
          Connect {appDisplayName(app)}
        </ConnectAppButton>
      ))}
    </div>
  );
}
