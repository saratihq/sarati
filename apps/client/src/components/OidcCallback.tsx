"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as api from "@/api/client";
import { AuthHeading, AuthShell } from "@/components/LocalAuthGate";
import { SaratiLoader } from "@/components/SaratiLogo";
import { Button } from "@/components/ui/button";
import { beginOidcFlow, takePending, useLeavingState, type OidcPending } from "@/lib/oidcFlow";
import { toast } from "@/lib/toast";
import { safeReturnTo } from "@/lib/useRedirectIfSignedIn";

type Action = "restart" | "login" | "password" | "settings";

interface Failure {
  title: string;
  body: string;
  action: Action;
}

const ACTION_LABEL: Record<Action, string> = {
  restart: "Try again",
  login: "Back to sign in",
  password: "Sign in with password",
  settings: "Back to Settings",
};

// The provider's error_description is attacker-controllable text, so only these fixed codes pick the copy.
const PROVIDER_ERRORS: Record<string, string> = {
  access_denied: "You cancelled at your identity provider, or it declined to sign you in to Sarati.",
  login_required: "Your identity provider needs you to sign in again.",
  consent_required: "Your identity provider needs you to allow Sarati access first.",
  interaction_required: "Your identity provider needs you to finish signing in there first.",
  temporarily_unavailable: "Your identity provider is busy right now.",
  server_error: "Your identity provider ran into a problem.",
};

const NOT_THIS_TAB: Failure = {
  title: "This sign-in didn't start in this tab",
  body: "Single sign-on finishes only in the tab that started it. Sign in again from this tab.",
  action: "login",
};

const KEEPS_HAPPENING = "If it keeps happening, tell whoever runs this instance — their service log says why.";
const OTHER_ACCOUNT =
  "Confirm your address at your identity provider, or sign in there with an account whose address it has confirmed, then try again.";

const forLink = (failure: Failure): Failure => ({ ...failure, title: "Single sign-on wasn't connected", action: "settings" });

function providerFailure(error: string): Failure {
  return {
    title: "Your identity provider didn't sign you in",
    body: PROVIDER_ERRORS[error] ?? "It sent you back without a sign-in.",
    action: "restart",
  };
}

async function serviceFailure(err: unknown): Promise<Failure> {
  const code = err instanceof api.ApiError ? err.code : undefined;
  const detail = err instanceof Error ? err.message : "Something went wrong. Try again.";
  switch (code) {
    case "oidc_disabled":
      return { title: "Single sign-on isn't set up", body: "This instance doesn't offer single sign-on.", action: "login" };
    case "oidc_state_invalid":
      return {
        title: "This sign-in can't be finished",
        body: "It expired, was already used, or started in another tab.",
        action: "restart",
      };
    case "oidc_unavailable":
      return {
        title: "Can't reach your identity provider",
        body: `Sarati couldn't talk to it just now. ${KEEPS_HAPPENING}`,
        action: "restart",
      };
    case "oidc_token_rejected":
      return {
        title: "Sign-in couldn't be verified",
        body: `Your identity provider's answer didn't pass Sarati's checks. ${KEEPS_HAPPENING}`,
        action: "restart",
      };
    case "oidc_email_unverified":
      return { title: "This instance can't admit you", body: `${detail} ${OTHER_ACCOUNT}`, action: "login" };
    case "oidc_domain_not_allowed":
      return {
        title: "This instance can't admit you",
        body: `${detail} Sign in at your identity provider with your work account, or sign out there first, then try again.`,
        action: "login",
      };
    case "oidc_email_missing":
      return { title: "This instance can't admit you", body: detail, action: "login" };
    case "invite_email_mismatch":
      return { title: "This invite is for someone else", body: detail, action: "login" };
    case "invite_email_unverified":
      return { title: "This invite can't be matched to you", body: `${detail} ${OTHER_ACCOUNT}`, action: "login" };
    case "oidc_account_exists":
      return accountExists();
    default:
      return { title: "Sign-in didn't finish", body: detail, action: "restart" };
  }
}

