"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

/**
 * Where to land after auth resolves: `raw` (default: the middleware's `redirect_url`) when it is a
 * path on this origin, else the dashboard — this is what lets a deep link survive a login bounce.
 */
export function safeReturnTo(
  raw: string | null = typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("redirect_url"),
): string {
  if (typeof window === "undefined" || !raw?.startsWith("/")) return "/";
  try {
    const url = new URL(raw, window.location.origin);
    // A same-origin URL can still normalise to a "//host" path, which the router reads as another origin.
    const local = url.origin === window.location.origin && !url.pathname.startsWith("//");
    return local ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}

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
