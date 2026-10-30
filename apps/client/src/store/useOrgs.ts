"use client";

import { create } from "zustand";
import * as api from "@/api/client";
import type { OrgSummary } from "@/api/client";

// Organization scope for the whole client; the active selection lives in the api-client module and is
// mirrored here so React can subscribe. Switching orgs is a FULL PAGE RELOAD on purpose — it's the only
// mechanism that atomically drops every org-scoped cache in the app.
interface OrgState {
  orgs: OrgSummary[];
  loaded: boolean;
  /** Mirror of the persisted selection. null = personal (no X-Org-Id sent). */
  activeOrgId: string | null;

  /** Never rejects: resolves when the load ends, waiting for one already in flight; `loaded` turns true on the first load that works and stays true. */
  fetchOrgs: (opts?: { force?: boolean }) => Promise<void>;
  /** `stay` reloads the current address instead of going to the dashboard. */
  switchOrg: (id: string, opts?: { stay?: boolean }) => void;
  createAndSwitch: (name: string) => Promise<void>;
}

/** The org the app is scoped to: the selected one, else personal. */
export function activeOrgOf(s: Pick<OrgState, "orgs" | "activeOrgId">): OrgSummary | null {
  if (s.activeOrgId) {
    const found = s.orgs.find((o) => o.id === s.activeOrgId);
    if (found) return found;
  }
  return s.orgs.find((o) => o.is_personal) ?? null;
}

/** The name a workspace goes by in the app. */
export function orgLabel(o: Pick<OrgSummary, "is_personal" | "name">): string {
  return o.is_personal ? "Personal" : o.name;
}

/**
 * Env-pointer moves (publish/promote/restore), and a branch test under an environment, are owner/admin-only in a
 * non-personal org. Returns true while the org list loads — the service stays the backstop, so nobody is falsely locked out.
 */
export function canMoveEnvPointers(s: Pick<OrgState, "orgs" | "activeOrgId">): boolean {
  const org = activeOrgOf(s);
  if (!org || org.is_personal) return true;
  return org.role === "owner" || org.role === "admin";
}

/** Copy for a control the gate above disables: a pointer move, or a branch test under an environment. */
export const ENV_POINTER_GATE = {
  publish: "Only owners and admins can publish to production",
  promote: "Only owners and admins can change what an environment runs",
  test: "Only owners and admins can test a branch under an environment, the same as promoting to it — test it on Default (your connections).",
} as const;

let pending: Promise<void> | null = null;

async function loadOrgs(set: (partial: Partial<OrgState>) => void): Promise<void> {
  try {
    const { orgs } = await api.listOrgs();
    // Self-heal a stale selection, or every request 403s forever.
    let active = api.getActiveOrgId();
    if (active && !orgs.some((o) => o.id === active)) {
      api.setActiveOrgId(null);
      active = null;
    }
    set({ orgs, loaded: true, activeOrgId: active });
  } catch (e) {
    // A stale X-Org-Id can 403 even this call — clear it and retry once.
    if (e instanceof api.ApiError && e.status === 403 && api.getActiveOrgId()) {
      api.setActiveOrgId(null);
      set({ activeOrgId: null });
      return loadOrgs(set);
    }
    // Anything else: degrade quietly — the switcher just won't list orgs.
  }
}

export const useOrgs = create<OrgState>((set, get) => ({
  orgs: [],
  loaded: false,
  activeOrgId: api.getActiveOrgId(),

  fetchOrgs: (opts) => {
    if (pending) return opts?.force ? pending.then(() => get().fetchOrgs(opts)) : pending;
    if (get().loaded && !opts?.force) return Promise.resolve();
    pending = loadOrgs(set).finally(() => {
      pending = null;
    });
    return pending;
  },

  switchOrg: (id, opts) => {
    const target = get().orgs.find((o) => o.id === id);
    // Personal is the server-side fallback — store null so the header is only sent for real orgs.
    api.setActiveOrgId(target?.is_personal ? null : id);
    // A hard reload either way: see the note on the interface.
    if (opts?.stay) window.location.reload();
    else window.location.assign("/");
  },

  createAndSwitch: async (name: string) => {
    const org = await api.createOrg(name);
    api.setActiveOrgId(org.id);
    window.location.assign("/"); // hard reload: see the note on the interface
  },
}));
