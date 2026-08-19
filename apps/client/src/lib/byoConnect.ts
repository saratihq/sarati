"use client";

import * as api from "@/api/client";
import type { AuthScheme } from "@/api/client";
import { appDisplayName } from "@/lib/connections";

// Bring-your-own-auth: the user's OWN credential for an SDK app — a pasted key/basic creds,
// or their own OAuth app. Only rows carrying an `authScheme` are BYO-able; Composio apps are managed-only.

/** A BYO-connectable app: its slug, a display name, and the auth shape to render. */
export interface ByoApp {
  slug: string;
  name: string;
  scheme: AuthScheme;
}

/** Every SDK app with a non-`none` auth scheme; rows are per-action, so the first scheme per slug wins. */
export async function loadByoApps(): Promise<ByoApp[]> {
  const { node_types } = await api.listNodeTypes("orchestr");
  const bySlug = new Map<string, AuthScheme>();
  for (const nt of node_types) {
    const scheme = nt.authScheme;
    if (!scheme || scheme.type === "none") continue;
    if (!bySlug.has(nt.category)) bySlug.set(nt.category, scheme);
  }
  return [...bySlug.entries()]
    .map(([slug, scheme]) => ({ slug, name: appDisplayName(slug), scheme }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Shape a BYO credential per the app's scheme — must match the service's `toDirectCredential`
 * (`value` for a key/token, `{ username, password }` for basic). Null when required fields are missing.
 */
export function shapeDirectCredential(
  scheme: AuthScheme,
  fields: { token?: string; username?: string; password?: string },
): Record<string, unknown> | null {
  if (scheme.type === "apiKey" || scheme.type === "custom") {
    const value = fields.token?.trim();
    return value ? { value } : null;
  }
  if (scheme.type === "basic") {
    const username = fields.username?.trim();
    const password = fields.password ?? "";
    return username && password ? { username, password } : null;
  }
  return null;
}

// Kept in step with managedConnect's popup timeout.
const OAUTH_TIMEOUT_MS = 3 * 60 * 1_000;

export type ByoOAuthOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "blocked" | "start-failed" | "cancelled" | "timeout";
      message?: string;
    };

/**
 * Run the OAuth code flow in a popup; `ownClient` runs it against the user's OWN app. The callback page
 * posts back to `window.opener`, so the editor underneath stays put. Must be called inside a click gesture.
 */
export async function connectByoOAuth(
  provider: string,
  ownClient?: api.ByoOAuthClient,
): Promise<ByoOAuthOutcome> {
  const popup = window.open(
    "about:blank",
    "orchestr-connect",
    "popup,width=500,height=700",
  );
  if (!popup) return { ok: false, reason: "blocked" };

  let start: { authorize_url: string; state: string };
  try {
    start = await api.startIntegrationOAuth(provider, ownClient);
  } catch (e) {
    popup.close();
    return {
      ok: false,
      reason: "start-failed",
      message: e instanceof Error ? e.message : undefined,
    };
  }
  popup.location.href = start.authorize_url;
  popup.focus();

  return await new Promise<ByoOAuthOutcome>((resolve) => {
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearInterval(timer);
    };
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data as {
        type?: string;
        ok?: boolean;
        error?: string;
      } | null;
      if (!data || data.type !== "orchestr-oauth") return;
      cleanup();
      popup.close();
      resolve(
        data.ok
          ? { ok: true }
          : { ok: false, reason: "cancelled", message: data.error },
      );
    };
    window.addEventListener("message", onMessage);
    const deadline = Date.now() + OAUTH_TIMEOUT_MS;
    const timer = setInterval(() => {
      if (popup.closed) {
        cleanup();
        resolve({ ok: false, reason: "cancelled" });
      } else if (Date.now() > deadline) {
        cleanup();
        popup.close();
        resolve({ ok: false, reason: "timeout" });
      }
    }, 1_000);
  });
}
