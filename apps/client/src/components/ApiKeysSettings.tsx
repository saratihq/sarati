"use client";

import { useCallback, useEffect, useState } from "react";
import { Key, Copy, Check, Plus } from "lucide-react";
import * as api from "@/api/client";
import type { ApiKeySummary, IssuedApiKey } from "@/api/client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { InlineError } from "@/components/ui/inline-error";
import { formatDate } from "@/lib/format";
import { toast } from "@/lib/toast";
import { SaratiLoader } from "./SaratiLogo";

/** Plain-language wording for the scopes the server grants; an unlabelled one shows its raw name. */
const SCOPE_LABELS: Record<string, string> = {
  "workflow:read": "Read workflows",
  "workflow:write": "Create and edit workflows",
  "workflow:deploy": "Publish, promote and merge",
  "run:dry": "Preview runs — changes nothing outside",
  "run:execute": "Run for real",
  "workflow:invoke": "Call published workflows",
  "connection:read": "See connected accounts",
  "connection:write": "Manage connected accounts",
  "org:manage": "Manage the organization",
};

const scopeLabel = (scope: string) => SCOPE_LABELS[scope] ?? scope;

/** Personal `ork_` API keys — create (shown once) / list / revoke. Server: /api/api-keys. */
export default function ApiKeysSettings() {
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null); // null = loading
  const [grantable, setGrantable] = useState<string[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null); // the plaintext key, shown once
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<ApiKeySummary | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.listApiKeys();
      setKeys(res.api_keys.filter((k) => !k.revoked_at)); // active only
      setGrantable(res.grantable_scopes);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load API keys");
    }
  }, []);

  useEffect(() => {
    // Mount data-fetch: load() setStates only after its await, so it is a real effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || scopes.length === 0 || creating) return;
    setCreating(true);
    try {
      const key = await api.createApiKey(trimmed, scopes);
      setIssued(key);
      setName("");
      setScopes([]);
      setCopied(false);
      await load();
    } catch (e) {
      toast.error("Couldn't create key", e instanceof Error ? e.message : undefined);
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (k: ApiKeySummary) => {
    try {
      await api.revokeApiKey(k.id);
      toast.success(`Revoked "${k.name}"`);
      await load();
    } catch (e) {
      toast.error("Couldn't revoke key", e instanceof Error ? e.message : undefined);
    }
  };

  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed — select the key and copy it manually");
    }
  };

  return (
    <section className="mt-10">
      <h2 className="text-xs text-[var(--orchestr-ink-muted)] font-semibold uppercase tracking-wider mb-4">API keys</h2>
      <div
        className="rounded-lg p-5"
        style={{ background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-line)" }}
      >
        <p className="text-xs leading-relaxed mb-4" style={{ color: "var(--orchestr-ink-muted)" }}>
          Personal keys for calling the Sarati API from CI or scripts — send as a{" "}
          <code className="text-[11px]">Bearer</code> token. A key is shown once at creation; store it somewhere safe.
        </p>

        {/* Just-issued key — shown ONCE */}
        {issued && (
          <div
            className="rounded-lg p-3 mb-4"
            style={{ background: "var(--orchestr-surface-raised)", border: "1px solid var(--orchestr-success)" }}
          >
            <p className="text-[11px] font-medium mb-2" style={{ color: "var(--orchestr-success)" }}>
              Copy your new key now — you won&apos;t be able to see it again.
            </p>
            <div className="flex items-center gap-2">
              <code
                className="flex-1 text-[11px] font-mono break-all rounded px-2 py-1.5"
                style={{
                  background: "var(--orchestr-surface)",
                  color: "var(--orchestr-ink)",
                  border: "1px solid var(--orchestr-line)",
                }}
              >
                {issued.key}
              </code>
              <Button variant="secondary" size="sm" onClick={copy}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <button
              onClick={() => setIssued(null)}
              className="text-[11px] mt-2 bg-transparent border-none cursor-pointer"
              style={{ color: "var(--orchestr-ink-subtle)" }}
            >
              Done
            </button>
          </div>
        )}

        {/* Create */}
        <div className="mb-4">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Key name (e.g. CI deploy)"
            maxLength={100}
            aria-label="Key name"
            className="w-full text-xs rounded px-2.5 py-1.5 outline-none"
            style={{
              background: "var(--orchestr-surface)",
              color: "var(--orchestr-ink)",
              border: "1px solid var(--orchestr-line)",
            }}
          />

          <fieldset className="border-none p-0 m-0 mt-3">
            <legend className="text-[11px] mb-1.5 p-0" style={{ color: "var(--orchestr-ink-muted)" }}>
              What may this key do? A key can only ever do what you pick here.
            </legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
              {grantable.map((scope) => (
                <label
                  key={scope}
                  className="flex items-center gap-2 text-[11px] cursor-pointer py-0.5"
                  style={{ color: "var(--orchestr-ink)" }}
                >
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(e) =>
                      setScopes((prev) => (e.target.checked ? [...prev, scope] : prev.filter((s) => s !== scope)))
                    }
                    className="shrink-0 cursor-pointer"
                  />
                  <span>{scopeLabel(scope)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex items-center gap-3 mt-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void create()}
              disabled={creating || !name.trim() || scopes.length === 0}
            >
              <Plus size={13} />
              {creating ? "Creating…" : "Create key"}
            </Button>
            {(!name.trim() || scopes.length === 0) && (
              <span className="text-[11px]" style={{ color: "var(--orchestr-ink-subtle)" }}>
                {!name.trim() ? "Name the key" : "Pick at least one thing it may do"}
              </span>
            )}
          </div>
        </div>

        {/* List (active keys only) */}
        {error ? (
          <InlineError message={error} onRetry={() => void load()} />
        ) : keys === null ? (
          <div className="flex items-center justify-center py-4">
            <SaratiLoader size={28} />
          </div>
        ) : keys.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--orchestr-ink-subtle)" }}>
            No API keys yet.
          </p>
        ) : (
          <div className="space-y-2">
            {keys.map((k) => (
              <div
                key={k.id}
                className="flex items-center gap-3 py-2 px-3 rounded"
                style={{ background: "var(--orchestr-surface)", border: "1px solid var(--orchestr-line)" }}
              >
                <Key size={14} style={{ color: "var(--orchestr-ink-subtle)" }} className="shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate m-0" style={{ color: "var(--orchestr-ink)" }}>
                    {k.name}
                  </p>
                  <p className="text-[11px] mt-0.5 m-0 font-mono" style={{ color: "var(--orchestr-ink-subtle)" }}>
                    {k.prefix}… · created {formatDate(k.created_at)} ·{" "}
                    {k.last_used_at ? `last used ${formatDate(k.last_used_at)}` : "never used"}
                  </p>
                  {k.scopes === null ? (
                    <p className="text-[11px] mt-0.5 m-0" style={{ color: "var(--orchestr-warning)" }}>
                      Full access — issued before keys carried scopes. Replace it with a scoped key.
                    </p>
                  ) : (
                    <p className="text-[11px] mt-0.5 m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
                      {k.scopes.map(scopeLabel).join(" · ")}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => setConfirmRevoke(k)}
                  className="text-[11px] font-medium bg-transparent border-none cursor-pointer shrink-0"
                  style={{ color: "var(--orchestr-danger)" }}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmRevoke !== null}
        title="Revoke API key?"
        message={`"${confirmRevoke?.name ?? ""}" will stop working immediately — any CI or scripts using it will start failing.`}
        confirmLabel="Revoke"
        destructive
        onConfirm={() => {
          if (confirmRevoke) void revoke(confirmRevoke);
          setConfirmRevoke(null);
        }}
        onCancel={() => setConfirmRevoke(null)}
      />
    </section>
  );
}
