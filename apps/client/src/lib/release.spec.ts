import { describe, expect, it } from "vitest";
import { hasUnpublishedVersion, type ReleaseState } from "@/lib/release";

const release = (over: Partial<ReleaseState>): ReleaseState => ({
  live: 1,
  liveId: "v1",
  latest: 1,
  latestId: "v1",
  ...over,
});

describe("hasUnpublishedVersion", () => {
  it("is true for a workflow that has never been published", () => {
    expect(hasUnpublishedVersion(release({ live: null, liveId: null }))).toBe(true);
  });

  it("is false when production runs main's head", () => {
    expect(hasUnpublishedVersion(release({}))).toBe(false);
  });

  it("compares versions by identity, so a higher number elsewhere never hides main's head", () => {
    expect(hasUnpublishedVersion(release({ live: 3, liveId: "feature-v3", latest: 2, latestId: "main-v2" }))).toBe(
      true,
    );
  });

  it("falls back to the numbers when an id is missing", () => {
    expect(hasUnpublishedVersion(release({ live: 1, liveId: null, latest: 2, latestId: null }))).toBe(true);
    expect(hasUnpublishedVersion(release({ live: 2, liveId: null, latest: 2, latestId: null }))).toBe(false);
  });

  it("has nothing to publish before a workflow has any version, or before it has loaded", () => {
    expect(hasUnpublishedVersion(release({ live: null, liveId: null, latest: 0, latestId: null }))).toBe(false);
    expect(hasUnpublishedVersion(null)).toBe(false);
  });
});
