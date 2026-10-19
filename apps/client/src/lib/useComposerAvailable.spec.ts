import { describe, expect, it } from "vitest";

import { composerDisabledHint } from "./useComposerAvailable";

describe("composerDisabledHint", () => {
  it("says a rate-limited visitor asked too often, not that a key is missing", () => {
    expect(composerDisabledHint({ available: false, reason: "rate_limited" })).toBe(
      "AI composer: too many requests — try again in a minute",
    );
  });

  it("keeps one hint per other reason", () => {
    expect(composerDisabledHint({ available: false, reason: "anthropic_api_key_missing" })).toBe(
      "AI composer needs an Anthropic API key — add one under Settings",
    );
    expect(composerDisabledHint({ available: false, reason: "caller_auth_unconfigured" })).toBe(
      "AI composer isn't configured on this instance — see docs",
    );
    expect(composerDisabledHint({ available: false, reason: "unreachable" })).toBe(
      "AI composer isn't available on this instance",
    );
  });
});
