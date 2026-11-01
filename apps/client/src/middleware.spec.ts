import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest, type NextFetchEvent } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://app.sarati.test";

async function loginRedirectFor(path: string): Promise<URL> {
  const { default: middleware } = await import("@/middleware");
  const res = await middleware(new NextRequest(`${ORIGIN}${path}`), {} as NextFetchEvent);
  const location = res?.headers.get("location");
  if (!location) throw new Error(`no redirect for ${path}`);
  return new URL(location);
}

describe("middleware: the sign-in bounce", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
  });

  it("carries a deep link to /login as redirect_url", async () => {
    const to = await loginRedirectFor("/workflows/42/overview?branch=feat%2Fx");
    expect(to.origin + to.pathname).toBe(`${ORIGIN}/login`);
    expect(to.searchParams.get("redirect_url")).toBe("/workflows/42/overview?branch=feat%2Fx");
  });

  it("carries no redirect_url for the dashboard", async () => {
    const to = await loginRedirectFor("/");
    expect(to.searchParams.has("redirect_url")).toBe(false);
  });

  it.each(["//evil.com", "//evil.com/join/abc", "/.//evil.com"])(
    "never echoes a path that would leave the origin: %s",
    async (path) => {
      const to = await loginRedirectFor(path);
      expect(to.origin + to.pathname).toBe(`${ORIGIN}/login`);
      const returnTo = to.searchParams.get("redirect_url");
      if (returnTo !== null) expect(new URL(returnTo, ORIGIN).origin).toBe(ORIGIN);
    },
  );
});

describe("middleware: the vendored fonts", () => {
  async function runsOn(url: string): Promise<boolean> {
    const { config } = await import("@/middleware");
    return unstable_doesMiddlewareMatch({ config, url });
  }

  it.each(["/fonts", "/fonts/", "/fonts/inter/v20", "/fonts/inter/v20/OFL.txt", "/fonts/inter/v20/latin.woff2"])(
    "never answers %s, which is cached immutable, with a sign-in redirect",
    async (url) => {
      expect(await runsOn(url)).toBe(false);
    },
  );

  it.each(["/fontsx", "/fonts-admin", "/workflows/42/overview", "/"])("still gates %s", async (url) => {
    expect(await runsOn(url)).toBe(true);
  });
});
