"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { Pencil, Activity, RefreshCw, Search, X } from "lucide-react";
import * as api from "@/api/client";
import type { Connection, ManagedApp } from "@/api/client";
import * as envApi from "@/api/environments";
import type { ConnectionReference } from "@/api/environments";
import { loadByoApps, type ByoApp } from "@/lib/byoConnect";
import { appDisplayName } from "@/lib/connections";
import { timeAgo } from "@/lib/format";
import { connectAppWithFeedback } from "@/lib/managedConnect";
import { toast } from "@/lib/toast";
import { useNodeIcons } from "@/store/useNodeIcons";
import ByoConnectForm from "./ByoConnectForm";
import NodeIcon from "./NodeIcon";
import { SaratiLoader } from "./SaratiLogo";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { InlineError } from "./ui/inline-error";

// Curated pre-search set, shown in this order. Slugs must match the managed apps list; misses are skipped.
const POPULAR_SLUGS = [
  "slack",
  "gmail",
  "sheets",
  "docs",
  "drive",
  "calendar",
  "notion",
  "github",
  "airtable",
  "hubspot",
  "linear",
  "jira",
  "asana",
  "discord",
  "zoom",
  "outlook",
  "dropbox",
  "stripe",
  "todoist",
  "clickup",
  "typeform",
  "calendly",
];
const POPULAR_SET = new Set(POPULAR_SLUGS);

// How a non-active connection reads in the band; `hint` is fallback copy — `status_reason` wins.
const STATUS_META: Record<
  "pending" | "expired" | "failed",
  { label: string; color: string; tint: string; hint: string }
> = {
  pending: {
    label: "Pending",
    color: "var(--orchestr-warning)",
    tint: "var(--orchestr-warning-tint)",
    hint: "Sign-in wasn't finished — reconnect to complete it",
  },
  expired: {
    label: "Expired",
    color: "var(--orchestr-danger)",
    tint: "var(--orchestr-danger-tint)",
    hint: "Access has expired — reconnect to fix it",
  },
  failed: {
    label: "Failed",
    color: "var(--orchestr-danger)",
    tint: "var(--orchestr-danger-tint)",
    hint: "This connection stopped working — reconnect to fix it",
  },
};
// Attention-first band order: broken first, then pending, then the healthy actives.
const STATUS_ORDER: Record<string, number> = { failed: 0, expired: 1, pending: 2, active: 3 };

/** The connect-an-app picker: connected band on top, searchable catalog below; never navigates. */
export default function ConnectionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <ConnectionsDialogBody onClose={onClose} />;
}