async function accountExists(): Promise<Failure> {
  const passwords = await api
    .getLocalAuthStatus()
    .then((s) => s.enabled)
    .catch(() => false);
  return passwords
    ? {
        title: "You already have an account",
        body: "An account with this email exists. If it has a password, sign in with it, then connect single sign-on in Settings. If it has none, ask an operator to connect single sign-on to it.",
        action: "password",
      }
    : {
        title: "You already have an account",
        body: "An account with this email exists, and this instance has password sign-in off. Ask an operator to connect single sign-on to it.",
        action: "login",
      };
}

/** Send the provider's answer to the service and go where the flow was headed; the failure to show otherwise. */
async function finish(
  flow: OidcPending | null,
  params: URLSearchParams,
  navigate: (path: string) => void,
): Promise<Failure | null> {
  const state = params.get("state");
  if (!flow?.state || flow.state !== state) return NOT_THIS_TAB;
  const link = flow.purpose === "link";
  const code = params.get("code");
  const providerError = params.get("error");
  const iss = params.get("iss");
  if (providerError || !code) return providerFailure(providerError ?? "");
  try {
    const answer: api.OidcAnswer = { code, state, binding: flow.binding, ...(iss ? { iss } : {}) };
    if (link) {
      const { email } = await api.completeOidcLink(answer);
      toast.success("Single sign-on connected", email ? `You can now sign in as ${email}.` : undefined);
      navigate(safeReturnTo(flow.return_to));
      return null;
    }
    const grant = await api.completeOidcSignIn(answer);
    if (grant.joined_org_id) {
      api.setActiveOrgId(grant.joined_org_id);
      window.location.assign("/"); // scoping to a different org is a full reload (see useOrgs)
      return null;
    }
    navigate(safeReturnTo(flow.return_to));
    return null;
  } catch (err) {
    return serviceFailure(err);
  }
}

/** Where the identity provider sends the person back: finishes the flow this tab started, or says why it can't. */
export default function OidcCallback() {
  const router = useRouter();
  const [failure, setFailure] = useState<Failure | null>(null);
  // Each failure remounts its heading and message, so focus and the announcement follow a repeat of the same one.
  const [shown, setShown] = useState(0);
  const [restarting, setRestarting] = useLeavingState();
  const flow = useRef<OidcPending | null>(null);
  // The code is single use: StrictMode's second mount must not send it again.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    window.history.replaceState(null, "", window.location.pathname);
    flow.current = takePending();
    const link = flow.current?.purpose === "link";
    void finish(flow.current, params, (path) => router.replace(path)).then((failed) => {
      if (!failed) return;
      setFailure(link && failed !== NOT_THIS_TAB ? forLink(failed) : failed);
      setShown((n) => n + 1);
    });
  }, [router]);

  const act = async (action: Action) => {
    if (action === "settings") return router.replace("/settings");
    if (action === "login") return router.replace("/login");
    if (action === "password") {
      const next = flow.current?.invite_token ? flow.current.return_to : "/settings";
      return router.replace(`/login?method=password&redirect_url=${encodeURIComponent(next)}`);
    }
    setRestarting(true);
    try {
      await beginOidcFlow({
        purpose: "sign_in",
        returnTo: flow.current?.return_to ?? "/",
        inviteToken: flow.current?.invite_token,
      });
    } catch (err) {
      setFailure(await serviceFailure(err));
      setShown((n) => n + 1);
      setRestarting(false);
    }
  };

  if (!failure) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4" style={{ background: "var(--orchestr-surface)" }}>
        <SaratiLoader size={48} />
        <p className="text-sm m-0" style={{ color: "var(--orchestr-ink-muted)" }}>
          Finishing sign-in...
        </p>
      </div>
    );
  }

  return (
    <AuthShell title={failure.title}>
      <AuthHeading key={`heading-${shown}`} title={failure.title} subtitle="Single sign-on" focus />
      <p key={`body-${shown}`} role="alert" className="text-[13px] text-center leading-relaxed m-0 mb-6" style={{ color: "var(--orchestr-ink-muted)" }}>
        {failure.body}
      </p>
      <Button variant="secondary" className="w-full" disabled={restarting} onClick={() => act(failure.action)}>
        {restarting ? "Redirecting..." : ACTION_LABEL[failure.action]}
      </Button>
    </AuthShell>
  );
}
