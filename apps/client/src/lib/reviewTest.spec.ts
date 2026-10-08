import { describe, expect, it } from "vitest";
import { testIsCurrent } from "@/lib/reviewTest";

const tested = { source_version_id: "s1", target_version_id: "t1" };

describe("testIsCurrent", () => {
  it("holds while both branch heads are the ones the test ran", () => {
    expect(testIsCurrent(tested, { source_head_version_id: "s1", target_head_version_id: "t1" })).toBe(true);
  });

  it("lapses once either branch has a new commit, as the service's merge gate does", () => {
    expect(testIsCurrent(tested, { source_head_version_id: "s2", target_head_version_id: "t1" })).toBe(false);
    expect(testIsCurrent(tested, { source_head_version_id: "s1", target_head_version_id: "t2" })).toBe(false);
  });

  it("says nothing is current before the review has loaded", () => {
    expect(testIsCurrent(tested, null)).toBe(false);
  });
});
