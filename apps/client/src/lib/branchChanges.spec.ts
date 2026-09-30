import { describe, expect, it } from "vitest";
import type { WorkflowVersionSummary } from "@/api/client";
import { branchHasNothingNew } from "@/lib/branchChanges";

const version = (over: Partial<WorkflowVersionSummary>): WorkflowVersionSummary => ({
  id: "v",
  version_number: 1,
  workflow_json: {},
  ...over,
});

describe("branchHasNothingNew", () => {
  it("is true for a branch that holds only the main version it was cut from", () => {
    expect(branchHasNothingNew([version({ is_fork_point: true, fork_source_branch: "main" })])).toBe(true);
    expect(branchHasNothingNew([version({ is_fork_point: true, fork_source_branch: null })])).toBe(true);
  });

  it("is false once the branch has a commit of its own", () => {
    expect(
      branchHasNothingNew([
        version({ id: "own", is_fork_point: false }),
        version({ id: "fork", is_fork_point: true, fork_source_branch: "main" }),
      ]),
    ).toBe(false);
  });

  it("leaves a branch cut from another branch to the service, which may find changes main lacks", () => {
    expect(branchHasNothingNew([version({ is_fork_point: true, fork_source_branch: "feature" })])).toBe(false);
  });

  it("claims nothing before the versions have loaded", () => {
    expect(branchHasNothingNew([])).toBe(false);
  });
});
