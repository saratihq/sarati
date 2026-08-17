"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import * as api from "@/api/client";
import type { PlatformKeyName, PlatformKeysResponse } from "@/api/client";
import { useOrgs, activeOrgOf } from "@/store/useOrgs";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { InlineError } from "@/components/ui/inline-error";
import { formatDate } from "@/lib/format";
import { toast } from "@/lib/toast";
import { refreshComposerAvailability } from "@/lib/useComposerAvailable";

/** What removing each key costs, named plainly so the confirm is a decision and not a shrug. */
function removalMessage(name: PlatformKeyName | undefined, who: string): string {
  if (name === "anthropic_api_key") return `The AI composer turns off for ${who} until a key is added again.`;
  if (name === "composio_webhook_secret") {
    return `Inbound app triggers stop firing for ${who} — deliveries are rejected until a secret is added again.`;
  }
  return `Managed connections turn off for ${who} until a key is added again. Existing connected accounts are kept.`;
}

interface KeyCopy {
  name: PlatformKeyName;
  label: string;
  unlocks: string;
  where: string;
  href: string;
  placeholder: string;
}

/** Exactly these three. A fourth field here is how this becomes a secrets manager, not a settings page. */
const KEYS: KeyCopy[] = [
  {
    name: "composio_api_key",
    label: "Composio API key",
    unlocks: "Turns on managed connections — connect Gmail, Slack and hundreds of other apps without registering your own OAuth app.",
    where: "Get one from the Composio dashboard",
    href: "https://app.composio.dev/developers",
    placeholder: "ak_…",
  },
  {
    name: "composio_webhook_secret",
    label: "Composio webhook secret",
    unlocks:
      "Verifies inbound app triggers — without it, deliveries from Composio are rejected rather than run.",
    where: "Composio dashboard → Settings → Webhooks",
    href: "https://app.composio.dev/developers",
    placeholder: "whsec_…",
  },
  {
    name: "anthropic_api_key",
    label: "Anthropic API key",
    unlocks: "Turns on the AI composer — describe a workflow in words and it builds one on the canvas.",
    where: "Get one from the Anthropic Console",
    href: "https://console.anthropic.com/settings/keys",
    placeholder: "sk-ant-…",
  },
];

/**
 * The two optional platform credentials for the caller's ACTIVE context — a real organization's
 * keys when working in one, their own otherwise. Write-only: the server reports whether a key is
 * stored, never what it is, so there is nothing to reveal.
 */
