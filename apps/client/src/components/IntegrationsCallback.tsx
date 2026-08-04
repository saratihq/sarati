"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "@/lib/toast";
import * as api from "@/api/client";
import { Button } from "@/components/ui/button";
import { SaratiLoader } from "@/components/SaratiLogo";

// When the BYO connect form opened this as a popup there is a `window.opener`: post the result and
// close, so the surface underneath stays put. Full-page redirects fall through to the in-page UI.
function notifyOpener(ok: boolean, error?: string): boolean {
  if (typeof window === "undefined") return false;
  const opener = window.opener as Window | null;
  if (!opener || opener.closed) return false;
  try {
    opener.postMessage({ type: "orchestr-oauth", ok, error }, window.location.origin);
    window.close();
    return true;
  } catch {
    return false;
  }
}
/** OAuth landing for BYO connections (?code=&state=); managed/Composio popups never hit this route. */
export default function IntegrationsCallback() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  // Providers signal a declined/failed consent with ?error= instead of a code.
  const providerError = searchParams.get("error");
  const hasParams = Boolean(code && state);
  const [status, setStatus] = useState<"loading" | "success" | "error">(hasParams ? "loading" : "error");
  const [error, setError] = useState(
    hasParams
      ? ""
      : providerError
        ? `The provider didn't authorize the connection (${providerError})`
        : "Missing code or state from the provider",
  );
  const [label, setLabel] = useState("");
  // The OAuth code is single-use, so guard StrictMode's double effect mount against a second exchange.
  const started = useRef(false);

  // Provider declined (no code): in a popup tell the opener, otherwise the in-page error UI handles it.
  useEffect(() => {
    if (!hasParams) notifyOpener(false, error || "OAuth failed");
  }, [hasParams, error]);

  useEffect(() => {
    if (!code || !state) return;
    if (started.current) return;
    started.current = true;

    api
      .completeIntegrationOAuth(code, state)
      .then(({ connection }) => {
        if (notifyOpener(true)) return;
        setLabel(connection.display_name || connection.provider);
        setStatus("success");
        toast.success("Integration connected", connection.display_name || connection.provider);
        setTimeout(() => router.push("/integrations"), 1800);
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : "OAuth failed";
        if (notifyOpener(false, message)) return;
        setStatus("error");
        setError(message);
      });
  }, [code, state, router]);

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--orchestr-surface)" }}>
      <div
        className="w-[400px] rounded-2xl p-8 text-center"
        style={{
          background: "var(--orchestr-surface-card)",
          border: "1px solid var(--orchestr-line)",
        }}
      >
        {status === "loading" && (
          <>
            <div className="flex justify-center mb-4">
              <SaratiLoader size={32} />
            </div>
            <div className="text-[14px]" style={{ color: "var(--orchestr-ink-muted)" }}>
              Finishing sign-in…
            </div>
          </>
        )}

        {status === "success" && (
          <>
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: "var(--orchestr-success-tint)" }}
            >
              <svg
                viewBox="0 0 24 24"
                width="24"
                height="24"
                fill="none"
                stroke="var(--orchestr-success)"
                strokeWidth="2.5"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div className="text-[16px] font-semibold mb-1" style={{ color: "var(--orchestr-ink)" }}>
              Connected {label}
            </div>
            <div className="text-[12px]" style={{ color: "var(--orchestr-ink-muted)" }}>
              Redirecting to Integrations…
            </div>
          </>
        )}

        {status === "error" && (
          <>
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: "var(--orchestr-danger-tint)" }}
            >
              <svg
                viewBox="0 0 24 24"
                width="24"
                height="24"
                fill="none"
                stroke="var(--orchestr-danger)"
                strokeWidth="2.5"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </div>
            <div className="text-[14px] text-[var(--orchestr-danger)] mb-3">{error}</div>
            <Button variant="secondary" size="sm" onClick={() => router.push("/integrations")}>
              Back to Integrations
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
