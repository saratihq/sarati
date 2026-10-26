"use client";

import { create } from "zustand";

/** A signed-in session the service can't open an account for: one an existing account's email holds, or one refused. */
export interface AccountProblem {
  code: "account_link_required" | "provisioning_failed";
  detail: string;
  /** The address the existing account uses; set on `account_link_required`. */
  email?: string;
}

interface AccountProblemState {
  problem: AccountProblem | null;
  report: (problem: AccountProblem) => void;
  clear: () => void;
}

export const useAccountProblem = create<AccountProblemState>((set) => ({
  problem: null,
  report: (problem) => set({ problem }),
  clear: () => set({ problem: null }),
}));
