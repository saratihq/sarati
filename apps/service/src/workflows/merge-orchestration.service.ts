import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';

import { DomainError } from '../common/domain-error';
import { WorkflowReviewEntity } from '../database/entities/review.entity';
import { WorkflowEntity } from '../database/entities/workflow.entity';
import { EventsService } from '../events/events.service';
import { now } from '../database/ids';
import type { ConflictEntry, MergeResolution } from '../ir/merge';
import { BranchService } from './branch.service';
import { lockWorkflowForWrite } from './workflow-row-lock';

/** Machine code for a merge whose target already has every change on the source. */
export const NOTHING_TO_MERGE = 'nothing_to_merge';

/** The branches-page merge entry point: merge, then delete the source branch + its tags. The reviews-page entry deliberately does NOT clean up. */
@Injectable()
export class MergeOrchestrationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly branches: BranchService,
    private readonly events: EventsService,
  ) {}

  async mergeAndCleanup(
    workflowId: string,
    sourceBranchName: string,
    targetBranchName: string,
    userId: string,
    resolutions?: MergeResolution[],
  ): Promise<Record<string, unknown>> {
    // One transaction, so the source stays locked from the merge until its cleanup commits.
    return this.dataSource.transaction(async (em) => {
      await lockWorkflowForWrite(em, workflowId);
      const pair = await this.branches.lockBranchPair(em, workflowId, sourceBranchName, targetBranchName);
      const result = await this.branches.mergeBranchIn(
        em,
        workflowId,
        sourceBranchName,
        targetBranchName,
        userId,
        resolutions,
      );

      if (!result.success) return conflictsResponse(result);

      // Refused before the cleanup below, which would otherwise delete a branch that merged nothing.
      if (result.mergedVersionId === null) {
        throw new DomainError(
          `'${sourceBranchName}' has no changes that '${targetBranchName}' doesn't already have — there is nothing to merge.`,
          409,
          { code: NOTHING_TO_MERGE },
        );
      }
      const merged = { status: 'merged', merged_version_id: result.mergedVersionId };

      // A resolved review keeps its source: `workflow_reviews.source_branch_id` is ON DELETE CASCADE.
      const resolvedReviewIds = await this.resolveHeldReviews(
        em,
        workflowId,
        result.reviews,
        result.mergedVersionId,
        userId,
      );
      if (resolvedReviewIds.length > 0) {
        return {
          ...merged,
          cleaned_up: null,
          reviews_resolved: resolvedReviewIds.map((id) => ({ review_id: id, status: 'merged' })),
        };
      }

      // A protected branch outlives its merge, as the default branch does: neither can be deleted.
      if (pair.source.isProtected || pair.source.isDefault) return { ...merged, cleaned_up: null };
      await this.branches.deleteBranchIn(em, workflowId, sourceBranchName, userId);

      return { ...merged, cleaned_up: { branch_deleted: sourceBranchName } };
    });
  }

  /**
   * Bring `fromBranch`'s changes into `branchName` — how a branch takes its target's newer work before merging
   * back, so conflicts are resolved on the branch, where a review and a test see the result. Never deletes a branch.
   */
  async updateFrom(
    workflowId: string,
    branchName: string,
    fromBranch: string,
    userId: string,
    resolutions?: MergeResolution[],
  ): Promise<Record<string, unknown>> {
    return this.dataSource.transaction(async (em) => {
      await lockWorkflowForWrite(em, workflowId);
      const target = (
        await this.branches.lockBranches(em, workflowId, { names: [fromBranch, branchName] })
      ).find((b) => b.name === branchName);
      if (target?.isProtected) {
        throw new DomainError(
          `Branch '${branchName}' is protected — it takes changes only through a review`,
          409,
          { code: 'branch_protected' },
        );
      }
      const result = await this.branches.mergeBranchIn(
        em,
        workflowId,
        fromBranch,
        branchName,
        userId,
        resolutions,
      );
      if (!result.success) return conflictsResponse(result);
      return result.mergedVersionId === null
        ? { status: 'up_to_date', merged_version_id: null }
        : { status: 'merged', merged_version_id: result.mergedVersionId };
    });
  }

  /** Mark merged the pair's reviews the merge has held since before its gate read them. */
  private async resolveHeldReviews(
    em: EntityManager,
    workflowId: string,
    reviews: WorkflowReviewEntity[],
    mergedVersionId: string,
    actorId: string,
  ): Promise<string[]> {
    if (reviews.length === 0) return [];

    const wf = await em.findOne(WorkflowEntity, { where: { id: workflowId } });
    for (const review of reviews) {
      review.status = 'merged';
      review.mergedVersionId = mergedVersionId;
      review.updatedAt = now();
      await em.save(WorkflowReviewEntity, review);
      await this.events.emit(em, {
        orgId: wf?.orgId ?? null,
        actorUserId: actorId,
        type: 'review.merged',
        subjectType: 'review',
        subjectId: review.id,
        payload: { merged_version_id: mergedVersionId, via: 'branch_merge' },
      });
    }
    return reviews.map((r) => r.id);
  }
}

function conflictsResponse(result: { conflicts: ConflictEntry[] }): Record<string, unknown> {
  return {
    status: 'conflicts',
    conflicts: result.conflicts.map((c) => ({
      node_id: c.node_id,
      node_name: c.node_name,
      kind: c.kind,
      field_path: c.field_path,
      deleted_on: c.deleted_on ?? null,
      source_value: c.source_value,
      target_value: c.target_value,
      ancestor_value: c.ancestor_value,
    })),
  };
}
