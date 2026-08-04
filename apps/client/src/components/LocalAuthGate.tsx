"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { LocalAuthForm } from "@/components/LocalAuthForm";
import { SaratiLoader, SaratiSquircle } from "@/components/SaratiLogo";
import { clerkEnabled } from "@/lib/config";
import { readLocalSession } from "@/lib/localSession";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useLocalAuthStatus } from "@/lib/useLocalAuthStatus";
import { safeReturnTo } from "@/lib/useRedirectIfSignedIn";

/** Which auth route is asking: they share the local surface but land on different states. */
export type LocalAuthVariant = "signin" | "signup" | "reset";

// The title is set here, not in the gate: the gate also renders the Clerk pages, which set their own.
function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  useDocumentTitle(title);
  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: "var(--orchestr-surface)" }}>
      <div
        className="w-full max-w-[380px] rounded-lg p-8"
        style={{ background: "var(--orchestr-surface-raised)", border: "1px solid var(--orchestr-line)" }}
      >
        {children}
      </div>
    </div>
  );
}

function AuthHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-8 text-center">
      <div className="flex items-center justify-center mb-4">
        <SaratiSquircle size={48} />
      </div>
      <h1 className="text-xl font-semibold mb-1" style={{ color: "var(--orchestr-ink)" }}>
        {title}
      </h1>
      <p className="text-sm m-0" style={{ color: "var(--orchestr-ink-muted)" }}>
        {subtitle}
      </p>
    </div>
  );
}

function AuthNotice({ title, subtitle, body }: { title: string; subtitle: string; body: string }) {
  const router = useRouter();
  return (
    <AuthShell title={title}>
      <AuthHeading title={title} subtitle={subtitle} />
      <p className="text-[13px] text-center leading-relaxed m-0 mb-6" style={{ color: "var(--orchestr-ink-subtle)" }}>
        {body}
      </p>
      <Button variant="secondary" className="w-full" onClick={() => router.push("/login")}>
        Back to sign in
      </Button>
    </AuthShell>
  );
}

/**
 * Picks the sign-in surface: the local email + password screens when the service offers them
 * (ADR 0054), otherwise `children` — today's Clerk flow, untouched.
 */
export default function LocalAuthGate({ variant, children }: { variant: LocalAuthVariant; children: ReactNode }) {
  const { status, error } = useLocalAuthStatus();
  const router = useRouter();
  const enabled = status?.enabled === true;
  const bootstrapping = enabled && status.awaiting_bootstrap;

  // A live local session has no business on the sign-in screens.
  useEffect(() => {
    if (enabled && readLocalSession()) router.replace(safeReturnTo());
  }, [enabled, router]);

  // Not local: a Clerk build shows its own screens for all three cases, including while the answer is
  // still in flight — waiting would put a loader in front of a flow that has none today.
  if (!enabled) {
    if (clerkEnabled) return <>{children}</>;
    if (!status && !error) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center gap-4" style={{ background: "var(--orchestr-surface)" }}>
          <SaratiLoader size={48} />
          <p className="text-sm m-0" style={{ color: "var(--orchestr-ink-muted)" }}>
            Checking how this instance signs you in...
          </p>
        </div>
      );
    }
    if (error) {
      return <AuthNotice title="Can't reach your instance" subtitle="The Sarati server didn't answer" body={error} />;
    }
    return (
      <AuthNotice
        title="No sign-in configured"
        subtitle="This instance has no way to authenticate you"
        body="Set LOCAL_AUTH_ENABLED=true on the service for email and password, or configure an identity provider."
      />
    );
  }

  if (variant === "reset") {
    return (
      <AuthNotice
        title="Password reset isn't available"
        subtitle="This instance signs in with email and password"
        body="There's no mailer on a self-hosted instance, so an owner has to set a new password for you."
      />
    );
  }

  if (bootstrapping) {
    return (
      <AuthShell title="Create your account">
        <AuthHeading title="Welcome to Sarati" subtitle="You're the first one here — create the owner account for this instance." />
        <LocalAuthForm kind="register" submitLabel="Create account" onDone={() => router.replace(safeReturnTo())} />
        <p className="text-center text-[11px] mt-6 m-0 leading-relaxed" style={{ color: "var(--orchestr-ink-subtle)" }}>
          This is the only account that can be created without an invite. Everyone after you joins
          through an invite link.
        </p>
      </AuthShell>
    );
  }

  if (variant === "signup") {
    return (
      <AuthNotice
        title="This instance is invite-only"
        subtitle="Its first account already exists"
        body="Ask an owner to invite you — they can send you a join link from Settings → Organization."
      />
    );
  }

  return (
    <AuthShell title="Sign in">
      <AuthHeading title="Welcome back" subtitle="Sign in to your version-controlled automations" />
      <LocalAuthForm kind="signin" submitLabel="Sign in" onDone={() => router.replace(safeReturnTo())} />
    </AuthShell>
  );
}
