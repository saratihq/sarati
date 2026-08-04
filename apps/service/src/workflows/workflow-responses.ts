import type { WorkflowVersionEntity } from '../database/entities/workflow-version.entity';

/** The ONE place version list/detail shapes are assembled — every field is always emitted (nulls included). */

export interface VersionResponseExtras {
  branchName?: string | null;
  tags?: string[];
  inactiveTags?: string[];
  isForkPoint?: boolean;
  forkSourceBranch?: string | null;
}

export function versionResponse(
  v: WorkflowVersionEntity,
  extras: VersionResponseExtras = {},
): Record<string, unknown> {
  return {
    id: v.id,
    version_number: v.versionNumber,
    workflow_json: v.workflowJson,
    workflow_ir: v.workflowIr, // canvas renders from the stored IR
    diff: v.diff,
    ir_diff: v.irDiff,
    commit_message: v.commitMessage,
    author: v.author,
    branch_name: extras.branchName ?? null,
    parent_id: v.parentId,
    created_at: v.createdAt?.toISOString() ?? null,
    tags: extras.tags ?? [],
    inactive_tags: extras.inactiveTags ?? [],
    is_fork_point: extras.isForkPoint ?? false,
    fork_source_branch: extras.forkSourceBranch ?? null,
  };
}
