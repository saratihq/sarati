"use client";

import { create } from "zustand";
import * as api from "@/api/client";

interface NodeIconsState {
  icons: Record<string, string>;
  pending: Set<string>;
  fetchIcons: (nodeTypes: string[]) => Promise<void>;
}

export const useNodeIcons = create<NodeIconsState>((set, get) => ({
  icons: {},
  pending: new Set(),

  fetchIcons: async (nodeTypes: string[]) => {
    const { icons, pending } = get();

    const needed = nodeTypes.filter((t) => !(t in icons) && !pending.has(t));
    if (needed.length === 0) return;

    const newPending = new Set(pending);
    needed.forEach((t) => newPending.add(t));
    set({ pending: newPending });

    try {
      const result = await api.getNodeIconsBatch(needed);
      set((s) => {
        const updated = { ...s.icons };
        const clearedPending = new Set(s.pending);
        for (const [nodeType, svg] of Object.entries(result)) {
          if (svg) {
            updated[nodeType] = svg;
          }
          clearedPending.delete(nodeType);
        }
        return { icons: updated, pending: clearedPending };
      });
    } catch {
      // Clear pending on failure so they can be retried.
      set((s) => {
        const clearedPending = new Set(s.pending);
        needed.forEach((t) => clearedPending.delete(t));
        return { pending: clearedPending };
      });
    }
  },
}));