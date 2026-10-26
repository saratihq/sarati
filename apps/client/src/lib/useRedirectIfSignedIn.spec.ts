import { afterEach, describe, expect, it } from "vitest";
import { safeReturnTo } from "@/lib/useRedirectIfSignedIn";

afterEach(() => window.history.replaceState(null, "", "/"));

describe("safeReturnTo", () => {
  it.each([
    ["//evil.example/x", "a protocol-relative URL"],
    ["/\\evil.example", "a backslash, which URL parsers treat as a slash"],
    ["/\t/evil.example", "a control character the URL parser drops"],
    ["/.//evil.example", "a dot segment that normalises to a protocol-relative path"],
    ["/%2e//evil.example", "an encoded dot segment"],
    ["/a/..//evil.example", "a parent segment"],
    ["https://evil.example/", "an absolute URL"],
    ["javascript:alert(1)", "a script URL"],
    ["", "nothing"],
  ])("refuses %j (%s) and lands on the dashboard", (raw) => {
    expect(safeReturnTo(raw)).toBe("/");
  });

  it.each([
    ["/%5Cx", "/%5Cx"],
    ["/workflows/a?b=1#c", "/workflows/a?b=1#c"],
    ["/join/tok_123", "/join/tok_123"],
  ])("keeps the same-origin path %j", (raw, expected) => {
    expect(safeReturnTo(raw)).toBe(expected);
  });

  it("reads the middleware's redirect_url by default, decoded, and still refuses the open redirect it carries", () => {
    window.history.replaceState(null, "", "/login?redirect_url=%2F%5Cevil.example");
    expect(safeReturnTo()).toBe("/");
    window.history.replaceState(null, "", "/login?redirect_url=%2Fworkflows%2Fw1");
    expect(safeReturnTo()).toBe("/workflows/w1");
  });

  it("treats an explicit null as nothing to return to", () => {
    window.history.replaceState(null, "", "/login?redirect_url=%2Fworkflows%2Fw1");
    expect(safeReturnTo(null)).toBe("/");
  });
});
