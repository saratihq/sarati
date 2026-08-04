import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { WorkflowReviewEntity } from '../database/entities/review.entity';
import { WorkflowBranchEntity } from '../database/entities/workflow-branch.entity';
import { WorkflowEntity } from '../database/entities/workflow.entity';
import { EventsService } from '../events/events.service';
import { now } from '../database/ids';
import type { MergeResolution } from '../ir/merge';
import { BranchService } from './branch.service';

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
    const result = await this.branches.mergeBranch(
      workflowId,
      sourceBranchName,
      targetBranchName,
      userId,
      resolutions,
    );

    if (!result.success) {
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

    // An active review for the same (source → target) pair must be resolved and the branch cleanup
    // SKIPPED: `workflow_reviews.source_branch_id` is ON DELETE CASCADE, so deleting the branch would
    // silently destroy the review with its comments and approvals.
    const resolvedReviewIds = await this.resolveActiveReviewsForMerge(
      workflowId,
      sourceBranchName,
      targetBranchName,
      result.mergedVersionId,
      userId,
    );
    if (resolvedReviewIds.length > 0) {
      return {
        status: 'merged',
        merged_version_id: result.mergedVersionId,
        cleaned_up: null,
        reviews_resolved: resolvedReviewIds.map((id) => ({ review_id: id, status: 'merged' })),
      };
    }

    await this.branches.deleteBranch(workflowId, sourceBranchName, userId);

    return {
      status: 'merged',
      merged_version_id: result.mergedVersionId,
      cleaned_up: { branch_deleted: sourceBranchName },
    };
  }

  /** Mark every non-terminal review for this (source → target) pair merged, under a row lock so it can't race a concurrent approve/merge. */
  private async resolveActiveReviewsForMerge(
    workflowId: string,
    sourceBranchName: string,
    targetBranchName: string,
    mergedVersionId: string | null,
    actorId: string,
  ): Promise<string[]> {
    return this.dataSource.transaction(async (em) => {
      const branches = await em.find(WorkflowBranchEntity, {
        where: { workflowId },
      });
      const source = branches.find((b) => b.name === sourceBranchName);
      const target = branches.find((b) => b.name === targetBranchName);
      if (!source || !target) return [];

      const reviews = await em
        .createQueryBuilder(WorkflowReviewEntity, 'r')
        .setLock('pessimistic_write')
        .where('r.workflow_id = :workflowId', { workflowId })
        .andWhere('r.source_branch_id = :sourceId', { sourceId: source.id })
        .andWhere('r.target_branch_id = :targetId', { targetId: target.id })
        .andWhere('r.status NOT IN (:...terminal)', { terminal: ['merged', 'closed'] })
        .getMany();
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
    });
  }
}
