"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { beginOidcFlow, useLeavingState } from "@/lib/oidcFlow";

/** The screen's primary action when single sign-on is on: sends this tab to the identity provider. */
export function SsoButton({ returnTo, inviteToken }: { returnTo: string; inviteToken?: string }) {
  const [busy, setBusy] = useLeavingState();
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      await beginOidcFlow({ purpose: "sign_in", returnTo, inviteToken });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Single sign-on couldn't start. Try again.");
      setBusy(false);
    }
  };

  return (
    <div>
      <Button type="button" variant="ai" className="w-full" disabled={busy} onClick={start}>
        {busy ? "Redirecting..." : "Continue with single sign-on"}
      </Button>
      {error && (
        <p className="text-xs mt-3 m-0" role="alert" style={{ color: "var(--orchestr-danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