export default function PlatformKeysSettings() {
  const activeOrg = useOrgs(activeOrgOf);
  const [state, setState] = useState<PlatformKeysResponse | null>(null); // null = loading
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlatformKeyName | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<KeyCopy | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.listPlatformKeys());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the platform keys");
    }
  }, []);

  useEffect(() => {
    // Mount data-fetch: load() setStates only after its await, so it is a real effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const save = async (key: KeyCopy) => {
    const value = draft.trim();
    if (!value || saving) return;
    setSaving(true);
    try {
      await api.setPlatformKey(key.name, value);
      setDraft("");
      setEditing(null);
      await load();
      // The composer's availability was probed once per page load; it just changed.
      refreshComposerAvailability();
      toast.success(`${key.label} saved — it takes effect immediately.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not save the ${key.label}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (key: KeyCopy) => {
    setConfirmRemove(null);
    try {
      await api.clearPlatformKey(key.name);
      await load();
      refreshComposerAvailability();
      toast.success(`${key.label} removed.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not remove the ${key.label}`);
    }
  };

  // Only a probe still in flight is nothing to show — everyone can set their OWN keys, so the
  // section is never hidden; an org member sees the org's keys read-only instead.
  if (error === null && state === null) return null;

  const inOrg = state?.scope === "org";
  const canManage = state?.can_manage ?? false;
  const orgName = activeOrg?.name ?? "this organization";

  return (
    <section className="mt-10">
      <h2 className="text-xs text-[var(--orchestr-ink-muted)] font-semibold uppercase tracking-wider mb-4">
        Platform keys
      </h2>
      <div
        className="rounded-lg p-5"
        style={{ background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-line)" }}
      >
        <p className="text-xs leading-relaxed mb-4" style={{ color: "var(--orchestr-ink-muted)" }}>
          {inOrg
            ? `Optional keys for ${orgName} — everyone in it uses these. Everything else works without them, and a key added here takes effect straight away, nothing to restart.`
            : "Optional keys of your own, used whenever you work outside an organization. Everything else works without them, and a key you add here takes effect straight away — nothing to restart."}
        </p>

        {inOrg && !canManage && (
          <p
            className="text-xs leading-relaxed rounded-lg px-3 py-2 mb-4"
            style={{ background: "var(--orchestr-info-tint)", color: "var(--orchestr-ink)" }}
          >
            {`Only an owner or admin of ${orgName} can change these.`} Switch to your personal
            workspace to set keys of your own.
          </p>
        )}

        {error !== null && <InlineError message={error} onRetry={() => void load()} />}

        {state !== null && (
          <>
            <div className="flex flex-col gap-4">
              {KEYS.map((key) => {
                const row = state.keys[key.name];
                const open = editing === key.name;
                return (
                  <div
                    key={key.name}
                    className="rounded-lg p-4"
                    style={{ background: "var(--orchestr-surface)", border: "1px solid var(--orchestr-line)" }}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm font-medium m-0" style={{ color: "var(--orchestr-ink)" }}>
                          {key.label}
                        </p>
                        <p
                          className="text-xs mt-1 mb-0 leading-relaxed"
                          style={{ color: "var(--orchestr-ink-muted)" }}
                        >
                          {key.unlocks}
                        </p>
                      </div>
                      <span
                        className="text-[11px] font-semibold shrink-0 inline-flex items-center gap-1"
                        style={{
                          color: row.present ? "var(--orchestr-success)" : "var(--orchestr-ink-subtle)",
                        }}
                      >
                        {row.present && <Check size={12} />}
                        {row.present ? "Set" : "Not set"}
                      </span>
                    </div>

                    {row.present && row.updated_at && (
                      <p className="text-[11px] mt-2 mb-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
                        {`Updated ${formatDate(row.updated_at)}`}
                      </p>
                    )}

                    {open ? (
                      <form
                        className="mt-3 flex flex-col gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void save(key);
                        }}
                      >
                        <input
                          type="password"
                          value={draft}
                          autoFocus
                          onChange={(e) => setDraft(e.target.value)}
                          placeholder={key.placeholder}
                          maxLength={4096}
                          aria-label={key.label}
                          autoComplete="off"
                          className="w-full text-xs rounded px-2.5 py-1.5 outline-none font-mono"
                          style={{
                            background: "var(--orchestr-surface-card)",
                            color: "var(--orchestr-ink)",
                            border: "1px solid var(--orchestr-line)",
                          }}
                        />
                        <div className="flex items-center gap-2">
                          <Button type="submit" size="sm" disabled={!draft.trim() || saving}>
                            {saving ? "Saving…" : "Save"}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setEditing(null);
                              setDraft("");
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </form>
                    ) : (
                      canManage && (
                        <div className="mt-3 flex items-center gap-2">
                          <Button
                            variant={row.present ? "secondary" : "default"}
                            size="sm"
                            onClick={() => {
                              setEditing(key.name);
                              setDraft("");
                            }}
                          >
                            {row.present ? "Replace" : "Add key"}
                          </Button>
                          {row.present && (
                            <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(key)}>
                              Remove
                            </Button>
                          )}
                        </div>
                      )
                    )}

                    <a
                      href={key.href}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-[11px] mt-3 no-underline hover:underline"
                      style={{ color: "var(--orchestr-ink-muted)" }}
                    >
                      {key.where}
                      <ExternalLink size={11} />
                    </a>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove !== null}
        title={`Remove the ${confirmRemove?.label ?? "key"}?`}
        message={removalMessage(confirmRemove?.name, inOrg ? orgName : "you")}
        confirmLabel="Remove"
        destructive
        onConfirm={() => confirmRemove && void remove(confirmRemove)}
        onCancel={() => setConfirmRemove(null)}
      />
    </section>
  );
}
