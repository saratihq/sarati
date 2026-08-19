"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Check, ChevronLeft, Copy, Search } from "lucide-react";
import * as api from "@/api/client";
import type { ByoOAuthClient } from "@/api/client";
import {
  connectByoOAuth,
  shapeDirectCredential,
  type ByoApp,
} from "@/lib/byoConnect";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import NodeIcon from "./NodeIcon";

/** Bring-your-own-credentials connect surface: app picker, then a form off its `authScheme`. */
export default function ByoConnectForm({
  apps,
  envProviders,
  onConnected,
  onBack,
}: {
  /** BYO-able apps (SDK apps whose scheme isn't `none`). */
  apps: ByoApp[];
  /** App slugs that also have an env-configured OAuth app (offer our one-click). */
  envProviders: Set<string>;
  /** New connection stored — refresh the list. */
  onConnected: () => void;
  /** Optional "back to the managed grid" affordance (cloud only). */
  onBack?: () => void;
}) {
  const [chosen, setChosen] = useState<ByoApp | null>(null);

  if (!chosen) {
    return <AppPicker apps={apps} onPick={setChosen} onBack={onBack} />;
  }
  return (
    <AppCredentialForm
      app={chosen}
      hasEnvProvider={envProviders.has(chosen.slug)}
      onBack={() => setChosen(null)}
      onConnected={onConnected}
    />
  );
}

