import type { WorkflowVersionSummary } from "@/api/client";

/** True when a branch holds only the main version it was cut from — the service decides every other case. */
export function branchHasNothingNew(versions: WorkflowVersionSummary[]): boolean {
  return versions.length > 0 && versions.every((v) => v.is_fork_point && (v.fork_source_branch || "main") === "main");
}
