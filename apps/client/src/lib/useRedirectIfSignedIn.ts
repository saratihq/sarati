"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";

/**
 * Where to land after auth resolves: the middleware's `redirect_url` when same-origin, else the
 * dashboard — this is what lets a deep link (e.g. /join/{token}) survive a login bounce.
 * Read from window, not useSearchParams, to avoid the Suspense requirement.
 */
export function safeReturnTo(): string {
  if (typeof window === "undefined") return "/";
  const raw = new URLSearchParams(window.location.search).get("redirect_url");
  // Same-origin paths only — "//host" and absolute URLs would be open redirects.
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
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
