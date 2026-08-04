import { afterEach, describe, expect, it, vi } from "vitest";

// `@/lib/config` resolves everything at MODULE LOAD, so every case re-imports it under fresh env.
async function loadConfig(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  return import("@/lib/config");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("config: public URL resolution", () => {
  it("resolves the dev fallbacks when the vars are unset outside production", async () => {
    const config = await loadConfig({
      NODE_ENV: "development",
      NEXT_PUBLIC_API_URL: undefined,
      NEXT_PUBLIC_AGENT_URL: undefined,
    });
    expect(config.apiBaseUrl).toBe("http://localhost:8001");
    expect(config.agentBaseUrl).toBe("http://localhost:8010");
  });

  it("keeps an explicit origin and strips its trailing slashes", async () => {
    const config = await loadConfig({
      NODE_ENV: "development",
      NEXT_PUBLIC_API_URL: "https://api.example.com///",
      NEXT_PUBLIC_AGENT_URL: "https://agent.example.com/",
    });
    expect(config.apiBaseUrl).toBe("https://api.example.com");
    expect(config.agentBaseUrl).toBe("https://agent.example.com");
  });

  it("trims surrounding whitespace before deciding", async () => {
    const config = await loadConfig({
      NODE_ENV: "development",
      NEXT_PUBLIC_API_URL: "  https://api.example.com  ",
      NEXT_PUBLIC_AGENT_URL: "  same-origin  ",
    });
    expect(config.apiBaseUrl).toBe("https://api.example.com");
    expect(config.agentBaseUrl).toBe("");
  });
});

describe("config: the `same-origin` sentinel", () => {
  it("resolves to the empty string so callers build RELATIVE URLs", async () => {
    const config = await loadConfig({
      NODE_ENV: "development",
      NEXT_PUBLIC_API_URL: "same-origin",
      NEXT_PUBLIC_AGENT_URL: "same-origin",
    });
    expect(config.apiBaseUrl).toBe("");
    expect(config.agentBaseUrl).toBe("");
  });

  // The published Docker image cannot bake in an absolute host — the sentinel is its ONLY way
  // through the production fail-loud gate below.
  it("satisfies the production gate — a same-origin production build must not throw", async () => {
    const config = await loadConfig({
      NODE_ENV: "production",
      NEXT_PUBLIC_API_URL: "same-origin",
      NEXT_PUBLIC_AGENT_URL: "same-origin",
    });
    expect(config.apiBaseUrl).toBe("");
    expect(config.agentBaseUrl).toBe("");
  });

  it("is spelled, never inferred — an empty or whitespace-only var still fails a production build", async () => {
    await expect(
      loadConfig({
        NODE_ENV: "production",
        NEXT_PUBLIC_API_URL: "   ",
        NEXT_PUBLIC_AGENT_URL: "same-origin",
      }),
    ).rejects.toThrow(/NEXT_PUBLIC_API_URL/);
  });
});

describe("config: the production fail-loud throw", () => {
  it("refuses to ship the dev fallback when NEXT_PUBLIC_API_URL is unset", async () => {
    const load = loadConfig({
      NODE_ENV: "production",
      NEXT_PUBLIC_API_URL: undefined,
      NEXT_PUBLIC_AGENT_URL: "https://agent.example.com",
    });
    await expect(load).rejects.toThrow(/NEXT_PUBLIC_API_URL/);
    // The message must name the fallback it refused to inline, or the incident repeats.
    await expect(load).rejects.toThrow(/http:\/\/localhost:8001/);
  });

  it("refuses an unset NEXT_PUBLIC_AGENT_URL too", async () => {
    await expect(
      loadConfig({
        NODE_ENV: "production",
        NEXT_PUBLIC_API_URL: "https://api.example.com",
        NEXT_PUBLIC_AGENT_URL: undefined,
      }),
    ).rejects.toThrow(/NEXT_PUBLIC_AGENT_URL/);
  });

  it("stays silent outside production — dev must not need the vars", async () => {
    const config = await loadConfig({
      NODE_ENV: "test",
      NEXT_PUBLIC_API_URL: undefined,
      NEXT_PUBLIC_AGENT_URL: undefined,
    });
    expect(config.apiBaseUrl).toBe("http://localhost:8001");
  });
});

describe("config: the Clerk publishable key", () => {
  it("is OPTIONAL — a self-host production build with no key must not throw", async () => {
    const config = await loadConfig({
      NODE_ENV: "production",
      NEXT_PUBLIC_API_URL: "https://api.example.com",
      NEXT_PUBLIC_AGENT_URL: "https://agent.example.com",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: undefined,
    });
    expect(config.clerkPublishableKey).toBe("");
    expect(config.clerkEnabled).toBe(false);
  });

  it("enables the Clerk flows only when a non-blank key is present", async () => {
    const blank = await loadConfig({
      NODE_ENV: "development",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "   ",
    });
    expect(blank.clerkEnabled).toBe(false);

    const set = await loadConfig({
      NODE_ENV: "development",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "  pk_test_abc  ",
    });
    expect(set.clerkPublishableKey).toBe("pk_test_abc");
    expect(set.clerkEnabled).toBe(true);
  });
});
