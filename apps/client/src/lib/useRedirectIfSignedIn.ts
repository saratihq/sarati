"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { safeReturnTo } from "@/lib/returnTo";

/**
 * Bounce a still-signed-in user off /login and /signup, where Clerk throws rather than start a fresh
 * flow. Returns true once the redirect is in flight, so the caller can skip rendering the form.
 */
export function useRedirectIfSignedIn(): boolean {
  const { isLoaded, isSignedIn } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoaded && isSignedIn) router.replace(safeReturnTo());
  }, [isLoaded, isSignedIn, router]);

  return Boolean(isLoaded && isSignedIn);
}