function ConnectionsDialogBody({ onClose }: { onClose: () => void }) {
  const [apps, setApps] = useState<ManagedApp[] | null>(null);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  // Separates "not fetched yet" from "genuinely empty", so the empty prompt can't flash during load.
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<Connection | null>(null);
  // Second-stage delete confirm after a 409: name the env slots holding it, then force.
  const [forceRemove, setForceRemove] = useState<{ connection: Connection; references: ConnectionReference[] } | null>(
    null,
  );
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  // `managedAvailable` picks the lead surface; `mode` stays null until known so nothing flashes.
  const [managedAvailable, setManagedAvailable] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"managed" | "byo" | null>(null);
  const [byoApps, setByoApps] = useState<ByoApp[] | null>(null);
  const [byoError, setByoError] = useState<string | null>(null);
  const [envProviders, setEnvProviders] = useState<Set<string>>(new Set());

  // The band shows EVERY connection with its status: pending/failed rows would otherwise be
  // invisible and unrecoverable. The grid's de-dup reads the same list.
  const refreshConnections = useCallback(() => {
    api
      .listConnections()
      .then(({ connections: c }) => {
        setConnections(c);
        setConnectionsLoaded(true);
        useNodeIcons.getState().fetchIcons(c.map((x) => `${x.provider}.connection`));
      })
      .catch(() => {
        /* the connect toast already reported; list catches up next open */
      });
  }, []);

  // The full catalog is fetched once and filtered client-side; the curation needs the whole list.
  const fetchApps = useCallback(() => {
    api
      .listManagedApps()
      .then(({ apps: rows }) => {
        setApps(rows);
        setAppsError(null);
        useNodeIcons.getState().fetchIcons(rows.map((a) => `${a.slug}.connection`));
      })
      .catch((e: unknown) => setAppsError(e instanceof Error ? e.message : "Failed to load apps"));
  }, []);

  // Capabilities + BYO catalog, all best-effort: a failure just leaves managed-first.
  const fetchByo = useCallback(() => {
    api
      .getConnectionCapabilities()
      .then(({ managed_available }) => {
        setManagedAvailable(managed_available);
        setMode((m) => m ?? (managed_available ? "managed" : "byo"));
      })
      .catch(() => {
        setManagedAvailable(true); // assume managed on an unknown; safe default
        setMode((m) => m ?? "managed");
      });
    loadByoApps()
      .then((rows) => {
        setByoApps(rows);
        setByoError(null);
      })
      .catch((e: unknown) => setByoError(e instanceof Error ? e.message : "Failed to load apps"));
    api
      .listIntegrationProviders()
      .then(({ providers }) => setEnvProviders(new Set(providers.map((p) => p.provider))))
      .catch(() => setEnvProviders(new Set()));
  }, []);

  useEffect(() => {
    refreshConnections();
    fetchApps();
    fetchByo();
  }, [refreshConnections, fetchApps, fetchByo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // One display-name source for the band and the grid: the catalog name, else a slug prettifier.
  const appNameBySlug = useMemo(
    () => new Map((apps ?? []).map((a) => [a.slug, a.name])),
    [apps],
  );
  const appLabel = useCallback(
    (slug: string) => appNameBySlug.get(slug) ?? appDisplayName(slug),
    [appNameBySlug],
  );

  // A plain delete 409s while env slots reference the connection; force only after confirm.
  const remove = async (c: Connection, force = false) => {
    setConnections((prev) => prev.filter((x) => x.id !== c.id));
    try {
      await envApi.deleteConnection(c.id, force);
      toast.success(`Disconnected ${c.display_name || appLabel(c.provider)}`);
    } catch (e) {
      if (e instanceof envApi.ConnectionInUseError) {
        setForceRemove({ connection: c, references: e.references });
      } else {
        toast.error("Couldn't disconnect", e instanceof Error ? e.message : undefined);
      }
      refreshConnections();
    }
  };

  // On-demand health check; the service's `detail` is already plain language, so it toasts verbatim.
  const [testingId, setTestingId] = useState<string | null>(null);
  /** Which account each connection answered as, once tested — kept for the life of the dialog. */
  const [accounts, setAccounts] = useState<Record<string, { name: string | null; id: string | null }>>({});
  const testConn = async (c: Connection) => {
    if (testingId) return;
    setTestingId(c.id);
    const label = c.display_name || appLabel(c.provider);
    try {
      const res = await api.testConnection(c.id);
      if (res.ok) {
        // Health is not identity: a valid token on the WRONG workspace passes every check.
        const named = await api.connectionAccount(c.id).catch(() => null);
        toast.success(`${label} is working`, named?.detail ?? res.detail);
        const identity = named?.account;
        if (identity) setAccounts((prev) => ({ ...prev, [c.id]: identity }));
      } else {
        toast.error(`${label} needs attention`, res.detail);
      }
      refreshConnections();
    } catch (e) {
      toast.error(`Couldn't check ${label}`, e instanceof Error ? e.message : undefined);
    } finally {
      setTestingId(null);
    }
  };

  // Reconnect re-runs the hosted connect flow, then retires the dead row the fresh account supersedes.
  const reconnect = async (c: Connection) => {
    if (reconnectingId) return;
    setReconnectingId(c.id);
    try {
      const newId = await connectAppWithFeedback(c.provider, appLabel(c.provider));
      if (!newId) return;
      try {
        await api.deleteConnection(c.id);
      } catch {
        // Best-effort: the new connection already works; the stale row just lingers.
      }
      refreshConnections();
    } finally {
      setReconnectingId(null);
    }
  };

  // Runnable apps only: executable !== false hides an app no rail can run.
  const searchable = useMemo(() => (apps ?? []).filter((a) => a.executable !== false), [apps]);
  const connectedCountBySlug = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of connections) m.set(c.provider, (m.get(c.provider) ?? 0) + 1);
    return m;
  }, [connections]);
  // Browsing hides already-connected apps (they're in the band); search still returns them, flagged.
  const available = useMemo(
    () => searchable.filter((a) => !connectedCountBySlug.has(a.slug)),
    [searchable, connectedCountBySlug],
  );

  const needle = q.trim().toLowerCase();
  const results = useMemo(
    () =>
      needle
        ? searchable.filter(
            (a) => a.slug.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle),
          )
        : [],
    [searchable, needle],
  );
  const popular = useMemo(() => {
    const bySlug = new Map(available.map((a) => [a.slug, a]));
    return POPULAR_SLUGS.map((s) => bySlug.get(s)).filter((a): a is ManagedApp => a !== undefined);
  }, [available]);
  const rest = useMemo(() => available.filter((a) => !POPULAR_SET.has(a.slug)), [available]);
  const bandConnections = useMemo(
    () =>
      [...connections].sort(
        (a, b) => (STATUS_ORDER[a.status ?? "active"] ?? 2) - (STATUS_ORDER[b.status ?? "active"] ?? 2),
      ),
    [connections],
  );

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Connect an app"
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.15 }}
        className="rounded-2xl w-full max-w-[560px] max-h-[80vh] flex flex-col overflow-hidden"
        style={{
          background: "var(--orchestr-surface-raised)",
          border: "1px solid var(--orchestr-line-strong)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold m-0" style={{ color: "var(--orchestr-ink)" }}>
              Connect an app
            </h2>
            <p className="text-[12px] m-0 mt-0.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
              {mode === "byo"
                ? "Connect an app with your own credentials."
                : "Sign in once — Sarati manages the credentials, nothing to configure."}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="bg-transparent border-none cursor-pointer p-1 rounded-lg shrink-0"
            style={{ color: "var(--orchestr-ink-subtle)" }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Connected band, height-capped so it can't crowd out the grid. */}
        {connections.length > 0 ? (
          <div className="px-5 pb-3">
            <div className="text-[11px] font-medium mb-2" style={{ color: "var(--orchestr-ink-muted)" }}>
              Connected
            </div>
            <div
              data-testid="connected-band"
              className="flex flex-wrap gap-1.5 overflow-y-auto pr-0.5"
              style={{ maxHeight: 104 }}
            >
              {bandConnections.map((c) => (
                <ConnectionChip
                  key={c.id}
                  connection={c}
                  label={c.display_name || appLabel(c.provider)}
                  account={accounts[c.id]}
                  reconnecting={reconnectingId === c.id}
                  testing={testingId === c.id}
                  onTest={() => void testConn(c)}
                  onReconnect={() => void reconnect(c)}
                  onRemove={() => setConfirmRemove(c)}
                  onRename={async (name) => {
                    const trimmed = name.trim();
                    if (trimmed === (c.display_name ?? "")) return;
                    try {
                      await api.renameConnection(c.id, trimmed === "" ? null : trimmed);
                      await refreshConnections();
                    } catch (e) {
                      toast.error("Couldn't rename", e instanceof Error ? e.message : undefined);
                    }
                  }}
                />
              ))}
            </div>
          </div>
        ) : connectionsLoaded ? (
          <div className="px-5 pb-3">
            <p
              data-testid="connections-empty"
              className="text-[12px] m-0"
              style={{ color: "var(--orchestr-ink-subtle)" }}
            >
              No connections yet — connect an app below to use it in your workflows.
            </p>
          </div>
        ) : null}

        {/* Search — managed grid only; the BYO form carries its own search */}
        {mode === "managed" && (
          <div className="px-5 pb-3">
            <div
              className="flex items-center gap-2 h-9 px-3 rounded-lg"
              style={{ background: "var(--orchestr-field)", border: "1px solid var(--orchestr-line)" }}
            >
              <Search size={13} style={{ color: "var(--orchestr-ink-subtle)" }} />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search apps — Slack, Gmail, Notion…"
                aria-label="Search apps"
                className="flex-1 bg-transparent border-none outline-none text-[12px]"
                style={{ color: "var(--orchestr-ink)" }}
              />
            </div>
          </div>
        )}

        {/* Connect area: the managed grid, the BYO form, or a loader until we know which leads. */}
        <div className="px-5 pb-5 overflow-y-auto flex-1 min-h-0">
          {mode === null ? (
            <div className="flex justify-center py-10">
              <SaratiLoader size={28} />
            </div>
          ) : mode === "byo" ? (
            byoError ? (
              <InlineError message={byoError} onRetry={fetchByo} />
            ) : byoApps === null ? (
              <div className="flex justify-center py-10">
                <SaratiLoader size={28} />
              </div>
            ) : (
              <ByoConnectForm
                apps={byoApps}
                envProviders={envProviders}
                onConnected={refreshConnections}
                onBack={managedAvailable ? () => setMode("managed") : undefined}
              />
            )
          ) : (
            <>
              {apps === null && !appsError ? (
            <div className="flex justify-center py-10">
              <SaratiLoader size={28} />
            </div>
          ) : appsError ? (
            <InlineError message={appsError} onRetry={fetchApps} />
          ) : needle ? (
            // Searching: one flat grid over the whole catalog, connected apps included and flagged.
            results.length === 0 ? (
              <p className="text-xs text-center py-6" style={{ color: "var(--orchestr-ink-subtle)" }}>
                No apps match “{q.trim()}”.
              </p>
            ) : (
              <AppGrid apps={results} connectedCountBySlug={connectedCountBySlug} onConnected={refreshConnections} />
            )
          ) : (
            <div className="flex flex-col gap-4">
              {popular.length > 0 && (
                <Section label="Popular">
                  <AppGrid apps={popular} connectedCountBySlug={connectedCountBySlug} onConnected={refreshConnections} />
                </Section>
              )}
              {rest.length > 0 &&
                (showAll ? (
                  <Section label={`All apps (${available.length})`}>
                    <AppGrid apps={rest} connectedCountBySlug={connectedCountBySlug} onConnected={refreshConnections} />
                  </Section>
                ) : (
                  <button
                    onClick={() => setShowAll(true)}
                    className="self-start text-[12px] font-medium bg-transparent border-none cursor-pointer px-0 py-1"
                    style={{ color: "var(--orchestr-accent)" }}
                  >
                    Show all {available.length} apps
                  </button>
                ))}
            </div>
              )}

              {/* The BYO escape hatch; hidden when no app exposes a scheme. */}
              {(byoApps?.length ?? 0) > 0 && (
                <button
                  onClick={() => setMode("byo")}
                  data-testid="use-own-credentials"
                  className="block mt-4 text-[12px] font-medium bg-transparent border-none cursor-pointer px-0 py-1"
                  style={{ color: "var(--orchestr-accent)" }}
                >
                  Use your own credentials →
                </button>
              )}
            </>
          )}
        </div>
      </motion.div>

      <ConfirmDialog
        open={confirmRemove !== null}
        title={
          confirmRemove
            ? `${(confirmRemove.status ?? "active") === "active" ? "Disconnect" : "Remove"} ${confirmRemove.display_name || appLabel(confirmRemove.provider)}?`
            : ""
        }
        message={
          confirmRemove && (confirmRemove.status ?? "active") === "pending"
            ? "This connection never finished connecting and isn't used by any step."
            : "Steps using this connection will stop working until you reconnect."
        }
        confirmLabel={confirmRemove && (confirmRemove.status ?? "active") !== "active" ? "Remove" : "Disconnect"}
        destructive
        onConfirm={() => {
          if (confirmRemove) void remove(confirmRemove);
          setConfirmRemove(null);
        }}
        onCancel={() => setConfirmRemove(null)}
      />

      <ConfirmDialog
        open={forceRemove !== null}
        title={
          forceRemove
            ? `Disconnect ${forceRemove.connection.display_name || appLabel(forceRemove.connection.provider)}?`
            : ""
        }
        message={
          forceRemove
            ? `This account is assigned to ${referencesLabel(forceRemove.references)} — those runs will fail on it.`
            : ""
        }
        confirmLabel="Disconnect anyway"
        destructive
        onConfirm={() => {
          if (forceRemove) void remove(forceRemove.connection, true);
          setForceRemove(null);
        }}
        onCancel={() => setForceRemove(null)}
      />
    </div>
  );
}

// "prod (2 workflows), staging" — each referencing environment, with its workflow count when known.
function referencesLabel(references: ConnectionReference[]): string {
  return references
    .map((r) =>
      r.workflows_affected > 0
        ? `${r.environment} (${r.workflows_affected} workflow${r.workflows_affected === 1 ? "" : "s"})`
        : r.environment,
    )
    .join(", ");
}

/** One connected-app chip: Test + remove when active, plus a status word and Reconnect when broken. */
function ConnectionChip({
  connection,
  label,
  account,
  reconnecting,
  testing,
  onTest,
  onReconnect,
  onRemove,
  onRename,
}: {
  connection: Connection;
  label: string;
  /** Which account it answered as, once tested — health alone cannot tell these apart. */
  account?: { name: string | null; id: string | null };
  reconnecting: boolean;
  testing: boolean;
  onTest: () => void;
  onReconnect: () => void;
  onRemove: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const status = (connection.status ?? "active") as "pending" | "active" | "expired" | "failed";
  const meta = status === "active" ? null : STATUS_META[status];
  // The service's stored reason wins; the static hint is the fallback copy.
  const reason = connection.status_reason || meta?.hint;
  const checked = connection.last_checked_at ? ` — checked ${timeAgo(connection.last_checked_at)}` : "";
  const accountName = account ? (account.name ?? account.id) : null;
  const accountTitle = account
    ? ` — authorized against ${account.name ?? "an unnamed account"}${account.id ? ` (${account.id})` : ""}`
    : "";
  return (
    <span
      className="group inline-flex items-center gap-1.5 h-7 pl-2 pr-1.5 rounded-lg"
      style={{
        background: meta ? meta.tint : "var(--orchestr-accent-tint)",
        border: `1px solid ${meta ? meta.color : "var(--orchestr-line)"}`,
      }}
    >
      <span
        aria-hidden
        title={`${reason ?? "Connected and active"}${checked}${accountTitle}`}
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: meta ? meta.color : "var(--orchestr-success)" }}
      />
      <NodeIcon nodeType={`${connection.provider}.connection`} size={14} />
      <span className="text-[11.5px]" style={{ color: "var(--orchestr-ink)" }}>
        {label}
      </span>
      {accountName && (
        <span
          className="text-[10px] max-w-[13ch] truncate"
          style={{ color: "var(--orchestr-ink-subtle)" }}
          title={accountTitle.replace(" — ", "")}
          data-testid={`connection-account-${connection.id}`}
        >
          {accountName}
        </span>
      )}
      {meta && (
        <>
          <span className="text-[10px] font-medium" style={{ color: meta.color }} title={`${reason}${checked}`}>
            {meta.label}
          </span>
          <button
            onClick={onReconnect}
            disabled={reconnecting}
            aria-label={`Reconnect ${label}`}
            className="inline-flex items-center gap-1 text-[10.5px] font-medium bg-transparent border-none cursor-pointer px-1 rounded disabled:cursor-default disabled:opacity-60"
            style={{ color: "var(--orchestr-accent)" }}
          >
            {reconnecting ? <SaratiLoader size={11} /> : <RefreshCw size={11} />}
            Reconnect
          </button>
        </>
      )}
      {renaming ? (
        <input
          autoFocus
          defaultValue={connection.display_name ?? ""}
          aria-label={`Name for ${label}`}
          placeholder="e.g. Work Slack"
          className="text-[10.5px] px-1 py-0.5 rounded outline-none w-[110px]"
          style={{ background: "var(--orchestr-field)", border: "1px solid var(--orchestr-line)", color: "var(--orchestr-ink)" }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onRename((e.target as HTMLInputElement).value).then(() => setRenaming(false));
            if (e.key === "Escape") setRenaming(false);
          }}
          onBlur={(e) => void onRename(e.target.value).then(() => setRenaming(false))}
        />
      ) : (
        <button
          onClick={() => setRenaming(true)}
          aria-label={`Rename ${label}`}
          title="Name this account (e.g. Work Slack vs Personal)"
          className="bg-transparent border-none cursor-pointer p-0.5 rounded opacity-50 hover:opacity-100 transition-opacity"
          style={{ color: "var(--orchestr-ink-muted)" }}
        >
          <Pencil size={11} />
        </button>
      )}
      <button
        onClick={onTest}
        disabled={testing}
        aria-label={`Test ${label}`}
        title={`Check this connection now${checked}`}
        className="inline-flex items-center gap-1 text-[10.5px] font-medium bg-transparent border-none cursor-pointer px-1 rounded opacity-60 hover:opacity-100 transition-opacity disabled:cursor-default disabled:opacity-60"
        style={{ color: "var(--orchestr-ink-muted)" }}
      >
        {testing ? <SaratiLoader size={11} /> : <Activity size={11} />}
        Test
      </button>
      <button
        onClick={onRemove}
        aria-label={`${meta ? "Remove" : "Disconnect"} ${label}`}
        className="bg-transparent border-none cursor-pointer p-0.5 rounded opacity-50 hover:opacity-100 transition-opacity"
        style={{ color: "var(--orchestr-ink-muted)" }}
      >
        <X size={12} />
      </button>
    </span>
  );
}

