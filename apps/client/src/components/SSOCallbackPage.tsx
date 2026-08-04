"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useClerk } from "@clerk/nextjs";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { SaratiLoader } from "@/components/SaratiLogo";

/** OAuth landing pad — Clerk exchanges the callback params for a session, then redirects. */
export default function SSOCallbackPage() {
  useDocumentTitle("Signing in");
  const { handleRedirectCallback } = useClerk();
  const [error, setError] = useState<string | null>(null);
  // The callback exchange is single-use, so guard StrictMode's double mount.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    handleRedirectCallback({
      signInFallbackRedirectUrl: "/",
      signUpFallbackRedirectUrl: "/",
    }).catch((err: unknown) => {
      const maybeClerk = err as { errors?: Array<{ longMessage?: string; message?: string }> };
      setError(maybeClerk.errors?.[0]?.longMessage || maybeClerk.errors?.[0]?.message || "Sign-in failed");
    });
  }, [handleRedirectCallback]);

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-4 px-4"
      style={{ background: "var(--orchestr-surface)" }}
    >
      {error ? (
        <>
          <p className="text-sm" style={{ color: "var(--orchestr-danger)" }}>
            {error}
          </p>
          <Link href="/login" className="text-sm hover:underline" style={{ color: "var(--orchestr-ink)" }}>
            Back to sign in
          </Link>
        </>
      ) : (
        <>
          <SaratiLoader size={56} />
          <p className="text-sm" style={{ color: "var(--orchestr-ink-muted)" }}>
            Completing sign-in…
          </p>
        </>
      )}
    </div>
  );
}
