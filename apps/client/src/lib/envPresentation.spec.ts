import { describe, expect, it } from "vitest";
import { getTagColor, isProtectedEnv } from "@/lib/envPresentation";

/** Vault rule (ADR 0016): meaning derives from FLAGS and ids — a name is display only. */
describe("isProtectedEnv", () => {
  it("protects production by its FLAG, whatever it is called", () => {
    expect(isProtectedEnv({ is_prod: true, name: "production" })).toBe(true);
    expect(isProtectedEnv({ is_prod: true, name: "prod" })).toBe(true);
    expect(isProtectedEnv({ is_prod: true, name: "anything-at-all" })).toBe(true);
  });

  it("protects the other predefined environment, uat", () => {
    expect(isProtectedEnv({ is_prod: false, name: "uat" })).toBe(true);
  });

  it("leaves a user-created environment renamable and deletable", () => {
    expect(isProtectedEnv({ is_prod: false, name: "staging" })).toBe(false);
    expect(isProtectedEnv({ is_prod: false, name: "my-sandbox" })).toBe(false);
  });

  it("does NOT protect an environment merely NAMED production without the flag", () => {
    expect(isProtectedEnv({ is_prod: false, name: "production" })).toBe(false);
  });
});

describe("getTagColor", () => {
  it.each(["prod", "production", "uat", "staging", "dev", "latest"])("gives %s its own palette entry", (tag) => {
    const color = getTagColor(tag);
    expect(color.bg).toBeTruthy();
    expect(color.text).toBeTruthy();
    expect(color).not.toEqual(getTagColor("an-unknown-tag"));
  });

  it("covers both spellings of production, since 'prod' is the reserved legacy name", () => {
    expect(getTagColor("prod")).toEqual(getTagColor("production"));
  });

  it("gives an unknown tag a readable fallback rather than nothing", () => {
    const fallback = getTagColor("my-custom-env");
    expect(fallback.bg).toBeTruthy();
    expect(fallback.text).toBeTruthy();
  });

  it("never returns undefined for a tag that could come off the wire", () => {
    for (const tag of ["", "PROD", "Production", "prod ", "🚀"]) {
      expect(getTagColor(tag)).toMatchObject({ bg: expect.any(String), text: expect.any(String) });
    }
  });
});
