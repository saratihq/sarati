"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Layers, Pencil, Plus, Trash2, X } from "lucide-react";
import * as api from "@/api/client";
import type { Connection } from "@/api/client";
import * as envApi from "@/api/environments";
import type { Environment, EnvironmentSlot } from "@/api/environments";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import ConnectAppButton from "@/components/ConnectAppButton";
import { appDisplayName, matchingConnections } from "@/lib/connections";
import { toast } from "@/lib/toast";
import { useNodeIcons } from "@/store/useNodeIcons";
import NodeIcon from "./NodeIcon";
import { SaratiLoader } from "./SaratiLogo";
import { useOrgs, activeOrgOf } from "@/store/useOrgs";
import { isProtectedEnv } from "@/lib/envPresentation";

// The environments surface: one row per environment, one slot per app. Slots are
// references — assigning never moves the connection, and connecting an account never auto-assigns it.

// Same status vocabulary as the pool chips: dot colour plus word, never colour alone.
const SLOT_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: "Pending", color: "var(--orchestr-warning)" },
  expired: { label: "Expired", color: "var(--orchestr-danger)" },
  failed: { label: "Failed", color: "var(--orchestr-danger)" },
};

const cardStyle: React.CSSProperties = {
  background: "var(--orchestr-surface-card)",
  border: "1px solid var(--orchestr-line)",
};

const inputStyle: React.CSSProperties = {
  background: "var(--orchestr-accent-tint)",
  border: "1px solid var(--orchestr-line)",
  color: "var(--orchestr-ink)",
};

interface PendingAssign {
  env: Environment;
  app: string;
  connection: Connection;
  /** The slot's current holder when occupied — replacing it affects env runs. */
  replacing: EnvironmentSlot | null;
  /** Other environments this same account already serves (derived client-side). */
  alsoIn: string[];
}

