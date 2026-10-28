"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { LocalAuthForm } from "@/components/LocalAuthForm";
import { SaratiLoader, SaratiSquircle } from "@/components/SaratiLogo";
import { SsoButton } from "@/components/SsoButton";
import { clerkEnabled } from "@/lib/config";
import { readLocalSession } from "@/lib/localSession";
import { safeReturnTo } from "@/lib/returnTo";
import { useDocumentTitle } from "@/lib/useDocumentTitle";
import { useLocalAuthStatus } from "@/lib/useLocalAuthStatus";

/** Which auth route is asking: they share the local surface but land on different states. */
export type LocalAuthVariant = "signin" | "signup" | "reset";

// The title is set here, not in the gate: the gate also renders the Clerk pages, which set their own.
export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
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

export function AuthHeading({ title, subtitle, focus = false }: { title: string; subtitle: string; focus?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus, title]);
  return (
    <div className="mb-8 text-center">
      <div className="flex items-center justify-center mb-4">
        <SaratiSquircle size={48} />
      </div>
      <h1
        ref={heading}
        tabIndex={focus ? -1 : undefined}
        className="text-xl font-semibold mb-1 outline-none"
        style={{ color: "var(--orchestr-ink)" }}
      >
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

function FinePrint({ children }: { children: ReactNode }) {
  return (
    <p className="text-center text-[11px] mt-6 m-0 leading-relaxed" style={{ color: "var(--orchestr-ink-subtle)" }}>
      {children}
    </p>
  );
}

const queryParam = (name: string) =>
  typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(name);

/**
 * Picks the sign-in surface: single sign-on and/or email + password when the service offers them,
 * otherwise `children` — today's Clerk flow, untouched.
 */
export default function LocalAuthGate({ variant, children }: { variant: LocalAuthVariant; children: ReactNode }) {
  const { status, error } = useLocalAuthStatus();
  const router = useRouter();
  const password = status?.enabled === true;
  const sso = status?.oidc === true;
  const local = password || sso;
  const bootstrapping = local && status?.awaiting_bootstrap === true;
  // Read per render, not once at mount: a client-side navigation commits the new URL after the first render.
  const [chosen, setChosen] = useState<"sso" | "password" | null>(null);
  const method = chosen ?? (queryParam("method") === "password" ? "password" : "sso");
  const signedOut = queryParam("signed_out") !== null;
  const showPassword = password && (!sso || method === "password");

  // A live local session has no business on the sign-in screens.
  useEffect(() => {
    if (local && readLocalSession()) router.replace(safeReturnTo());
  }, [local, router]);

  // Not local: a Clerk build shows its own screens for all three cases, including while the answer is
  // still in flight — waiting would put a loader in front of a flow that has none today.
  if (!local) {
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
        body="Set LOCAL_AUTH_ENABLED=true on the service for email and password, or OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET for single sign-on."
      />
    );
  }

  if (variant === "reset") {
    return password ? (
      <AuthNotice
        title="Password reset isn't available"
        subtitle="This instance signs in with email and password"
        body="There's no mailer on a self-hosted instance, so an owner has to set a new password for you."
      />
    ) : (
      <AuthNotice
        title="Reset it at your identity provider"
        subtitle="This instance signs in with single sign-on"
        body="Sarati never holds your password. Change it wherever your organization manages sign-in, then continue with single sign-on."
      />
    );
  }

  const done = () => router.replace(safeReturnTo());
  const switcher =
    password && sso ? (
      <Button
        type="button"
        variant="ghost"
        className="w-full mt-3"
        onClick={() => setChosen(method === "sso" ? "password" : "sso")}
      >
        {method === "password"
          ? "Use single sign-on instead"
          : bootstrapping
            ? "Create it with email and password instead"
            : "Use email and password instead"}
      </Button>
    ) : null;

  if (bootstrapping) {
    return (
      <AuthShell title="Create your account">
        <AuthHeading
          title="Welcome to Sarati"
          subtitle={
            showPassword
              ? "You're the first one here — create the owner account for this instance."
              : "You're the first one here — the account you sign in with becomes this instance's owner."
          }
        />
        {showPassword ? (
          <LocalAuthForm kind="register" submitLabel="Create account" onDone={done} />
        ) : (
          <SsoButton returnTo={safeReturnTo()} />
        )}
        {switcher}
        <FinePrint>
          {sso
            ? "After you, everyone your identity provider signs in gets an account of their own. Joining an organization still takes an invite."
            : "This is the only account that can be created without an invite. Everyone after you joins through an invite link."}
        </FinePrint>
      </AuthShell>
    );
  }

  if (variant === "signup") {
    if (!sso) {
      return (
        <AuthNotice
          title="This instance is invite-only"
          subtitle="Its first account already exists"
          body="Ask an owner to invite you — they can send you a join link from Settings → Organization."
        />
      );
    }
    return (
      <AuthShell title="Create your account">
        <AuthHeading
          title="Create your account"
          subtitle="Sign in through your identity provider — your account is made the first time."
        />
        <SsoButton returnTo={safeReturnTo()} />
        <FinePrint>Joining an organization takes an invite from one of its owners or admins.</FinePrint>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Sign in">
      <AuthHeading title="Welcome back" subtitle="Sign in to your version-controlled automations" />
      {showPassword ? (
        <LocalAuthForm kind="signin" submitLabel="Sign in" onDone={done} />
      ) : (
        <SsoButton returnTo={safeReturnTo()} />
      )}
      {switcher}
      {sso && signedOut && (
        <FinePrint>Signed out of Sarati — your identity provider may still be signed in.</FinePrint>
      )}
    </AuthShell>
  );
}
