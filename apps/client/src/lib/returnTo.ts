const UNSAFE_CHARS = /[\\\u0000-\u001f\u007f]/;

const isRootedPath = (value: string) => value.startsWith("/") && !value.startsWith("//");

/** `raw` as a path on `origin`, or null when following it could land anywhere else. */
export function sameOriginPath(raw: string | null | undefined, origin: string): string | null {
  if (!raw || !isRootedPath(raw) || UNSAFE_CHARS.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  const path = url.pathname + url.search + url.hash;
  return url.origin === origin && isRootedPath(path) ? path : null;
}

/** Where to land after sign-in: `raw` (by default the `redirect_url` query parameter) when it stays on this origin, else the dashboard. */
export function safeReturnTo(
  raw: string | null = typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("redirect_url"),
): string {
  if (typeof window === "undefined") return "/";
  return sameOriginPath(raw, window.location.origin) ?? "/";
}
