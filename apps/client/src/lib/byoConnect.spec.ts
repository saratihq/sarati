import { describe, expect, it, vi } from "vitest";
import type { AuthScheme, NodeTypeEntry } from "@/api/client";
import { loadByoApps, shapeDirectCredential } from "@/lib/byoConnect";

const { listNodeTypes } = vi.hoisted(() => ({ listNodeTypes: vi.fn() }));
vi.mock("@/api/client", () => ({ listNodeTypes }));

const apiKey: AuthScheme = { type: "apiKey", in: "header", name: "Authorization", prefix: "Bearer" };

/** Must match the service's `toDirectCredential`, or a stored credential is unreadable at run time. */
describe("shapeDirectCredential", () => {
  it.each([apiKey, { type: "custom" } as AuthScheme])("wraps a pasted key as { value } for $type", (scheme) => {
    expect(shapeDirectCredential(scheme, { token: "sk-123" })).toEqual({ value: "sk-123" });
  });

  it("trims the pasted key — a copied newline must not be stored", () => {
    expect(shapeDirectCredential(apiKey, { token: "  sk-123\n" })).toEqual({ value: "sk-123" });
  });

  it.each([
    { label: "no token", fields: {} },
    { label: "a blank token", fields: { token: "   " } },
    { label: "an empty token", fields: { token: "" } },
  ])("refuses to store $label", ({ fields }) => {
    expect(shapeDirectCredential(apiKey, fields)).toBeNull();
  });

  it("shapes basic auth as { username, password }", () => {
    expect(shapeDirectCredential({ type: "basic" }, { username: " ada ", password: " s3cret " })).toEqual({
      username: "ada",
      // The password is NOT trimmed — leading/trailing spaces can be part of it.
      password: " s3cret ",
    });
  });

  it.each([
    { label: "no username", fields: { password: "p" } },
    { label: "no password", fields: { username: "ada" } },
    { label: "an empty password", fields: { username: "ada", password: "" } },
  ])("refuses incomplete basic auth with $label", ({ fields }) => {
    expect(shapeDirectCredential({ type: "basic" }, fields)).toBeNull();
  });

  it.each([{ type: "oauth2", scopes: [] } as AuthScheme, { type: "none" } as AuthScheme])(
    "has nothing to shape for $type — those are not pasted credentials",
    (scheme) => {
      expect(shapeDirectCredential(scheme, { token: "sk-123", username: "a", password: "b" })).toBeNull();
    },
  );
});

describe("loadByoApps", () => {
  const entry = (category: string, authScheme?: AuthScheme): NodeTypeEntry => ({
    name: `${category} action`,
    type: `${category}.do`,
    category,
    description: "",
    auth: "connection",
    parameters: {},
    authScheme,
  });

  it("lists one app per slug with a human name", async () => {
    listNodeTypes.mockResolvedValue({ node_types: [entry("slack", apiKey), entry("google-sheets", { type: "basic" })] });
    await expect(loadByoApps()).resolves.toEqual([
      { slug: "google-sheets", name: "Google Sheets", scheme: { type: "basic" } },
      { slug: "slack", name: "Slack", scheme: apiKey },
    ]);
  });

  it("drops rows a user cannot bring their own credential for", async () => {
    listNodeTypes.mockResolvedValue({
      node_types: [entry("composio-app"), entry("public-api", { type: "none" }), entry("slack", apiKey)],
    });
    await expect(loadByoApps()).resolves.toEqual([{ slug: "slack", name: "Slack", scheme: apiKey }]);
  });

  it("keeps the FIRST scheme per slug — catalog rows are per action", async () => {
    listNodeTypes.mockResolvedValue({
      node_types: [entry("slack", apiKey), { ...entry("slack", { type: "basic" }), type: "slack.other" }],
    });
    await expect(loadByoApps()).resolves.toEqual([{ slug: "slack", name: "Slack", scheme: apiKey }]);
  });

  it("asks only for the first-party rail, the only one that publishes auth shapes", async () => {
    listNodeTypes.mockResolvedValue({ node_types: [] });
    await loadByoApps();
    expect(listNodeTypes).toHaveBeenCalledWith("orchestr");
  });
});
