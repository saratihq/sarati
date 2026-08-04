"use client";

import { create } from "zustand";
import * as api from "@/api/client";
import type { WaitingRun } from "@/api/client";

// Waiting runs (approvals inbox), shared by the header badge and the /approvals page so an optimistic
// removal decrements the badge at once. Both poll fetchWaiting; concurrent calls are deduped here.
interface ApprovalsState {
  /** null = never loaded (skeleton); [] = loaded and empty. */
  waiting: WaitingRun[] | null;
  isLoading: boolean;
  /** Set only while there is nothing to show — a poll failure over a good list degrades quietly. */
  error: string | null;

  fetchWaiting: () => Promise<void>;
  /** Optimistic removal on a sent decision; also shields the run from poll re-adds until it settles. */
  remove: (runId: string) => void;
  /** Rollback (undo, or a failed decision) — the run is still waiting server-side. */
  restore: (run: WaitingRun) => void;
  /** The decision reached the server — drop the poll shield. */
  settle: (runId: string) => void;
}

function byWaitingSince(a: WaitingRun, b: WaitingRun): number {
  return (a.waiting_since ?? "").localeCompare(b.waiting_since ?? "");
}

// Removed optimistically but not yet settled — filtered from every fetch so a poll can't resurrect them.
const suppressed = new Set<string>();

export const useApprovals = create<ApprovalsState>((set, get) => ({
  waiting: null,
  isLoading: false,
  error: null,

  fetchWaiting: async () => {
    if (get().isLoading) return;
    set({ isLoading: true });
    try {
      const { runs } = await api.listWaitingRuns();
      set({
        waiting: runs.filter((r) => !suppressed.has(r.id)).sort(byWaitingSince),
        isLoading: false,
        error: null,
      });
    } catch (e) {
      // Keep the last list on a poll failure — a stale inbox beats a flickering one, so the
      // error surfaces only when there is nothing to keep.
      const message = e instanceof Error ? e.message : "Couldn't load approvals";
      set((s) => ({ isLoading: false, error: s.waiting === null ? message : s.error }));
    }
  },

  // Keyed on the UNIQUE run id, NOT run_id, which can collide across users in an org-wide list.
  remove: (id) => {
    suppressed.add(id);
    set((s) => ({ waiting: (s.waiting ?? []).filter((r) => r.id !== id) }));
  },

  restore: (run) => {
    suppressed.delete(run.id);
    set((s) => {
      const rest = (s.waiting ?? []).filter((r) => r.id !== run.id);
      return { waiting: [...rest, run].sort(byWaitingSince) };
    });
  },

  settle: (id) => {
    suppressed.delete(id);
  },
}));
