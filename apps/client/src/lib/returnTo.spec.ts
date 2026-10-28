import { afterEach, describe, expect, it } from "vitest";
import { safeReturnTo, sameOriginPath } from "@/lib/returnTo";

const ORIGIN = "https://app.sarati.test";

const ATTACKS: Array<[string, string]> = [
  ["a backslash the URL parser reads as a slash", "/\\evil.com"],
  ["a backslash after the slash", "/\\/evil.com"],
  ["a protocol-relative URL", "//evil.com"],
  ["a protocol-relative URL with a trailing path", "//evil.com/join/abc"],
  ["a tab the URL parser strips", "/\t/evil.com"],
  ["a newline the URL parser strips", "/\n/evil.com"],
  ["a carriage return the URL parser strips", "/\r/evil.com"],
  ["a NUL", "/\u0000/evil.com"],
  ["a DEL", "/\u007f/evil.com"],
  ["an absolute https URL", "https://evil.com/"],
  ["a scheme with no slashes", "https:evil.com"],
  ["a scheme with one slash", "http:/evil.com"],
  ["a javascript: URL", "javascript:alert(document.cookie)"],
  ["a mixed-case javascript: URL", "JaVaScRiPt:alert(1)"],
  ["a data: URL", "data:text/html,<script>alert(1)</script>"],
  ["a bare host", "evil.com"],
  ["a leading space", " /settings"],
  ["a UNC-style double backslash", "\\\\evil.com"],
  ["a dot segment that collapses to //", "/.//evil.com"],
  ["a parent segment that collapses to //", "/..//evil.com"],
  ["an encoded parent segment that collapses to //", "/%2e%2e//evil.com"],
];

const LEGIT: Array<[string, string]> = [
  ["/", "/"],
  ["/settings", "/settings"],
  ["/join/abc123", "/join/abc123"],
  ["/integrations?picker=0", "/integrations?picker=0"],
  ["/workflows/42/overview?branch=feat%2Fx#node-3", "/workflows/42/overview?branch=feat%2Fx#node-3"],
  ["/%5Cevil.com", "/%5Cevil.com"],
  ["/a/../settings", "/settings"],
  ["/./workflows/42", "/workflows/42"],
];

describe("sameOriginPath", () => {
  it.each(ATTACKS)("refuses %s", (_label, raw) => {
    expect(sameOriginPath(raw, ORIGIN)).toBeNull();
  });

  it.each(LEGIT)("keeps %s", (raw, expected) => {
    expect(sameOriginPath(raw, ORIGIN)).toBe(expected);
  });

  it.each([null, undefined, ""])("refuses %j", (raw) => {
    expect(sameOriginPath(raw, ORIGIN)).toBeNull();
  });

  it("refuses everything when the origin cannot be parsed against", () => {
    expect(sameOriginPath("/settings", "null")).toBeNull();
  });

  it.each([...ATTACKS.map(([, raw]) => raw), ...LEGIT.map(([raw]) => raw)])(
    "only ever yields a path that resolves to the app origin: %j",
    (raw) => {
      const path = sameOriginPath(raw, ORIGIN);
      if (path === null) return;
      expect(path).toMatch(/^\/(?![/\\])/);
      expect(path).not.toMatch(/[\\\u0000-\u001f\u007f]/);
      expect(new URL(path, ORIGIN).origin).toBe(ORIGIN);
      expect(new URL(path, "http://other.test:8080").origin).toBe("http://other.test:8080");
    },
  );
});

describe("safeReturnTo", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  const landsOn = (query: string) => {
    window.history.replaceState(null, "", `/login${query}`);
    return safeReturnTo();
  };

  it.each([
    "?redirect_url=/%5Cevil.com",
    "?redirect_url=%2F%5Cevil.com",
    "?redirect_url=//evil.com",
    "?redirect_url=%2F%2Fevil.com",
    "?redirect_url=/%09/evil.com",
    "?redirect_url=/%0A/evil.com",
    "?redirect_url=https://evil.com",
    "?redirect_url=https:evil.com",
    "?redirect_url=javascript:alert(1)",
    "?redirect_url=/.//evil.com",
    "?redirect_url=/%252e%252e//evil.com",
  ])("sends %s to the dashboard", (query) => {
    expect(landsOn(query)).toBe("/");
  });

  it("returns a same-origin deep link with its query and fragment", () => {
    expect(landsOn("?redirect_url=%2Fworkflows%2F42%2Foverview%3Fbranch%3Dfeat%252Fx%23node-3")).toBe(
      "/workflows/42/overview?branch=feat%2Fx#node-3",
    );
  });

  it("returns an invite link so a join survives the sign-in bounce", () => {
    expect(landsOn("?redirect_url=/join/abc123")).toBe("/join/abc123");
  });

  it("falls back to the dashboard with no redirect_url", () => {
    expect(landsOn("")).toBe("/");
  });

  it("checks a path it is handed the same way, and an explicit null returns nowhere", () => {
    window.history.replaceState(null, "", "/login?redirect_url=%2Fworkflows%2F42");
    expect(safeReturnTo("/join/abc123")).toBe("/join/abc123");
    expect(safeReturnTo("/\\evil.com")).toBe("/");
    expect(safeReturnTo("/.//evil.com")).toBe("/");
    expect(safeReturnTo(null)).toBe("/");
  });
});
