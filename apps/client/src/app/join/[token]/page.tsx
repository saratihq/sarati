"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AlertTriangle, Building2, UserPlus } from "lucide-react";
import * as api from "@/api/client";
import type { OrgRole } from "@/api/client";
import { useOrgs } from "@/store/useOrgs";
import { Button } from "@/components/ui/button";
import { LocalAuthForm } from "@/components/LocalAuthForm";
import { clerkEnabled } from "@/lib/config";
import { readLocalSession } from "@/lib/localSession";
import { toast } from "@/lib/toast";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useLocalAuthStatus } from "@/lib/useLocalAuthStatus";
import { SaratiLoader } from "@/components/SaratiLogo";

const CARD_STYLE = {
  background: "var(--orchestr-surface-card)",
  border: "1px solid var(--orchestr-line)",
} as const;

/**
 * Invite landing page. Mount only PREVIEWS the invite — accepting consumes the token and fires on
 * "Join" alone. Success navigates client-side (not the hard reload org-switching uses): a joiner has
 * no org-scoped caches to drop yet, and SPA nav lets the "Joined" toast survive.
 *
 * On a self-hosted instance the invitee may have no account at all, in which case the page registers
 * them against the invite instead (ADR 0054) — the service accepts it as part of registration.
 */
export default function JoinPage() {
  useDocumentTitle("Join organization");
  const params = useParams();
  const token = typeof params.token === "string" ? params.token : "";
  const router = useRouter();
  const fetchOrgs = useOrgs((s) => s.fetchOrgs);

  const { status, error: statusError } = useLocalAuthStatus();
  const [signedIn] = useState(() => Boolean(readLocalSession()));
  const [preview, setPreview] = useState<{ org_name: string; role: OrgRole } | null>(null);
  const [error, setError] = useState<string | null>(() =>
    token ? null : "This invite link is missing its token.",
  );
  const [joining, setJoining] = useState(false);
  // StrictMode double-mounts in dev; the GET is idempotent, so this only avoids a duplicate request.
  const previewed = useRef(false);

  // A Clerk build gates this route in middleware, so the visitor always has a session there. Until the
  // status lands we cannot tell "accept" from "register", so neither card may render yet.
  const resolving = !clerkEnabled && !status && !statusError;
  const needsAccount = !clerkEnabled && status?.enabled === true && !signedIn;

  // Unauthenticated by design (ADR 0054), so this runs even for an invitee with no account yet.
  useEffect(() => {
    if (!token || previewed.current) return;
    previewed.current = true;
    (async () => {
      try {
        const { org_name, role } = await api.previewOrgInvite(token);
        setPreview({ org_name, role });
      } catch (e) {
        setError(e instanceof Error ? e.message : "This invite link is invalid or has expired.");
      }
    })();
  }, [token]);

  const join = async () => {
    setJoining(true);
    try {
      const { org_id, name } = await api.acceptOrgInvite(token);
      api.setActiveOrgId(org_id);
      await fetchOrgs({ force: true }); // pick up the new org before the dashboard renders
      toast.success(`Joined ${name}`, "You're now working in this organization.");
      router.replace("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "This invite link is invalid or has expired.");
      setJoining(false);
    }
  };

  // Registration already consumed the invite, so the org is knowable only from the fresh org list.
  const enterAsNewMember = async () => {
    await fetchOrgs({ force: true });
    const joined = useOrgs.getState().orgs.find((o) => !o.is_personal);
    api.setActiveOrgId(joined?.id ?? null);
    window.location.assign("/"); // scoping to a different org is a full reload (see useOrgs)
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "var(--orchestr-surface)", color: "var(--orchestr-ink)" }}
    >
      {error ? (
        <div className="rounded-2xl p-8 max-w-[420px] w-full text-center" style={CARD_STYLE}>
          <div
            className="w-10 h-10 rounded-xl mx-auto mb-4 flex items-center justify-center"
            style={{ background: "var(--orchestr-warning-tint)", color: "var(--orchestr-warning)" }}
          >
            <AlertTriangle size={18} />
          </div>
          <h1 className="text-[16px] font-semibold m-0 mb-1.5">This invite can&apos;t be used</h1>
          <p className="text-[13px] m-0 mb-2 leading-relaxed" style={{ color: "var(--orchestr-ink-muted)" }}>
            {error}
          </p>
          <p className="text-[13px] m-0 mb-6 leading-relaxed" style={{ color: "var(--orchestr-ink-subtle)" }}>
            Ask whoever invited you for a fresh link — invites expire and can only be used once.
          </p>
          <Button variant="secondary" onClick={() => router.push("/")}>
            Go to dashboard
          </Button>
        </div>
      ) : needsAccount ? (
        <div className="rounded-2xl p-8 max-w-[420px] w-full" style={CARD_STYLE}>
          <div className="text-center mb-6">
            <div
              className="w-11 h-11 rounded-xl mx-auto mb-4 flex items-center justify-center"
              style={{ background: "var(--orchestr-accent-tint-strong)", color: "var(--orchestr-ink)" }}
            >
              <UserPlus size={20} />
            </div>
            <h1 className="text-[17px] font-semibold m-0 mb-1.5">
              {preview ? `Join ${preview.org_name}` : "You've been invited"}
            </h1>
            <p className="text-[13px] m-0 leading-relaxed" style={{ color: "var(--orchestr-ink-muted)" }}>
              {preview ? (
                <>
                  You&apos;ve been invited as{" "}
                  <span className="capitalize" style={{ color: "var(--orchestr-ink)" }}>
                    {preview.role}
                  </span>
                  . Create your account using the email address the invite was sent to.
                </>
              ) : (
                "Create your account to join the team. Use the email address the invite was sent to."
              )}
            </p>
          </div>
          <LocalAuthForm
            kind="register"
            inviteToken={token}
            submitLabel="Create account & join"
            onDone={enterAsNewMember}
          />
        </div>
      ) : preview && !resolving ? (
        <div className="rounded-2xl p-8 max-w-[420px] w-full text-center" style={CARD_STYLE}>
          <div
            className="w-11 h-11 rounded-xl mx-auto mb-4 flex items-center justify-center"
            style={{ background: "var(--orchestr-accent-tint-strong)", color: "var(--orchestr-ink)" }}
          >
            <Building2 size={20} />
          </div>
          <h1 className="text-[17px] font-semibold m-0 mb-1.5">Join {preview.org_name}?</h1>
          <p className="text-[13px] m-0 mb-6 leading-relaxed" style={{ color: "var(--orchestr-ink-muted)" }}>
            You&apos;ve been invited to join <span style={{ color: "var(--orchestr-ink)" }}>{preview.org_name}</span> as{" "}
            <span className="capitalize" style={{ color: "var(--orchestr-ink)" }}>
              {preview.role}
            </span>
            . You&apos;ll switch to this organization&apos;s workspace — you can leave any time.
          </p>
          <div className="flex items-center justify-center gap-2">
            <Button variant="ghost" onClick={() => router.push("/")} disabled={joining}>
              Not now
            </Button>
            <Button onClick={join} disabled={joining}>
              {joining ? "Joining..." : `Join ${preview.org_name}`}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <SaratiLoader size={48} />
          <p className="text-sm m-0" style={{ color: "var(--orchestr-ink-muted)" }}>
            Loading invitation...
          </p>
        </div>
      )}
    </div>
  );
}
