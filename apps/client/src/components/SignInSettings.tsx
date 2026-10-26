"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import * as api from "@/api/client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { InlineError } from "@/components/ui/inline-error";
import { beginOidcFlow, useLeavingState } from "@/lib/oidcFlow";
import { toast } from "@/lib/toast";

const ROW_STYLE = { background: "var(--orchestr-surface-card)", border: "1px solid var(--orchestr-line)" } as const;

interface Loaded {
  signIn: api.SignInMethods;
  passwordsOn: boolean;
}

/** Profile → single sign-on: connect the account to the identity provider, or disconnect it. Hidden without single sign-on. */
export default function SignInSettings() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useLeavingState();
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      const [me, status] = await Promise.all([api.authMe(), api.getLocalAuthStatus()]);
      setLoaded({ signIn: me.sign_in, passwordsOn: status.enabled });
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load how you sign in");
    }
  }, []);

  useEffect(() => {
    // Mount data-fetch: load() setStates only after its await, so it is a real effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (loadError) return <div className="mt-2"><InlineError message={loadError} onRetry={() => void load()} /></div>;
  const sso = loaded?.signIn.sso;
  if (!loaded || !sso) return null;
  const hasPassword = loaded.signIn.password;

  const connect = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (hasPassword && !password) return;
    setError(null);
    setLeaving(true);
    try {
      await beginOidcFlow({ purpose: "link", returnTo: "/settings", currentPassword: hasPassword ? password : undefined });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Single sign-on couldn't start. Try again.");
      setLeaving(false);
    }
  };

  const disconnect = async () => {
    setConfirming(false);
    try {
      await api.unlinkOidc();
      toast.success("Single sign-on disconnected", "You sign in with your email and password.");
      await load();
    } catch (err) {
      toast.error("Couldn't disconnect", err instanceof Error ? err.message : undefined);
    }
  };

  const onlyWayIn = !hasPassword
    ? "It's the only way into your account."
    : !loaded.passwordsOn
      ? "Password sign-in is off on this instance, so it's your only way in."
      : null;

  return (
    <div className="rounded-lg p-5 mt-2" style={ROW_STYLE}>
      <div className="flex items-center gap-4">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: "var(--orchestr-accent-tint)", color: "var(--orchestr-ink-muted)" }}
        >
          <KeyRound size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate m-0" style={{ color: "var(--orchestr-ink)" }}>
            Single sign-on
          </p>
          <p className="text-xs mt-0.5 m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
            {sso.connected
              ? sso.email
                ? `Connected as ${sso.email}`
                : "Connected"
              : "Not connected — connect it to sign in through your identity provider"}
          </p>
        </div>
        {sso.connected ? (
          <Button variant="secondary" size="sm" disabled={Boolean(onlyWayIn)} onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        ) : (
          !asking && (
            <Button
              variant="secondary"
              size="sm"
              disabled={leaving}
              onClick={() => (hasPassword ? setAsking(true) : void connect())}
            >
              {leaving ? "Redirecting..." : "Connect"}
            </Button>
          )
        )}
      </div>

      {sso.connected && onlyWayIn && (
        <p className="text-[11px] mt-3 m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
          {onlyWayIn}
        </p>
      )}

      {!sso.connected && asking && (
        <form onSubmit={connect} className="mt-4 flex flex-col gap-3">
          <div>
            <label htmlFor="sso-current-password" className="block text-xs mb-1.5 font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
              Current password
            </label>
            <input
              id="sso-current-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
              className="w-full py-2 px-3 rounded-lg text-sm outline-none"
              style={{ background: "var(--orchestr-accent-tint)", border: "1px solid var(--orchestr-line)", color: "var(--orchestr-ink)" }}
            />
            <p className="text-[11px] mt-1.5 m-0" style={{ color: "var(--orchestr-ink-subtle)" }}>
              Confirm it&apos;s you, then sign in at your identity provider to connect it.
            </p>
          </div>
          {error && (
            <p className="text-xs m-0" role="alert" style={{ color: "var(--orchestr-danger)" }}>
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={leaving}
              onClick={() => {
                setAsking(false);
                setPassword("");
                setError(null);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="secondary" size="sm" disabled={leaving || !password}>
              {leaving ? "Redirecting..." : "Continue"}
            </Button>
          </div>
        </form>
      )}

      {!sso.connected && !asking && error && (
        <p className="text-xs mt-3 m-0" role="alert" style={{ color: "var(--orchestr-danger)" }}>
          {error}
        </p>
      )}

      <ConfirmDialog
        open={confirming}
        title="Disconnect single sign-on?"
        message="You'll sign in with your email and password only. You can connect it again here."
        confirmLabel="Disconnect"
        onConfirm={() => void disconnect()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