export default function EnvironmentsSettings() {
  // Members see the curation read-only; the API 403s their writes anyway.
  const canManage = useOrgs((s) => {
    const org = activeOrgOf(s);
    return !org || org.is_personal || org.role === "owner" || org.role === "admin";
  });
  const [environments, setEnvironments] = useState<Environment[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pool, setPool] = useState<Connection[]>([]);
  const [picker, setPicker] = useState<{ envId: string; app: string } | null>(null);
  const [pendingAssign, setPendingAssign] = useState<PendingAssign | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState<{ env: Environment; slot: EnvironmentSlot } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Environment | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([envApi.listEnvironments(), api.listConnections()])
        .then(([{ environments: envs }, { connections }]) => {
          setEnvironments(envs);
          setPool(connections);
          setLoadError(null);
          const apps = new Set(connections.map((c) => c.provider));
          for (const e of envs) for (const s of e.slots) apps.add(s.app);
          useNodeIcons.getState().fetchIcons([...apps].map((a) => `${a}.connection`));
        })
        .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : "Couldn't load environments")),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Pool apps plus apps already assigned somewhere, so an assignment owned by another member renders.
  const slotApps = useMemo(() => {
    const apps = new Set(pool.map((c) => c.provider));
    for (const e of environments ?? []) for (const s of e.slots) apps.add(s.app);
    return [...apps].sort((a, b) => a.localeCompare(b));
  }, [pool, environments]);

  // The API reports also_in_environments only AFTER assignment, so sharing is derived from memory.
  const requestAssign = (env: Environment, app: string, connection: Connection) => {
    setPicker(null);
    const replacing = env.slots.find((s) => s.app === app) ?? null;
    if (replacing?.connection_id === connection.id) {
      toast.info("Already assigned", `${connectionLabel(connection)} is ${env.name}'s ${appDisplayName(app)} account.`);
      return;
    }
    const alsoIn = (environments ?? [])
      .filter((e) => e.id !== env.id && e.slots.some((s) => s.connection_id === connection.id))
      .map((e) => e.name);
    setPendingAssign({ env, app, connection, replacing, alsoIn });
  };

  // A newly connected account lands in the pool; the explicit assign confirm still has to run.
  const assignFreshConnection = async (env: Environment, app: string, connectionId: string) => {
    let fresh: Connection | undefined;
    try {
      const { connections } = await api.listConnections();
      setPool(connections);
      fresh = connections.find((c) => c.id === connectionId);
    } catch {
      /* fall through to the minimal shape — the id is what assignment needs */
    }
    requestAssign(env, app, fresh ?? { id: connectionId, provider: app, display_name: null, auth_type: "managed" });
  };

  const doAssign = async ({ env, app, connection }: PendingAssign) => {
    try {
      await envApi.assignSlot(env.id, app, connection.id);
      toast.success(`Assigned ${connectionLabel(connection)}`, `${env.name} now runs ${appDisplayName(app)} on it.`);
      await load();
    } catch (e) {
      toast.error("Couldn't assign", e instanceof Error ? e.message : undefined);
    }
  };

  const doEmpty = async ({ env, slot }: { env: Environment; slot: EnvironmentSlot }) => {
    try {
      await envApi.emptySlot(env.id, slot.app);
      toast.success(`Emptied ${appDisplayName(slot.app)} in ${env.name}`);
      await load();
    } catch (e) {
      toast.error("Couldn't empty the slot", e instanceof Error ? e.message : undefined);
    }
  };

  const doDelete = async (env: Environment) => {
    try {
      const { removed_pointers, unbound_triggers } = await envApi.deleteEnvironment(env.id);
      toast.success(`Deleted ${env.name}`, `Removed ${removed_pointers} pointers, unbound ${unbound_triggers} triggers.`);
      await load();
    } catch (e) {
      toast.error(`Couldn't delete ${env.name}`, e instanceof Error ? e.message : undefined);
    }
  };

  const create = async (name: string) => {
    try {
      await envApi.createEnvironment(name);
      toast.success(`Created ${name}`);
      await load();
    } catch (e) {
      toast.error("Couldn't create the environment", e instanceof Error ? e.message : undefined);
    }
  };

  const rename = async (env: Environment, name: string) => {
    try {
      await envApi.renameEnvironment(env.id, name);
      setEnvironments((prev) => (prev ?? []).map((e) => (e.id === env.id ? { ...e, name } : e)));
      toast.success(`Renamed to "${name}"`);
    } catch (e) {
      toast.error("Couldn't rename the environment", e instanceof Error ? e.message : undefined);
    }
  };

  return (
    <section className="mb-10" data-testid="environments-section">
      <h2 className="text-xs text-[var(--orchestr-ink-muted)] font-semibold uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
        <Layers size={13} /> Environments
      </h2>
      <p className="text-[11px] m-0 mb-4" style={{ color: "var(--orchestr-ink-subtle)" }}>
        One account per app per environment — runs promoted to an environment use its accounts. Everything else
        runs on Default, your own connections. Assigning references an account; it never leaves Default.
      </p>

      {environments === null && !loadError ? (
        <div className="flex items-center justify-center py-8">
          <SaratiLoader size={28} />
        </div>
      ) : loadError ? (
        <div
          className="flex items-center justify-between gap-3 py-2 px-3 rounded-lg"
          style={{ background: "var(--orchestr-danger-tint)" }}
        >
          <span className="text-xs" style={{ color: "var(--orchestr-danger)" }}>
            {loadError}
          </span>
          <button
            onClick={() => void load()}
            className="text-xs bg-transparent border-none cursor-pointer underline"
            style={{ color: "var(--orchestr-ink)" }}
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {(environments ?? []).map((env) => (
            <EnvironmentRow
              key={env.id}
              env={env}
              canManage={canManage}
              slotApps={slotApps}
              pool={pool}
              picker={picker?.envId === env.id ? picker.app : null}
              onOpenPicker={(app) =>
                setPicker(picker?.envId === env.id && picker.app === app ? null : { envId: env.id, app })
              }
              onClosePicker={() => setPicker(null)}
              onPick={(app, connection) => requestAssign(env, app, connection)}
              onConnectedNew={(app, connectionId) => void assignFreshConnection(env, app, connectionId)}
              onEmpty={(slot) => setConfirmEmpty({ env, slot })}
              onRename={(name) => void rename(env, name)}
              onDelete={() => setConfirmDelete(env)}
            />
          ))}

          {canManage && <NewEnvironment
            open={creating}
            onOpen={() => setCreating(true)}
            onCancel={() => setCreating(false)}
            onCreate={(name) => {
              setCreating(false);
              void create(name);
            }}
          />}
        </div>
      )}

      {/* Assign: carries the occupied-slot replacement and shared-account warnings. */}
      <ConfirmDialog
        open={pendingAssign !== null}
        title={pendingAssign ? `Assign to ${pendingAssign.env.name}?` : ""}
        message={pendingAssign ? assignMessage(pendingAssign) : ""}
        consequence={
          pendingAssign?.replacing
            ? `Replacing ${pendingAssign.replacing.account_label} — ${pendingAssign.env.name} runs will be affected.`
            : undefined
        }
        confirmLabel="Assign"
        destructive={Boolean(pendingAssign?.replacing)}
        onConfirm={() => {
          if (pendingAssign) void doAssign(pendingAssign);
          setPendingAssign(null);
        }}
        onCancel={() => setPendingAssign(null)}
      />

      <ConfirmDialog
        open={confirmEmpty !== null}
        title={confirmEmpty ? `Empty the ${appDisplayName(confirmEmpty.slot.app)} slot?` : ""}
        message={
          confirmEmpty
            ? `${confirmEmpty.env.name} runs will fail on ${appDisplayName(confirmEmpty.slot.app)} until ` +
              `reassigned. The account itself stays in Default.`
            : ""
        }
        confirmLabel="Empty slot"
        destructive
        onConfirm={() => {
          if (confirmEmpty) void doEmpty(confirmEmpty);
          setConfirmEmpty(null);
        }}
        onCancel={() => setConfirmEmpty(null)}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title={confirmDelete ? `Delete ${confirmDelete.name}?` : ""}
        message={
          confirmDelete
            ? `Deleting ${confirmDelete.name} removes ${confirmDelete.pointer_count} deployment ` +
              `pointer${confirmDelete.pointer_count === 1 ? "" : "s"} and unbinds ${confirmDelete.trigger_count} ` +
              `trigger${confirmDelete.trigger_count === 1 ? "" : "s"}. Runs scoped to it will stop.`
            : ""
        }
        confirmLabel="Delete environment"
        destructive
        onConfirm={() => {
          if (confirmDelete) void doDelete(confirmDelete);
          setConfirmDelete(null);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </section>
  );
}

function assignMessage({ app, connection, alsoIn }: PendingAssign): string {
  const parts = [`${connectionLabel(connection)} will handle ${appDisplayName(app)}.`];
  if (alsoIn.length > 0) {
    const list = alsoIn.join(", ");
    parts.push(`This account is also ${list}'s — ${list} tests/runs share its data. Assign anyway?`);
  }
  return parts.join(" ");
}

function connectionLabel(c: Connection): string {
  return c.display_name || appDisplayName(c.provider);
}

// One environment row: name, counts, delete (never prod), and the per-app slot list.
function EnvironmentRow({
  env,
  canManage,
  slotApps,
  pool,
  picker,
  onOpenPicker,
  onClosePicker,
  onPick,
  onConnectedNew,
  onEmpty,
  onRename,
  onDelete,
}: {
  env: Environment;
  /** Owner/admin (or personal workspace). Members get the read-only view. */
  canManage: boolean;
  slotApps: string[];
  pool: Connection[];
  /** The app whose assign picker is open in THIS row, if any. */
  picker: string | null;
  onOpenPicker: (app: string) => void;
  onClosePicker: () => void;
  onPick: (app: string, connection: Connection) => void;
  onConnectedNew: (app: string, connectionId: string) => void;
  onEmpty: (slot: EnvironmentSlot) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const locked = isProtectedEnv(env);
  // Only assigned slots render; new ones enter through "+ Assign an app".
  const visibleApps = slotApps.filter((app) => env.slots.some((s) => s.app === app) || picker === app);
  const unassignedApps = slotApps.filter((app) => !env.slots.some((s) => s.app === app));
  const [chooserOpen, setChooserOpen] = useState(false);
  const [chooserQuery, setChooserQuery] = useState("");
  return (
    <div className="rounded-xl p-4" style={cardStyle} data-testid={`env-row-${env.name}`}>
      <div className="flex items-center gap-2 mb-2.5">
        <EnvName name={env.name} canRename={!locked && canManage} onRename={onRename} />
        <span className="text-[11px] shrink-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
          {countsLabel(env)}
        </span>
        {!locked && canManage && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            aria-label={`Delete ${env.name}`}
            onClick={onDelete}
          >
            <Trash2 size={12} />
          </Button>
        )}
      </div>

      {visibleApps.length === 0 && (
        <p className="text-[11px] m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
          {!canManage
            ? "No accounts assigned yet — a workspace owner curates this environment."
            : slotApps.length === 0
              ? "Nothing to assign yet — connect an app under Default first."
              : "No accounts assigned yet."}
        </p>
      )}
      {visibleApps.length > 0 && (
        <div className="space-y-1.5">
          {visibleApps.map((app) => {
            const slot = env.slots.find((s) => s.app === app) ?? null;
            return (
              <div key={app}>
                <SlotRow
                  env={env}
                  app={app}
                  slot={slot}
                  readOnly={!canManage}
                  pickerOpen={picker === app}
                  onOpenPicker={() => onOpenPicker(app)}
                  onEmpty={() => slot && onEmpty(slot)}
                />
                {canManage && picker === app && (
                  <AssignPicker
                    env={env}
                    app={app}
                    pool={pool}
                    onPick={(c) => onPick(app, c)}
                    onConnectedNew={(id) => onConnectedNew(app, id)}
                    onClose={onClosePicker}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      {canManage && unassignedApps.length > 0 && (
        <div className="mt-2">
          {!chooserOpen ? (
            <Button variant="ghost" size="xs" onClick={() => setChooserOpen(true)}>
              <Plus size={12} /> Assign an app
            </Button>
          ) : (
            <div
              role="group"
              aria-label={`Pick an app to assign in ${env.name}`}
              className="rounded-lg p-2"
              style={{ background: "var(--orchestr-surface)", border: "1px solid var(--orchestr-line)" }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setChooserOpen(false);
                  setChooserQuery("");
                }
              }}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <input
                  autoFocus
                  value={chooserQuery}
                  onChange={(e) => setChooserQuery(e.target.value)}
                  placeholder="Search apps…"
                  aria-label="Search apps to assign"
                  className="flex-1 min-w-0 h-7 px-2 rounded text-[12px] outline-none"
                  style={{
                    background: "var(--orchestr-field)",
                    border: "1px solid var(--orchestr-line)",
                    color: "var(--orchestr-ink)",
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    setChooserOpen(false);
                    setChooserQuery("");
                  }}
                  aria-label="Close app picker"
                  className="bg-transparent border-none cursor-pointer p-0"
                  style={{ color: "var(--orchestr-ink-subtle)" }}
                >
                  <X size={13} />
                </button>
              </div>
              <div className="max-h-44 overflow-y-auto space-y-0.5">
                {unassignedApps
                  .filter((app) => appDisplayName(app).toLowerCase().includes(chooserQuery.toLowerCase()))
                  .map((app) => (
                    <button
                      key={app}
                      type="button"
                      onClick={() => {
                        setChooserOpen(false);
                        setChooserQuery("");
                        onOpenPicker(app);
                      }}
                      className="w-full flex items-center gap-2 text-left text-[12px] py-1.5 px-2 rounded cursor-pointer border-none bg-transparent hover:bg-[var(--orchestr-accent-tint)]"
                      style={{ color: "var(--orchestr-ink)" }}
                    >
                      <NodeIcon nodeType={`${app}.connection`} size={13} />
                      {appDisplayName(app)}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function countsLabel(env: Environment): string {
  if (env.pointer_count === 0 && env.trigger_count === 0) return "not in use yet";
  const parts: string[] = [];
  if (env.pointer_count > 0) parts.push(`${env.pointer_count} deployment${env.pointer_count === 1 ? "" : "s"}`);
  if (env.trigger_count > 0) parts.push(`${env.trigger_count} trigger${env.trigger_count === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// Inline env rename; the host owns the PATCH and state sync. Prod never renders a pencil.
function EnvName({
  name,
  canRename,
  onRename,
}: {
  name: string;
  canRename: boolean;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  // Render-time derived reset: an externally changed name replaces the local copy unless mid-edit.
  const [lastName, setLastName] = useState(name);
  if (name !== lastName) {
    setLastName(name);
    if (!editing) setValue(name);
  }

  const commit = () => {
    const next = value.trim();
    setEditing(false);
    if (!next || next === name) {
      setValue(name);
      return;
    }
    onRename(next);
  };

  if (editing) {
    return (
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setValue(name);
            setEditing(false);
          }
        }}
        autoFocus
        aria-label="Environment name"
        className="bg-transparent border-none outline-none min-w-0 w-[160px] text-[13px] font-semibold"
        style={{ color: "var(--orchestr-ink)", borderBottom: "1px solid var(--orchestr-line-strong)" }}
      />
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span className="text-[13px] font-semibold truncate" style={{ color: "var(--orchestr-ink)" }}>
        {value}
      </span>
      {canRename && (
        <button
          type="button"
          aria-label={`Rename ${name}`}
          onClick={() => setEditing(true)}
          className="shrink-0 bg-transparent border-none p-0.5 cursor-pointer inline-flex"
          style={{ color: "var(--orchestr-ink-subtle)" }}
        >
          <Pencil size={11} />
        </button>
      )}
    </span>
  );
}

// One slot: the assigned account with Replace/Empty, or an empty slot with Assign.
function SlotRow({
  env,
  app,
  slot,
  readOnly,
  pickerOpen,
  onOpenPicker,
  onEmpty,
}: {
  env: Environment;
  app: string;
  slot: EnvironmentSlot | null;
  /** Member view: the assignment is information, not a control. */
  readOnly: boolean;
  pickerOpen: boolean;
  onOpenPicker: () => void;
  onEmpty: () => void;
}) {
  const appName = appDisplayName(app);
  const status = slot ? (SLOT_STATUS[slot.status] ?? null) : null;
  return (
    <div
      className="flex items-center gap-2 rounded-lg py-1.5 px-2"
      style={{ background: "var(--orchestr-accent-tint)" }}
      data-testid={`slot-${env.name}-${app}`}
    >
      <NodeIcon nodeType={`${app}.connection`} size={14} />
      <span className="text-[12px] font-medium shrink-0" style={{ color: "var(--orchestr-ink)" }}>
        {appName}
      </span>
      {slot ? (
        <>
          <span
            aria-hidden
            title={status ? status.label : "Connected and active"}
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: status ? status.color : "var(--orchestr-success)" }}
          />
          <span className="text-[11px] truncate" style={{ color: "var(--orchestr-ink-muted)" }}>
            {slot.account_label}
            {slot.owner_label ? (
              <span style={{ color: "var(--orchestr-ink-subtle)" }}> · {slot.owner_label}</span>
            ) : null}
          </span>
          {status && (
            <span className="text-[10px] font-medium shrink-0" style={{ color: status.color }}>
              {status.label}
            </span>
          )}
          {!readOnly && (
          <span className="ml-auto inline-flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={onOpenPicker}
              aria-label={`Replace ${appName} in ${env.name}`}
              aria-expanded={pickerOpen}
              className="text-[10.5px] font-medium bg-transparent border-none cursor-pointer px-1 rounded opacity-60 hover:opacity-100 transition-opacity"
              style={{ color: "var(--orchestr-ink-muted)" }}
            >
              Replace
            </button>
            <button
              type="button"
              onClick={onEmpty}
              aria-label={`Empty ${appName} in ${env.name}`}
              className="bg-transparent border-none cursor-pointer p-0.5 rounded opacity-50 hover:opacity-100 transition-opacity"
              style={{ color: "var(--orchestr-ink-muted)" }}
            >
              <X size={12} />
            </button>
          </span>
          )}
        </>
      ) : (
        <>
          <span className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
            no account assigned
          </span>
          {!readOnly && (
            <Button
              variant="ghost"
              size="xs"
              className="ml-auto"
              aria-label={`Assign ${appName} in ${env.name}`}
              aria-expanded={pickerOpen}
              onClick={onOpenPicker}
            >
              Assign
            </Button>
          )}
        </>
      )}
    </div>
  );
}

// The assign picker for one (env, app) slot: pool accounts for that app, plus a Connect-new path.
function AssignPicker({
  env,
  app,
  pool,
  onPick,
  onConnectedNew,
  onClose,
}: {
  env: Environment;
  app: string;
  pool: Connection[];
  onPick: (connection: Connection) => void;
  onConnectedNew: (connectionId: string) => void;
  onClose: () => void;
}) {
  const appName = appDisplayName(app);
  const options = matchingConnections(pool, app);
  return (
    <div
      role="group"
      aria-label={`Assign ${appName} in ${env.name}`}
      className="mt-1 mb-1.5 rounded-lg p-2"
      style={{ background: "var(--orchestr-surface)", border: "1px solid var(--orchestr-line)" }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5 px-1">
        <span className="text-[11px] font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
          Pick a {appName} account from Default
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close account picker"
          className="bg-transparent border-none cursor-pointer p-0"
          style={{ color: "var(--orchestr-ink-subtle)" }}
        >
          <X size={13} />
        </button>
      </div>
      {options.length === 0 ? (
        <p className="text-[11px] m-0 px-1 pb-1.5" style={{ color: "var(--orchestr-ink-subtle)" }}>
          No {appName} accounts in Default yet.
        </p>
      ) : (
        <div className="space-y-0.5 mb-1.5">
          {options.map((c) => {
            const status = SLOT_STATUS[c.status ?? "active"] ?? null;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onPick(c)}
                className="w-full flex items-center gap-2 text-left text-[12px] py-1.5 px-2 rounded cursor-pointer border-none bg-transparent hover:bg-[var(--orchestr-accent-tint)]"
                style={{ color: "var(--orchestr-ink)" }}
              >
                <span
                  aria-hidden
                  title={status ? status.label : "Connected and active"}
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: status ? status.color : "var(--orchestr-success)" }}
                />
                <span className="truncate">{connectionLabel(c)}</span>
                {status && (
                  <span className="text-[10px] font-medium shrink-0" style={{ color: status.color }}>
                    {status.label}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <ConnectAppButton variant="ghost" size="xs" app={app} appName={appName} onConnected={onConnectedNew}>
        <Plus size={12} /> Connect a new {appName} account
      </ConnectAppButton>
    </div>
  );
}

// "New environment": a button that becomes an inline name input (Enter creates, Escape cancels).
function NewEnvironment({
  open,
  onOpen,
  onCancel,
  onCreate,
}: {
  open: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={onOpen} data-testid="env-new">
        <Plus size={12} /> New environment
      </Button>
    );
  }
  const commit = () => {
    const next = name.trim();
    if (!next) {
      onCancel();
      return;
    }
    setName("");
    onCreate(next);
  };
  return (
    <div className="rounded-xl p-3 flex items-center gap-2" style={cardStyle}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setName("");
            onCancel();
          }
        }}
        autoFocus
        placeholder="Environment name — e.g. qa"
        aria-label="New environment name"
        className="flex-1 py-1.5 px-2 rounded-lg text-[12px] outline-none"
        style={inputStyle}
      />
      <Button variant="secondary" size="sm" onClick={commit} disabled={!name.trim()}>
        Create
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Cancel new environment"
        onClick={() => {
          setName("");
          onCancel();
        }}
      >
        <X size={13} />
      </Button>
    </div>
  );
}
