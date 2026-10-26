import { useEffect, useState } from "react";
import * as api from "@/api/client";

const PENDING_KEY = "sarati:oidc-pending";

/** What the tab that started a single sign-on flow remembers until the provider sends the person back. */
export interface OidcPending {
  /** The per-tab secret: only its sha256 ever reaches the service before the callback. */
  binding: string;
  purpose: "sign_in" | "link";
  return_to: string;
  invite_token?: string;
  state?: string;
}

/** Thrown when this browser cannot run the flow at all, before anything is sent. */
export class OidcBrowserError extends Error {}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function createBinding(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function bindingHash(binding: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new OidcBrowserError(
      "Single sign-on needs a secure page — open Sarati over https, or at localhost on this machine.",
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(binding));
  return base64url(new Uint8Array(digest));
}

export function writePending(pending: OidcPending): void {
  try {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    throw new OidcBrowserError(
      "This browser is blocking site storage, which single sign-on needs to finish in this tab. Allow it for this site and try again.",
    );
  }
}

function isPending(value: unknown): value is OidcPending {
  const p = value as Partial<OidcPending> | null;
  return (
    typeof p?.binding === "string" &&
    (p.purpose === "sign_in" || p.purpose === "link") &&
    typeof p.return_to === "string" &&
    (p.state === undefined || typeof p.state === "string") &&
    (p.invite_token === undefined || typeof p.invite_token === "string")
  );
}

/** Read the pending flow and forget it, so a reload or a second tab can never replay it. */
export function takePending(): OidcPending | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY);
    window.sessionStorage.removeItem(PENDING_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isPending(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Start a flow in this tab and send the person to their identity provider. */
export async function beginOidcFlow(
  flow:
    | { purpose: "sign_in"; returnTo: string; inviteToken?: string }
    | { purpose: "link"; returnTo: string; currentPassword?: string },
): Promise<void> {
  const binding = createBinding();
  const hash = await bindingHash(binding);
  const pending: OidcPending = {
    binding,
    purpose: flow.purpose,
    return_to: flow.returnTo,
    ...(flow.purpose === "sign_in" && flow.inviteToken ? { invite_token: flow.inviteToken } : {}),
  };
  writePending(pending);
  let started: api.OidcFlowStart;
  try {
    started =
      flow.purpose === "sign_in"
        ? await api.startOidcSignIn(hash, flow.inviteToken)
        : await api.startOidcLink(hash, flow.currentPassword);
  } catch (err) {
    takePending();
    throw err;
  }
  writePending({ ...pending, state: started.state });
  window.location.assign(started.authorize_url);
}

/** Busy state for a control that leaves for the provider: Back restores the page from the back-forward cache, so it clears then. */
export function useLeavingState(): [boolean, (busy: boolean) => void] {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => e.persisted && setBusy(false);
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  return [busy, setBusy];
}
