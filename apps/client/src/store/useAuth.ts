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
      // 401s redirect globally in the api client; anything else leaves the profile empty, not blocked.
      set({ user: null, isProfileLoading: false });
    }
  },

  clearProfile: () => {
    set({ user: null, isProfileLoading: false });
  },
}));