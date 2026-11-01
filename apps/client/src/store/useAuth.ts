"use client";

import { create } from "zustand";
import * as api from "@/api/client";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

// Clerk owns the session lifecycle; this store holds only the backend-side profile (the local user row).
interface AuthState {
  user: AuthUser | null;
  isProfileLoading: boolean;

  loadMe: () => Promise<void>;
  clearProfile: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  isProfileLoading: false,

  loadMe: async () => {
    set({ isProfileLoading: true });
    try {
      const result = await api.authMe();
      set({ user: result.user, isProfileLoading: false });
    } catch {
      // A failure never erases a profile another load already set.
      set({ isProfileLoading: false });
    }
  },

  clearProfile: () => {
    set({ user: null, isProfileLoading: false });
  },
}));