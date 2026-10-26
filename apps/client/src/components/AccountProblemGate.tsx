"use client";

import { useState, type ReactNode } from "react";
import * as api from "@/api/client";
import { INPUT_STYLE } from "@/components/LocalAuthForm";
import { AuthHeading, AuthShell } from "@/components/LocalAuthGate";
import { Button } from "@/components/ui/button";
import { useAccountProblem, type AccountProblem } from "@/store/useAccountProblem";

async function signOut(): Promise<void> {
  useAccountProblem.getState().clear();
  await api.signOut();
}

function LinkAccount({ email }: { email: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setError(null);
    setBusy(true);
    try {
      await api.linkClerkAccount(password);
      useAccountProblem.getState().clear();
      // Every store loaded before the link belongs to no account; start over as the linked one.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Link your account">
      <AuthHeading title="Link your account" subtitle={`An account for ${email} already exists here`} />
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="text-[13px] leading-relaxed m-0" style={{ color: "var(--orchestr-ink-muted)" }}>
          {"Enter that account's password to link it. After that, signing in this way opens it, with its workflows and organizations."}
        </p>
        <div>
          <label htmlFor="link-password" className="block text-xs mb-1.5 font-medium" style={{ color: "var(--orchestr-ink-muted)" }}>
            Password
          </label>
          <input
            id="link-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
            autoComplete="current-password"
            className="w-full py-2.5 px-3 rounded-lg text-sm outline-none"
            style={INPUT_STYLE}
            placeholder="The account's password"
          />
        </div>
        {error && (
          <p className="text-xs m-0" role="alert" style={{ color: "var(--orchestr-danger)" }}>
            {error}
          </p>
        )}
        <Button type="submit" variant="ai" disabled={!password || busy} className="w-full">
          {busy ? "Linking..." : "Link account"}
        </Button>
        <Button type="button" variant="ghost" className="w-full" onClick={signOut}>
          Sign out
        </Button>
      </form>
      <p className="text-center text-[11px] mt-6 m-0 leading-relaxed" style={{ color: "var(--orchestr-ink-subtle)" }}>
        {"Don't know the password? An owner of this instance can set a new one for you."}
      </p>
    </AuthShell>
  );
}

function AccountRefused({ problem }: { problem: AccountProblem }) {
  return (
    <AuthShell title="No account for this sign-in">
      <AuthHeading title="No account for this sign-in" subtitle="You're signed in, but this instance can't open an account for you" />
      <p role="alert" className="text-[13px] text-center leading-relaxed m-0 mb-6" style={{ color: "var(--orchestr-ink-subtle)" }}>
        {problem.detail}
      </p>
      <Button variant="secondary" className="w-full" onClick={signOut}>
        Sign out
      </Button>
    </AuthShell>
  );
}

/** Stands in for the app while the signed-in session has no account it can open, so the reason is on screen. */
export function AccountProblemGate({ children }: { children: ReactNode }) {
  const problem = useAccountProblem((s) => s.problem);
  if (!problem) return <>{children}</>;
  if (problem.code === "account_link_required" && problem.email) return <LinkAccount email={problem.email} />;
  return <AccountRefused problem={problem} />;
}
