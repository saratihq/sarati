"use client";

import { create } from "zustand";
import * as api from "@/api/client";
import type { WaitingRun } from "@/api/client";

// Waits for a person (approvals inbox), one per parked step, shared by the header badge and the /approvals page so
// an optimistic removal decrements the badge at once. Both poll fetchWaiting; concurrent calls are deduped here.
interface ApprovalsState {
  /** null = never loaded (skeleton); [] = loaded and empty. */
  waiting: WaitingRun[] | null;
  isLoading: boolean;
  /** Set only while there is nothing to show — a poll failure over a good list degrades quietly. */
  error: string | null;

  fetchWaiting: () => Promise<void>;
  /** Optimistic removal on a sent decision; also shields the wait from poll re-adds until it settles. */
  remove: (wait: WaitingRun) => void;
  /** Rollback (undo, or a failed decision) — the wait is still parked server-side. */
  restore: (wait: WaitingRun) => void;
  /** The decision reached the server — drop the poll shield. */
  settle: (wait: WaitingRun) => void;
}

/** One wait's identity: a run parked on several steps is several entries. */
export function waitKeyOf(wait: WaitingRun): string {
  return `${wait.id}\u0000${wait.step_key}`;
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
        waiting: runs.filter((r) => !suppressed.has(waitKeyOf(r))).sort(byWaitingSince),
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

  // Keyed per wait: the UNIQUE run id (never run_id, which collides across users) plus the step.
  remove: (wait) => {
    const key = waitKeyOf(wait);
    suppressed.add(key);
    set((s) => ({ waiting: (s.waiting ?? []).filter((r) => waitKeyOf(r) !== key) }));
  },

  restore: (wait) => {
    const key = waitKeyOf(wait);
    suppressed.delete(key);
    set((s) => {
      const rest = (s.waiting ?? []).filter((r) => waitKeyOf(r) !== key);
      return { waiting: [...rest, wait].sort(byWaitingSince) };
    });
  },

  settle: (wait) => {
    suppressed.delete(waitKeyOf(wait));
  },
}));