/** A titled block above a grid — keeps Popular / All apps visually distinct. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-medium mb-2" style={{ color: "var(--orchestr-ink-muted)" }}>
        {label}
      </div>
      {children}
    </div>
  );
}

/** The responsive icon grid shared by every section (Popular, All, results). */
function AppGrid({
  apps,
  connectedCountBySlug,
  onConnected,
}: {
  apps: ManagedApp[];
  connectedCountBySlug: Map<string, number>;
  onConnected: () => void;
}) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}>
      {apps.map((app) => (
        <AppTile
          key={app.slug}
          app={app}
          connectedCount={connectedCountBySlug.get(app.slug) ?? 0}
          onConnected={onConnected}
        />
      ))}
    </div>
  );
}

/** One square icon-forward tile. The whole tile is the connect action. */
function AppTile({
  app,
  connectedCount,
  onConnected,
}: {
  app: ManagedApp;
  connectedCount: number;
  onConnected: () => void;
}) {
  const iconType = `${app.slug}.connection`;
  const icon = useNodeIcons((s) => s.icons[iconType]);
  const [connecting, setConnecting] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const connect = async () => {
    if (connecting) return;
    setConnecting(true);
    const id = await connectAppWithFeedback(app.slug, app.name);
    if (mounted.current) setConnecting(false);
    if (id) onConnected();
  };

  return (
    <button
      type="button"
      data-testid={`managed-app-${app.slug}`}
      onClick={() => void connect()}
      disabled={connecting}
      aria-label={connectedCount > 0 ? `Add another ${app.name} account` : `Connect ${app.name}`}
      className="relative flex flex-col items-center justify-center gap-1.5 h-[76px] rounded-xl cursor-pointer transition-colors duration-150 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--orchestr-ink-subtle)] disabled:cursor-default"
      style={{ background: "transparent", border: "1px solid var(--orchestr-line)" }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--orchestr-line-strong)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--orchestr-line)")}
    >
      {connectedCount > 0 && (
        <span
          aria-hidden
          title="Already connected"
          className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full"
          style={{ background: "var(--orchestr-success)" }}
        />
      )}
      {connecting ? (
        <SaratiLoader size={18} />
      ) : icon ? (
        <NodeIcon nodeType={iconType} size={24} />
      ) : (
        <span
          aria-hidden
          className="w-6 h-6 rounded flex items-center justify-center text-[13px] font-semibold"
          style={{ background: "var(--orchestr-surface-card)", color: "var(--orchestr-ink-muted)" }}
        >
          {app.name.charAt(0).toUpperCase()}
        </span>
      )}
      <span
        className="text-[11px] leading-tight text-center px-1 line-clamp-2"
        style={{ color: "var(--orchestr-ink-muted)" }}
      >
        {app.name}
      </span>
    </button>
  );
}