/** Searchable list of BYO-able apps. */
function AppPicker({
  apps,
  onPick,
  onBack,
}: {
  apps: ByoApp[];
  onPick: (a: ByoApp) => void;
  onBack?: () => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const results = useMemo(
    () =>
      needle
        ? apps.filter(
            (a) =>
              a.slug.includes(needle) || a.name.toLowerCase().includes(needle),
          )
        : apps,
    [apps, needle],
  );

  return (
    <div className="flex flex-col gap-3">
      {onBack && (
        <button
          onClick={onBack}
          className="self-start inline-flex items-center gap-1 text-[12px] bg-transparent border-none cursor-pointer px-0"
          style={{ color: "var(--orchestr-ink-muted)" }}
        >
          <ChevronLeft size={13} /> Back to one-click connect
        </button>
      )}
      <div
        className="flex items-center gap-2 h-9 px-3 rounded-lg"
        style={{
          background: "var(--orchestr-field)",
          border: "1px solid var(--orchestr-line)",
        }}
      >
        <Search size={13} style={{ color: "var(--orchestr-ink-subtle)" }} />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search apps to connect with your own credentials…"
          aria-label="Search BYO apps"
          className="flex-1 bg-transparent border-none outline-none text-[12px]"
          style={{ color: "var(--orchestr-ink)" }}
        />
      </div>
      {apps.length === 0 ? (
        <p
          className="text-xs py-4 text-center"
          style={{ color: "var(--orchestr-ink-subtle)" }}
        >
          No apps expose a bring-your-own credential form yet.
        </p>
      ) : results.length === 0 ? (
        <p
          className="text-xs py-4 text-center"
          style={{ color: "var(--orchestr-ink-subtle)" }}
        >
          No apps match “{q.trim()}”.
        </p>
      ) : (
        <div
          className="grid gap-2"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
          }}
        >
          {results.map((app) => (
            <button
              key={app.slug}
              type="button"
              data-testid={`byo-app-${app.slug}`}
              onClick={() => onPick(app)}
              className="relative flex flex-col items-center justify-center gap-1.5 h-[76px] rounded-xl cursor-pointer transition-colors duration-150 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--orchestr-ink-subtle)]"
              style={{
                background: "transparent",
                border: "1px solid var(--orchestr-line)",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.borderColor =
                  "var(--orchestr-line-strong)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.borderColor = "var(--orchestr-line)")
              }
            >
              <NodeIcon nodeType={`${app.slug}.connection`} size={24} />
              <span
                className="text-[11px] leading-tight text-center px-1 line-clamp-2"
                style={{ color: "var(--orchestr-ink-muted)" }}
              >
                {app.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The per-app credential form, rendered from the app's auth scheme. */
function AppCredentialForm({
  app,
  hasEnvProvider,
  onBack,
  onConnected,
}: {
  app: ByoApp;
  hasEnvProvider: boolean;
  onBack: () => void;
  onConnected: () => void;
}) {
  const { scheme } = app;
  const [displayName, setDisplayName] = useState("");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // Own-client is expanded by default with no env provider, since it is then the only path.
  const [useOwnClient, setUseOwnClient] = useState(
    scheme.type === "oauth2" && !hasEnvProvider,
  );
  const [own, setOwn] = useState<ByoOAuthClient>(() => ({
    client_id: "",
    client_secret: "",
    auth_url: scheme.type === "oauth2" ? (scheme.authUrl ?? "") : "",
    token_url: scheme.type === "oauth2" ? (scheme.tokenUrl ?? "") : "",
    scopes: scheme.type === "oauth2" ? scheme.scopes : [],
    use_pkce: true,
  }));
  const [scopesText, setScopesText] = useState(
    scheme.type === "oauth2" ? scheme.scopes.join(" ") : "",
  );

  // Creates a token connection (apiKey / basic / custom), then probes it for an immediate verdict.
  const saveToken = async () => {
    const credential = shapeDirectCredential(scheme, {
      token,
      username,
      password,
    });
    if (!credential || busy) return;
    setBusy(true);
    try {
      const conn = await api.createTokenConnection({
        provider: app.slug,
        credential,
        display_name: displayName.trim() || undefined,
      });
      toast.success(`Connected ${app.name}`, displayName.trim() || undefined);
      onConnected();
      try {
        const res = await api.testConnection(conn.id);
        if (!res.ok)
          toast.warning(`${app.name} saved, but the check failed`, res.detail);
      } catch {
        /* the connection is saved regardless; the band's Test can re-check */
      }
    } catch (e) {
      toast.error(
        `Couldn't connect ${app.name}`,
        e instanceof Error ? e.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  const startOAuth = async (ownClient?: ByoOAuthClient) => {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await connectByoOAuth(app.slug, ownClient);
      if (outcome.ok) {
        toast.success(`Connected ${app.name}`);
        onConnected();
      } else if (outcome.reason === "blocked") {
        toast.error(
          "Sign-in popup was blocked",
          "Allow popups for this site, then try again.",
        );
      } else if (outcome.reason === "start-failed") {
        toast.error(`Couldn't start connecting ${app.name}`, outcome.message);
      } else if (outcome.reason === "timeout") {
        toast.error(`${app.name} sign-in timed out`, "Try again.");
      } else {
        toast.info(
          "Sign-in window closed",
          `No ${app.name} connection was added.`,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const ownClientValid =
    own.client_id.trim() !== "" &&
    own.client_secret.trim() !== "" &&
    own.auth_url.trim() !== "" &&
    own.token_url.trim() !== "";

  const tokenValid =
    shapeDirectCredential(scheme, { token, username, password }) !== null;

  return (
    <div className="flex flex-col gap-3">
      <button
        onClick={onBack}
        className="self-start inline-flex items-center gap-1 text-[12px] bg-transparent border-none cursor-pointer px-0"
        style={{ color: "var(--orchestr-ink-muted)" }}
      >
        <ChevronLeft size={13} /> All apps
      </button>

      <div className="flex items-center gap-2">
        <NodeIcon nodeType={`${app.slug}.connection`} size={22} />
        <div
          className="text-[14px] font-semibold"
          style={{ color: "var(--orchestr-ink)" }}
        >
          Connect {app.name}
        </div>
      </div>

      {/* apiKey / custom: one secret field */}
      {(scheme.type === "apiKey" || scheme.type === "custom") && (
        <>
          <Field label={scheme.type === "apiKey" ? "API key" : "Secret"}>
            <Input
              type="password"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste your key"
              data-testid="byo-token"
            />
          </Field>
          {scheme.type === "apiKey" && (
            <Hint>
              Sent as the <code>{scheme.name}</code>{" "}
              {scheme.in === "query" ? "query parameter" : "header"}
              {scheme.prefix ? ` with the “${scheme.prefix}” prefix` : ""}.
            </Hint>
          )}
          <DisplayNameField value={displayName} onChange={setDisplayName} />
          <div className="flex justify-end pt-1">
            <Button
              variant="ai"
              size="sm"
              disabled={!tokenValid || busy}
              onClick={() => void saveToken()}
            >
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </>
      )}

      {/* basic: username + password */}
      {scheme.type === "basic" && (
        <>
          <Field label="Username">
            <Input
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              data-testid="byo-username"
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="byo-password"
            />
          </Field>
          <DisplayNameField value={displayName} onChange={setDisplayName} />
          <div className="flex justify-end pt-1">
            <Button
              variant="ai"
              size="sm"
              disabled={!tokenValid || busy}
              onClick={() => void saveToken()}
            >
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </>
      )}

      {/* oauth2: our app (if configured) and/or the user's own client */}
      {scheme.type === "oauth2" && (
        <>
          {hasEnvProvider && (
            <div className="flex flex-col gap-2">
              <Button
                variant="ai"
                size="sm"
                disabled={busy}
                onClick={() => void startOAuth()}
                data-testid="byo-oauth-managed"
              >
                {busy ? "Connecting…" : `Connect with ${app.name}`}
              </Button>
              <button
                onClick={() => setUseOwnClient((v) => !v)}
                className="self-start text-[12px] bg-transparent border-none cursor-pointer px-0"
                style={{ color: "var(--orchestr-accent)" }}
              >
                {useOwnClient
                  ? "Hide own OAuth app"
                  : "Use your own OAuth app →"}
              </button>
            </div>
          )}
          {useOwnClient && (
            <div className="flex flex-col gap-3 pt-1">
              {!hasEnvProvider && (
                <Hint>
                  Register an OAuth app with {app.name}, set its redirect URL to
                  the address below, and paste the client details.
                </Hint>
              )}
              <RedirectUrlField />
              <Field label="Client ID">
                <Input
                  value={own.client_id}
                  onChange={(e) =>
                    setOwn({ ...own, client_id: e.target.value })
                  }
                  data-testid="byo-client-id"
                />
              </Field>
              <Field label="Client secret">
                <Input
                  type="password"
                  value={own.client_secret}
                  onChange={(e) =>
                    setOwn({ ...own, client_secret: e.target.value })
                  }
                  data-testid="byo-client-secret"
                />
              </Field>
              <Field label="Authorization URL">
                <Input
                  value={own.auth_url}
                  onChange={(e) => setOwn({ ...own, auth_url: e.target.value })}
                />
              </Field>
              <Field label="Token URL">
                <Input
                  value={own.token_url}
                  onChange={(e) =>
                    setOwn({ ...own, token_url: e.target.value })
                  }
                />
              </Field>
              <Field label="Scopes">
                <Input
                  value={scopesText}
                  onChange={(e) => {
                    setScopesText(e.target.value);
                    setOwn({
                      ...own,
                      scopes: e.target.value.split(/[\s,]+/).filter(Boolean),
                    });
                  }}
                  placeholder="space or comma separated"
                />
              </Field>
              <div className="flex justify-end">
                <Button
                  variant="ai"
                  size="sm"
                  disabled={!ownClientValid || busy}
                  onClick={() => void startOAuth(own)}
                  data-testid="byo-oauth-own"
                >
                  {busy ? "Connecting…" : "Connect"}
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {scheme.type === "none" && (
        <Hint>
          {app.name} needs no credentials — add it to a workflow directly.
        </Hint>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span
        className="text-[11px] font-medium"
        style={{ color: "var(--orchestr-ink-muted)" }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <p
      className="text-[11px] m-0"
      style={{ color: "var(--orchestr-ink-subtle)" }}
    >
      {children}
    </p>
  );
}

/** The redirect URL to register with the user's own OAuth app; the callback is a route on this app. */
function RedirectUrlField() {
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const url = `${origin}/integrations/callback`;
  return (
    <Field label="Redirect URL">
      <div className="flex items-center gap-1.5">
        <code
          className="flex-1 min-w-0 truncate text-[11px] px-2 py-1.5 rounded-md"
          style={{ background: "var(--orchestr-surface-raised)", color: "var(--orchestr-ink-muted)" }}
          title={url}
        >
          {url}
        </code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(url);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
          className="shrink-0 inline-flex items-center gap-1 text-[11px] bg-transparent border-none cursor-pointer px-1"
          style={{ color: "var(--orchestr-ink-muted)" }}
          data-testid="byo-redirect-copy"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </Field>
  );
}

function DisplayNameField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label="Name (optional)">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Work account"
      />
    </Field>
  );
}
