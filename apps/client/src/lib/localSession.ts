// The local email+password session. A COOKIE, not localStorage: the Next middleware runs
// on the server and must see it to gate routes, and Max-Age expires the token without any sweeper.
export const LOCAL_SESSION_COOKIE = "orchestr_local_session";

/** The stored local session token, or null when this instance signs in another way. */
export function readLocalSession(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${LOCAL_SESSION_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Persist a session grant; an unparseable `expiresAt` degrades to a browser-session cookie. */
export function writeLocalSession(token: string, expiresAt: string): void {
  if (typeof document === "undefined") return;
  const ttl = Math.floor((Date.parse(expiresAt) - Date.now()) / 1000);
  const age = Number.isFinite(ttl) && ttl > 0 ? `; Max-Age=${ttl}` : "";
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LOCAL_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Lax${age}${secure}`;
}

export function clearLocalSession(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${LOCAL_SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/** The signed-in user id, read (not trusted) off the session token — the service verifies every call. */
export function localSessionUserId(): string | null {
  const token = readLocalSession();
  if (!token) return null;
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload: unknown = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    const sub = (payload as { sub?: unknown }).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}
