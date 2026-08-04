"use client";

import { useAuth } from "@clerk/nextjs";
import { localSessionUserId } from "@/lib/localSession";

/** The signed-in user id for per-user client storage (drafts): the local session's, else Clerk's. */
export function useSessionUserId(): string | null {
  const { userId } = useAuth();
  return localSessionUserId() ?? userId ?? null;
}
