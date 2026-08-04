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
  isLoading: boolean;
  /** Mirror of the persisted selection. null = personal (no X-Org-Id sent). */
  activeOrgId: string | null;

  fetchOrgs: (opts?: { force?: boolean }) => Promise<void>;
  switchOrg: (id: string) => void;
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

/**
 * Env-pointer moves (publish/promote/restore) are owner/admin-only in a non-personal org (ADR 0032).
 * Returns true while the org list loads — the service stays the backstop, so nobody is falsely locked out.
 */
export function canMoveEnvPointers(s: Pick<OrgState, "orgs" | "activeOrgId">): boolean {
  const org = activeOrgOf(s);
  if (!org || org.is_personal) return true;
  return org.role === "owner" || org.role === "admin";
}

/** Tooltip copy for a pointer-move control disabled by the gate above. */
export const ENV_POINTER_GATE = {
  publish: "Only owners and admins can publish to production",
  promote: "Only owners and admins can change what an environment runs",
} as const;

export const useOrgs = create<OrgState>((set, get) => ({
  orgs: [],
  loaded: false,
  isLoading: false,
  activeOrgId: api.getActiveOrgId(),

  fetchOrgs: async (opts) => {
    const { loaded, isLoading } = get();
    if (isLoading || (loaded && !opts?.force)) return;
    set({ isLoading: true });
    try {
      const { orgs } = await api.listOrgs();
      // Self-heal a stale selection, or every request 403s forever.
      let active = api.getActiveOrgId();
      if (active && !orgs.some((o) => o.id === active)) {
        api.setActiveOrgId(null);
        active = null;
      }
      set({ orgs, loaded: true, isLoading: false, activeOrgId: active });
    } catch (e) {
      // A stale X-Org-Id can 403 even this call — clear it and retry once.
      if (e instanceof api.ApiError && e.status === 403 && api.getActiveOrgId()) {
        api.setActiveOrgId(null);
        set({ isLoading: false, activeOrgId: null });
        return get().fetchOrgs(opts);
      }
      // Anything else: degrade quietly — the switcher just won't list orgs.
      set({ isLoading: false });
    }
  },

  switchOrg: (id: string) => {
    const target = get().orgs.find((o) => o.id === id);
    // Personal is the server-side fallback — store null so the header is only sent for real orgs.
    api.setActiveOrgId(target?.is_personal ? null : id);
    window.location.assign("/"); // hard reload: see the note on the interface
  },

  createAndSwitch: async (name: string) => {
    const org = await api.createOrg(name);
    api.setActiveOrgId(org.id);
    window.location.assign("/"); // hard reload: see the note on the interface
  },
}));
