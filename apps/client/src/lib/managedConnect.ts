"use client";

import * as api from "@/api/client";

// The hosted-OAuth connect dance behind every Connect button: open the popup synchronously (blockers
// only trust the click's own task), start the link, then poll the connection's status to a verdict.

export type ConnectOutcome =
  | { ok: true; connectionId: string }
  | {
      ok: false;
      reason: "blocked" | "busy" | "start-failed" | "failed" | "cancelled" | "timeout" | "lost";
      message?: string;
    };

const POLL_MS = 2_000;
const TIMEOUT_MS = 3 * 60 * 1_000;
// The popup often closes as the provider redirects back — let the callback land before calling it cancelled.
const CLOSED_GRACE_POLLS = 3;
// Tolerate transient poll failures; give up only on repeated consecutive ones.
const MAX_CONSECUTIVE_POLL_ERRORS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One connect at a time: all flows share the named popup, so a second click would hijack the first
// sign-in and strand its poll loop.
let connectInFlight = false;

export type LinkFn = () => Promise<{ connection_id: string; redirect_url: string }>;

/** Hosted-OAuth connect; resolves (never rejects) with an outcome. Must be called inside a click gesture. */
async function connectManagedApp(appSlug: string, linkFn?: LinkFn): Promise<ConnectOutcome> {
  if (connectInFlight) {
    return { ok: false, reason: "busy" };
  }
  connectInFlight = true;
  try {
    return await runConnect(linkFn ?? (() => api.createManagedLink(appSlug)));
  } finally {
    connectInFlight = false;
  }
}

// An unfinished link leaves a pending row the connections list can't tell from a live one, so
// auto-attach could grab a dead account. Re-check status first — a last-moment sign-in must survive.
async function cleanupDeadLink(connectionId: string): Promise<void> {
  try {
    const { status } = await api.getConnectionStatus(connectionId);
    if (status !== "active") await api.deleteConnection(connectionId);
  } catch {
    // Best-effort — worst case an inert row stays listed.
  }
}

async function runConnect(linkFn: LinkFn): Promise<ConnectOutcome> {
  // Open first, navigate later — window.open after an await gets blocked.
  const popup = window.open("about:blank", "orchestr-connect", "popup,width=500,height=700");
  if (!popup) {
    return { ok: false, reason: "blocked" };
  }

  let link: { connection_id: string; redirect_url: string };
  try {
    link = await linkFn();
  } catch (e) {
    popup.close();
    return { ok: false, reason: "start-failed", message: e instanceof Error ? e.message : undefined };
  }

  popup.location.href = link.redirect_url;
  popup.focus();

  const deadline = Date.now() + TIMEOUT_MS;
  let pollErrors = 0;
  let closedPolls = 0;
  for (;;) {
    await sleep(POLL_MS);
    let status: api.ConnectionLinkStatus | null = null;
    try {
      status = (await api.getConnectionStatus(link.connection_id)).status;
      pollErrors = 0;
    } catch (e) {
      pollErrors += 1;
      if (pollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        return { ok: false, reason: "lost", message: e instanceof Error ? e.message : undefined };
      }
    }
    if (status === "active") {
      popup.close();
      return { ok: true, connectionId: link.connection_id };
    }
    if (status === "failed") {
      popup.close();
      await cleanupDeadLink(link.connection_id);
      return { ok: false, reason: "failed" };
    }
    if (popup.closed) {
      closedPolls += 1;
      if (closedPolls > CLOSED_GRACE_POLLS) {
        await cleanupDeadLink(link.connection_id);
        return { ok: false, reason: "cancelled" };
      }
    }
    if (Date.now() > deadline) {
      popup.close();
      await cleanupDeadLink(link.connection_id);
      return { ok: false, reason: "timeout" };
    }
  }
}

/** connectManagedApp + the ONE set of outcome toasts; returns the connection id, or null (already toasted). */
/** `Authorized against orchestr (T0BFMNPDEQ2)` — the pair someone can compare with the provider. */
function describeAccount(account: { name: string | null; id: string | null }): string {
  const named = account.name ?? account.id ?? "an unnamed account";
  const suffix = account.name && account.id ? ` (${account.id})` : "";
  return `Authorized against ${named}${suffix}.`;
}

export async function connectAppWithFeedback(
  app: string,
  appName: string,
  /** Override the link creator — e.g. an org env-cluster connect instead of a personal one. */
  linkFn?: LinkFn,
): Promise<string | null> {
  const { toast } = await import("@/lib/toast");
  const outcome = await connectManagedApp(app, linkFn);
  if (outcome.ok) {
    // Say WHICH account was just linked: a connection authorized against the wrong workspace is
    // healthy in every other respect, and this is the moment that mistake is cheapest to catch.
    const named = await api
      .connectionAccount(outcome.connectionId, true)
      .catch(() => null);
    toast.success(`Connected ${appName}`, named?.account ? describeAccount(named.account) : undefined);
    return outcome.connectionId;
  }
  switch (outcome.reason) {
    case "blocked":
      toast.error("Sign-in popup was blocked", "Allow popups for this site, then try Connect again.");
      break;
    case "busy":
      toast.info("Another sign-in is in progress", "Finish (or close) that window first.");
      break;
    case "start-failed":
      toast.error(`Couldn't start connecting ${appName}`, outcome.message);
      break;
    case "failed":
      toast.error(`${appName} didn't connect`, "The sign-in didn't complete. Try again.");
      break;
    case "cancelled":
      toast.info("Sign-in window closed", `No ${appName} connection was added.`);
      break;
    case "timeout":
      toast.error(`${appName} sign-in timed out`, "The sign-in window sat open for over 3 minutes. Try again.");
      break;
    case "lost":
      toast.error(`Lost track of the ${appName} sign-in`, outcome.message ?? "Check your connection and try again.");
      break;
  }
  return null;
}
