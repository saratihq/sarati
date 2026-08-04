import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCAL_SESSION_COOKIE,
  clearLocalSession,
  localSessionUserId,
  readLocalSession,
  writeLocalSession,
} from "@/lib/localSession";

// The written cookie string carries Max-Age / Secure, which `document.cookie` never reads back —
// so record every write while still letting jsdom's own jar apply it.
let written: string[];
const cookieDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(document), "cookie");

beforeEach(() => {
  written = [];
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => cookieDescriptor?.get?.call(document) as string,
    set: (value: string) => {
      written.push(value);
      cookieDescriptor?.set?.call(document, value);
    },
  });
});

afterEach(() => {
  delete (document as Partial<Document>).cookie;
});

/** A JWT-shaped token whose payload is `claims` — only the middle segment is ever read. */
function fakeJwt(claims: unknown): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `header.${payload}.signature`;
}

describe("localSession: the cookie", () => {
  it("is the name the Next middleware gates on — renaming it signs everyone out", () => {
    expect(LOCAL_SESSION_COOKIE).toBe("orchestr_local_session");
  });

  it("round-trips a token, URL-encoding the characters a cookie cannot carry", () => {
    writeLocalSession("a/b+c=d", new Date(Date.now() + 3_600_000).toISOString());
    expect(written[0]).toContain(`${LOCAL_SESSION_COOKIE}=a%2Fb%2Bc%3Dd`);
    expect(readLocalSession()).toBe("a/b+c=d");
  });

  it("is scoped to the whole site and same-site", () => {
    writeLocalSession("tok", new Date(Date.now() + 3_600_000).toISOString());
    expect(written[0]).toContain("Path=/");
    expect(written[0]).toContain("SameSite=Lax");
  });

  it("expires with the grant, so no sweeper is needed", () => {
    writeLocalSession("tok", new Date(Date.now() + 3_600_000).toISOString());
    const maxAge = Number(/Max-Age=(\d+)/.exec(written[0])?.[1]);
    expect(maxAge).toBeGreaterThan(3_500);
    expect(maxAge).toBeLessThanOrEqual(3_600);
  });

  it.each([
    { label: "an unparseable expiry", expiresAt: "whenever" },
    { label: "an already-past expiry", expiresAt: new Date(Date.now() - 1_000).toISOString() },
  ])("degrades to a browser-session cookie on $label", ({ expiresAt }) => {
    writeLocalSession("tok", expiresAt);
    expect(written[0]).not.toContain("Max-Age");
  });

  it("omits Secure over plain http, so a LAN self-host still signs in", () => {
    writeLocalSession("tok", new Date(Date.now() + 60_000).toISOString());
    expect(written[0]).not.toContain("Secure");
  });

  it("reads null when there is no session", () => {
    expect(readLocalSession()).toBeNull();
  });

  it("does not match a cookie whose name merely ENDS with the session name", () => {
    document.cookie = `not_${LOCAL_SESSION_COOKIE}=impostor; Path=/`;
    expect(readLocalSession()).toBeNull();
  });

  it("reads the session even when another cookie precedes it", () => {
    document.cookie = "theme=dark; Path=/";
    writeLocalSession("tok", new Date(Date.now() + 60_000).toISOString());
    expect(readLocalSession()).toBe("tok");
  });

  it("clears by expiring the cookie in place", () => {
    writeLocalSession("tok", new Date(Date.now() + 60_000).toISOString());
    clearLocalSession();
    expect(written.at(-1)).toContain("Max-Age=0");
    expect(readLocalSession()).toBeNull();
  });
});

describe("localSession: the user id read off the token", () => {
  it("returns the `sub` claim", () => {
    writeLocalSession(fakeJwt({ sub: "user_123", email: "a@b.c" }), new Date(Date.now() + 60_000).toISOString());
    expect(localSessionUserId()).toBe("user_123");
  });

  it("decodes a base64url payload that needs re-padding", () => {
    // A claim length chosen so the base64 encoding is padded — the naive atob would throw.
    writeLocalSession(fakeJwt({ sub: "u1" }), new Date(Date.now() + 60_000).toISOString());
    expect(localSessionUserId()).toBe("u1");
  });

  it("returns null when there is no session at all", () => {
    expect(localSessionUserId()).toBeNull();
  });

  it.each([
    { label: "a non-JWT token", token: "opaque-token" },
    { label: "an undecodable payload", token: "header.!!!not-base64!!!.sig" },
    { label: "a payload that is not JSON", token: `header.${btoa("plain text")}.sig` },
    { label: "a payload with no sub", token: fakeJwt({ email: "a@b.c" }) },
    { label: "a non-string sub", token: fakeJwt({ sub: 42 }) },
  ])("returns null rather than throwing on $label", ({ token }) => {
    writeLocalSession(token, new Date(Date.now() + 60_000).toISOString());
    expect(localSessionUserId()).toBeNull();
  });
});
